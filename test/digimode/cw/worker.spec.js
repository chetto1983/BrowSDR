// CW through the production DSP worker: the 24 kHz channel cut from the received band around the dial, two signals of
// the skimmer's window at once.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MeteorModule from '../../../wasm/meteor/pkg/meteor.js';
import { cwBand, cwSig } from './fixtures';
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

describe('CW through the production DSP worker', () => {
	it('decodes two CW signals around 14.020 MHz, 10 kHz above the centre at 96 kS/s', async () => {
		const rate = 96000;
		const dialOffset = 10000;
		const signals = [cwSig(-1200, 20, 'CQ CQ DE LY2ABC LY2ABC K', 15), cwSig(2400, 28, 'TEST DL1XYZ DL1XYZ TEST', 14, { startSec: 1.1 })];
		// the noise of the 24 kHz channel (0.02 per component) spread over 96 kHz
		const iq = cwBand(40, signals, { rate, dialOffsetHz: dialOffset, noiseSigma: 0.02 * Math.sqrt(rate / 24000), seed: 4 });
		const input = Int8Array.from(iq, (v) => Math.max(-127, Math.min(127, Math.round(400 * v))));
		const { messages, send } = await startWorker();
		const params = { freq: 14.02, mode: 'cw', bandwidth: 500, enabled: false, digimode: 'cw' };
		await send({ type: 'init', sampleRate: rate, centerFreq: 14.02 - dialOffset / 1e6, params });
		const block = 2 * 9600;
		for (let i = 0, chunkId = 1; i < input.length; i += block, chunkId++) {
			const part = input.slice(i, i + block);
			await send({ type: 'process', params, chunk: part.buffer, chunkLen: part.length, floatIq: false, chunkId });
		}
		// quiet seconds end the lines; the last records go out with the next message
		const quiet = new Int8Array(block);
		const next = input.length / block + 1;
		for (let k = 0; k < 40; k++)
			await send({ type: 'process', params, chunk: quiet.slice().buffer, chunkLen: block, floatIq: false, chunkId: next + k });
		await new Promise((resolve) => setTimeout(resolve, 300));
		await send({ type: 'process', params, chunk: quiet.slice().buffer, chunkLen: block, floatIq: false, chunkId: next + 40 });
		const output = messages.filter((message) => message.type === 'digimode');
		expect(output.every(validDigimodeMessage)).toBe(true);
		const records = output.flatMap((message) => message.records);
		expect(records.every((r) => r.mode === 'cw')).toBe(true);
		const offset = (r) => Number(r.text.split(' Hz: ')[0].replace('−', '-'));
		const near = (hz) =>
			records
				.filter((r) => Math.abs(offset(r) - hz) <= 20)
				.map((r) => r.text.split(' Hz: ')[1])
				.join(' ');
		expect(near(-1200)).toContain('CQ CQ DE LY2ABC LY2ABC K');
		expect(near(2400)).toContain('TEST DL1XYZ DL1XYZ TEST');
		expect(output.some((m) => m.status.locked && m.status.message.startsWith('CW: '))).toBe(true);
	}, 60_000);
});
