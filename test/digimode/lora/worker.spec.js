import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MeteorModule from '../../../wasm/meteor/pkg/meteor.js';
import { validDigimodeMessage } from '@/worker/decoders/digimode/validation';
import { streamSignal } from './phy';
import { MC_EVENTS, MeshScene, MT_EVENTS, MT_LINES, meshcoreEu, meshtasticLongFast, schedule } from './scene';

const binary = readFileSync(new URL('../../../wasm/dsp/pkg/browsdr_dsp_bg.wasm', import.meta.url));
vi.mock('/wasm/dsp/browsdr_dsp.js', async () => {
	const dsp = await vi.importActual('../../../wasm/dsp/pkg/browsdr_dsp.js');
	const wasm = dsp.initSync({ module: binary });
	return { ...dsp, default: async () => wasm };
});
const pkg = (file) => fileURLToPath(new URL(`../../../wasm/meteor/pkg/${file}`, import.meta.url));
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

async function startWorker() {
	vi.resetModules();
	const messages = [];
	vi.stubGlobal('self', { postMessage: (message) => messages.push(message) });
	const { provideMeteorFactory } = await import('@/worker/decoders/meteor-init');
	provideMeteorFactory((options) => MeteorModule({ ...options, locateFile: pkg }));
	await import('@/worker/dsp-worker');
	return { messages, send: (data) => self.onmessage({ data }) };
}

describe('LoRa mesh through the production DSP worker', () => {
	it('decodes Meshtastic LongFast on 869.525 MHz 300 kHz below the centre at 2 MS/s, ignoring MeshCore 93 kHz above', async () => {
		const { messages, send } = await startWorker();
		const params = { freq: 869.525, mode: 'nfm', bandwidth: 12500, enabled: false, digimode: 'meshtastic' };
		const rate = 2000000;
		await send({ type: 'init', sampleRate: rate, centerFreq: 869.825, params });
		const scene = new MeshScene(7);
		// OnAir's EU scene: LongFast 300 kHz below the radio's centre, MeshCore EU (869.618 MHz) 93 kHz above LongFast
		const mt = schedule(MT_EVENTS.slice(0, 3), {
			p: () => meshtasticLongFast(),
			bytes: (e, t) => scene.meshtastic(e, 0, t),
			radio: (e) => scene.radio(`mt${e.node}`, 4),
			cfoHz: -300000 + 1800,
			scene,
		});
		const mc = schedule(MC_EVENTS.slice(0, 1), {
			p: () => meshcoreEu(8, 8),
			bytes: (e, t) => scene.meshcore(e, t),
			radio: () => ({ snrDb: 8, freqHz: -300000 + 93000 }),
			startSec: mt[0].endSec + 0.05,
			scene,
		});
		let clock = performance.now();
		vi.spyOn(performance, 'now').mockImplementation(() => (clock += 300));
		let chunkId = 1;
		const chunks = [];
		streamSignal([...mt, ...mc], (iq) => chunks.push(Int8Array.from(iq, (v) => Math.max(-127, Math.min(127, Math.round(v * 60))))), {
			rate,
			bwHz: 250000,
			noiseRms: 0.1,
			chunk: 65536,
			tailSec: 0.4,
		});
		for (const block of chunks)
			await send({ type: 'process', params, chunk: block.buffer, chunkLen: block.length, floatIq: false, chunkId: chunkId++ });
		const output = messages.filter((message) => message.type === 'digimode');
		expect(output.every(validDigimodeMessage)).toBe(true);
		expect(output.at(-1).status.state).toBe('receiving');
		const records = output.flatMap((message) => message.records);
		expect(records.map((r) => [r.mode, r.damaged])).toEqual([
			['meshtastic', false],
			['meshtastic', false],
			['meshtastic', false],
		]);
		expect(records[0].text).toMatch(/^![0-9a-f]{8} → \^all · NODEINFO_APP · Dubai Marina Base \(DMB1\), TBEAM, CLIENT$/);
		expect(records[1].text).toContain(`TEXT_MESSAGE_APP · ${MT_LINES[0]}`);
		expect(output.at(-1).status.message).toMatch(/^3 packet\(s\), last ![0-9a-f]{8} NODEINFO_APP$/);
	}, 60_000);
});
