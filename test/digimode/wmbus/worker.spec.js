import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MeteorModule from '../../../wasm/meteor/pkg/meteor.js';
import { meterBurst, wmbusSignal } from './fixtures';
import { validDigimodeMessage } from '@/worker/decoders/digimode/validation';

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

describe('Wireless M-Bus through the production DSP worker', () => {
	it('decodes T1 and C1 telegrams on 868.95 MHz 150 kHz from the centre at 2.4 MS/s', async () => {
		const { messages, send } = await startWorker();
		const params = { freq: 868.95, mode: 'nfm', bandwidth: 12500, enabled: false, digimode: 'wmbus' };
		await send({ type: 'init', sampleRate: 2400000, centerFreq: 868.8, params });
		const bursts = [meterBurst(1, 7), meterBurst(3, 8), meterBurst(4, 9)];
		const iq = wmbusSignal(bursts, { rate: 2400000, offsetHz: 150000 - 3500, noiseLevel: 0.8, seed: 4 });
		const input = Int8Array.from(iq, (value) => Math.max(-127, Math.min(127, Math.round(value * 80))));
		let clock = performance.now();
		vi.spyOn(performance, 'now').mockImplementation(() => (clock += 300));
		for (let i = 0, chunkId = 1; i < input.length; i += 96000, chunkId++) {
			const block = input.slice(i, i + 96000);
			await send({ type: 'process', params, chunk: block.buffer, chunkLen: block.length, floatIq: false, chunkId });
		}
		const output = messages.filter((message) => message.type === 'digimode');
		expect(output.every(validDigimodeMessage)).toBe(true);
		expect(output.at(-1).status.state).toBe('receiving');
		const records = output.flatMap((message) => message.records);
		expect(records.map((record) => [record.mode, record.damaged, record.text.split(' · ').slice(0, 2).join(' · ')])).toEqual([
			['wmbus', undefined, 'ELV heat (outlet) 40112233 · T1'],
			['wmbus', undefined, 'GWF gas 61000042 · C1 (A)'],
			['wmbus', undefined, 'SEN cold water 72004711 · C1 (B)'],
		]);
		expect(output.at(-1).status.message).toBe('3 telegram(s), last C1 (B) SEN 72004711');
	}, 20_000);
});
