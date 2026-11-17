import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MeteorModule from '../../../wasm/meteor/pkg/meteor.js';
import { validMeteorMessage } from '@/worker/decoders/meteor/validation';
import { qpskSignal } from './fixtures';

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
	// After resetModules the worker gets a fresh loader module: hand it the Node factory again.
	const { provideMeteorFactory } = await import('@/worker/decoders/meteor-init');
	provideMeteorFactory((options) => MeteorModule({ ...options, locateFile: pkg }));
	await import('@/worker/dsp-worker');
	return { messages, send: (data) => self.onmessage({ data }) };
}

async function feed(send, params, input, chunk = 57600) {
	let clock = performance.now();
	vi.spyOn(performance, 'now').mockImplementation(() => (clock += 600));
	for (let i = 0, chunkId = 1; i < input.length; i += chunk, chunkId++) {
		const block = input.slice(i, i + chunk);
		await send({ type: 'process', params, chunk: block.buffer, chunkLen: block.length, floatIq: false, chunkId });
	}
}

const meteorMessages = (messages) => messages.filter((message) => message.type === 'meteor');

describe('Meteor LRPT through the production DSP worker', () => {
	it('channelizes an offset OQPSK downlink at 288 kS/s and locks', async () => {
		const { messages, send } = await startWorker();
		const params = { freq: 137.9, mode: 'nfm', bandwidth: 150000, enabled: false, meteor: true };
		await send({ type: 'init', sampleRate: 288000, centerFreq: 137.85, params });
		const { iq } = qpskSignal(72000 * 1.5, { rate: 288000, offsetHz: 50000 + 900, snrDb: 20, oqpsk: true });
		await feed(
			send,
			params,
			Int8Array.from(iq, (value) => Math.round(value * 127)),
		);
		const last = meteorMessages(messages).at(-1);
		expect(last.status.state).toBe('receiving');
		expect(last.status.locked).toBe(true);
		expect(Math.abs(last.status.freqOffsetHz - 900)).toBeLessThan(150);
		expect(meteorMessages(messages).every(validMeteorMessage)).toBe(true);
	}, 20_000); // seconds of signal through the real worker: slow when the whole suite runs in parallel
	it('keeps receiving and relocks after a gap in the input', async () => {
		const { messages, send } = await startWorker();
		const params = { freq: 137.9, mode: 'nfm', bandwidth: 150000, enabled: false, meteor: true };
		await send({ type: 'init', sampleRate: 288000, centerFreq: 137.85, params });
		const { iq } = qpskSignal(72000 * 2, { rate: 288000, offsetHz: 50000 - 700, snrDb: 20, seed: 4, oqpsk: true });
		const input = Int8Array.from(iq, (value) => Math.round(value * 127));
		const half = input.length / 2;
		await feed(send, params, input.subarray(0, half));
		let clock = performance.now() + 1e6;
		vi.spyOn(performance, 'now').mockImplementation(() => (clock += 600));
		// Chunk ids jump: the stream must treat it as a gap (Wi-Fi drop, brownout), not an error.
		for (let i = half, chunkId = 1000; i < input.length; i += 57600, chunkId++) {
			const block = input.slice(i, i + 57600);
			await send({ type: 'process', params, chunk: block.buffer, chunkLen: block.length, floatIq: false, chunkId });
		}
		const last = meteorMessages(messages).at(-1);
		expect(last.status.state).toBe('receiving');
		expect(last.status.locked).toBe(true);
		expect(Math.abs(last.status.freqOffsetHz + 700)).toBeLessThan(150);
	}, 20_000); // seconds of signal through the real worker: slow when the whole suite runs in parallel
	it('refuses a VFO outside the Meteor band', async () => {
		const { messages, send } = await startWorker();
		const params = { freq: 136.5, mode: 'nfm', bandwidth: 150000, enabled: false, meteor: true };
		await send({ type: 'init', sampleRate: 1024000, centerFreq: 136.6, params });
		await feed(send, params, new Int8Array(20000));
		const last = meteorMessages(messages).at(-1);
		expect(last.status.state).toBe('error');
		expect(last.status.message).toBe('Tune this VFO to a Meteor LRPT downlink (137.0-138.0 MHz).');
	});
	it('refuses a channel that does not fit in the received band', async () => {
		const { messages, send } = await startWorker();
		const params = { freq: 137.9, mode: 'nfm', bandwidth: 150000, enabled: false, meteor: true };
		await send({ type: 'init', sampleRate: 250000, centerFreq: 137.0, params });
		await feed(send, params, new Int8Array(20000));
		const last = meteorMessages(messages).at(-1);
		expect(last.status.state).toBe('error');
		expect(last.status.message).toBe(
			'Meteor LRPT needs a 150 kHz channel inside the received band. Move the center frequency closer to 137.9 MHz.',
		);
	});
	it('validates image row messages', () => {
		const status = {
			state: 'receiving',
			message: 'x',
			locked: true,
			quality: 1,
			freqOffsetHz: 0,
			rs: 0,
			vit: 900,
			mpdus: 3,
			rows: 8,
			apids: [66, 65, 64],
		};
		const rows = { from: 0, to: 8, width: 1568, channels: [0, 1, 2].map(() => new Uint8Array(8 * 1568)) };
		expect(validMeteorMessage({ type: 'meteor', freq: 137.9, status, rows })).toBe(true);
		expect(
			validMeteorMessage({ type: 'meteor', freq: 137.9, status, rows: { ...rows, timeBlocks: [{ row: 0, timeMs: 1794840930965 }] } }),
		).toBe(true);
		expect(validMeteorMessage({ type: 'meteor', freq: 137.9, status, rows: { ...rows, timeBlocks: [{ row: 0, timeMs: Infinity }] } })).toBe(
			false,
		);
		expect(validMeteorMessage({ type: 'meteor', freq: 137.9, status, rows: { ...rows, to: -1 } })).toBe(false);
		expect(validMeteorMessage({ type: 'meteor', freq: 137.9, status, rows: { ...rows, channels: rows.channels.slice(0, 2) } })).toBe(false);
	});
});
