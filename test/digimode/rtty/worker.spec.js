// RTTY through the production DSP worker: the 8 kHz channel cut from the received band at the catalog's rate and
// offset, Auto spread over the blocks by its time budget.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MeteorModule from '../../../wasm/meteor/pkg/meteor.js';
import { addNoise, rttySigma, rttySignal, RTTY_TEST_TEXT } from './fixtures';
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

describe('RTTY through the production DSP worker', () => {
	it('decodes amateur RTTY on 14.080 MHz, 10 kHz above the centre at 96 kS/s', async () => {
		const rate = 96000;
		const dialOffset = 10000;
		// 45.45 Bd, 170 Hz, the mark on top: tones 1500 / 1670 Hz above the dial; 12 dB in 3 kHz
		const iq = rttySignal(32, { reverse: true, lowHz: 1500, rate, complex: true, offsetHz: dialOffset });
		addNoise(iq, rttySigma(12) * Math.sqrt(rate / 8000), 4);
		const input = Int8Array.from(iq, (v) => Math.max(-127, Math.min(127, Math.round(60 * v))));
		const { messages, send } = await startWorker();
		const params = { freq: 14.08, mode: 'usb', bandwidth: 2700, enabled: false, digimode: 'rtty' };
		await send({ type: 'init', sampleRate: rate, centerFreq: 14.08 - dialOffset / 1e6, params });
		const block = 2 * 9600;
		for (let i = 0, chunkId = 1; i < input.length; i += block, chunkId++) {
			const part = input.slice(i, i + block);
			await send({ type: 'process', params, chunk: part.buffer, chunkLen: part.length, floatIq: false, chunkId });
		}
		await new Promise((resolve) => setTimeout(resolve, 300));
		const tail = new Int8Array(block);
		await send({ type: 'process', params, chunk: tail.buffer, chunkLen: tail.length, floatIq: false, chunkId: input.length / block + 1 });
		const output = messages.filter((message) => message.type === 'digimode');
		expect(output.every(validDigimodeMessage)).toBe(true);
		const records = output.flatMap((message) => message.records);
		expect(records.every((r) => r.mode === 'rtty')).toBe(true);
		expect(records.filter((r) => r.text === RTTY_TEST_TEXT.trim()).length).toBeGreaterThanOrEqual(2);
		// the messages go out at most every 250 ms of wall clock: whichever were sent, the locked ones show the tones
		const marks = output.filter((m) => m.status.locked).map((m) => Number(/mark (\d+) Hz/.exec(m.status.message)?.[1]));
		expect(marks.length).toBeGreaterThan(0);
		expect(marks.every((hz) => Math.abs(hz - 1670) <= 6)).toBe(true);
	}, 60_000);
});
