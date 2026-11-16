import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MeteorModule from '../../../wasm/meteor/pkg/meteor.js';
import { ToneScene, toneSceneFm } from './fixtures';
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

describe('Tone signalling through the production DSP worker', () => {
	it('decodes CTCSS and DTMF on PMR446 channel 1, 56 kHz from the centre at 240 kS/s', async () => {
		const { messages, send } = await startWorker();
		const params = { freq: 446.00625, mode: 'nfm', bandwidth: 12500, enabled: false, digimode: 'tones' };
		await send({ type: 'init', sampleRate: 240000, centerFreq: 445.95, params });
		const scene = new ToneScene(16000, 11);
		scene.ctcss(100, 0.3, 3, 0.1);
		scene.dtmf('159#', 1, 0.1, 0.1, 0.5);
		scene.pad(8);
		const iq = toneSceneFm(scene, 240000, 56250 + 300, 15);
		const input = Int8Array.from(iq, (value) => Math.max(-127, Math.min(127, Math.round(value * 90))));
		let clock = performance.now();
		vi.spyOn(performance, 'now').mockImplementation(() => (clock += 300));
		for (let i = 0, chunkId = 1; i < input.length; i += 48000, chunkId++) {
			const block = input.slice(i, i + 48000);
			await send({ type: 'process', params, chunk: block.buffer, chunkLen: block.length, floatIq: false, chunkId });
		}
		const output = messages.filter((message) => message.type === 'digimode');
		expect(output.every(validDigimodeMessage)).toBe(true);
		expect(output.at(-1).status.state).toBe('receiving');
		expect(output.some((message) => message.status.message === 'CTCSS 100.0 Hz · DTMF 159#')).toBe(true);
		const records = output.flatMap((message) => message.records);
		expect(records.map((record) => [record.mode, record.text])).toEqual([
			['tones', 'DTMF 159#'],
			['tones', 'CTCSS 100.0 Hz'],
		]);
	}, 20_000);
});
