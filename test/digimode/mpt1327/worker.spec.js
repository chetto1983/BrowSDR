// MPT 1327 through the production DSP worker: the 16 kHz NFM channel cut 50 kHz above the centre of a 240 kS/s band,
// with a carrier 600 Hz off and noise.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MeteorModule from '../../../wasm/meteor/pkg/meteor.js';
import { controlChannelBits, ffskAudio, fmModulate, makeAhy, makeBcastChannel, makeGtc } from './fixtures';
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

describe('MPT 1327 through the production DSP worker', () => {
	it('lists the calls of a control channel 50 kHz from the centre at 240 kS/s', async () => {
		const rate = 240000;
		const sent = [makeGtc(5, 1234, 0, 17, 2003), makeBcastChannel(0, 20001, 3), makeAhy(9, 100, 0, 77 << 5), makeGtc(7, 88, 1, 900, 9)];
		const audio = ffskAudio(controlChannelBits(20001, sent), rate, false, 0.5);
		const all = new Float32Array(rate + audio.length);
		all.set(audio, rate / 2);
		const iq = fmModulate(all, rate, 3000, 50000 + 600, { sigma: 0.3, seed: 2 });
		const input = Int8Array.from(iq, (v) => Math.max(-127, Math.min(127, Math.round(v * 60))));
		const { messages, send } = await startWorker();
		const params = { freq: 170.05, mode: 'nfm', bandwidth: 12500, enabled: false, digimode: 'mpt1327' };
		await send({ type: 'init', sampleRate: rate, centerFreq: 170.0, params });
		let clock = performance.now();
		vi.spyOn(performance, 'now').mockImplementation(() => (clock += 300));
		for (let i = 0, chunkId = 1; i < input.length; i += 48000, chunkId++) {
			const block = input.slice(i, i + 48000);
			await send({ type: 'process', params, chunk: block.buffer, chunkLen: block.length, floatIq: false, chunkId });
		}
		const output = messages.filter((message) => message.type === 'digimode');
		expect(output.every(validDigimodeMessage)).toBe(true);
		const records = output.flatMap((message) => message.records);
		expect(records.map((r) => [r.mode, r.text])).toEqual([
			['mpt1327', 'Call ident 2003 → 5/1234 · traffic channel 17 · speech'],
			['mpt1327', 'BCAST · control channel announced, system 20001, control channel 3'],
			['mpt1327', 'AHY 9/100 ← ident 77 · availability check of the called unit, speech'],
			['mpt1327', 'Call ident 9 → 7/88 · traffic channel 900 · data'],
		]);
		expect(output.at(-1).status).toMatchObject({ state: 'receiving', records: 4, locked: true });
		expect(output.at(-1).status.message).toBe('System 20001 · 4 messages · 2 calls');
	}, 30_000);
});
