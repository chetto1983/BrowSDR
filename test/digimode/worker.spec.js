import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MeteorModule from '../../wasm/meteor/pkg/meteor.js';
import { validDigimodeMessage } from '@/worker/decoders/digimode/validation';
import { dscBuildDistress, dscFrameBits } from '@/worker/decoders/digimode/dsc/symbols';
import { vhfDscSignal } from './fixtures';
import { navtexBits, navtexSignal } from './marine-fixtures';
import { avlcFrame, controlI } from '@/worker/decoders/digimode/vdl2/avlc';
import { vdl2AcarsInfo, vdl2Signal } from './vdl2-fixtures';
import { signal as orbcommSignal } from './orbcomm/fixtures';

const binary = readFileSync(new URL('../../wasm/dsp/pkg/browsdr_dsp_bg.wasm', import.meta.url));
vi.mock('/wasm/dsp/browsdr_dsp.js', async () => {
	const dsp = await vi.importActual('../../wasm/dsp/pkg/browsdr_dsp.js');
	const wasm = dsp.initSync({ module: binary });
	return { ...dsp, default: async () => wasm };
});
const pkg = (file) => fileURLToPath(new URL(`../../wasm/meteor/pkg/${file}`, import.meta.url));
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

const digimodeMessages = (messages) => messages.filter((message) => message.type === 'digimode');

describe('Digital Modes through the production DSP worker', () => {
	it('decodes an ORBCOMM satellite through the 240 kS/s IQ and VFO path', async () => {
		const { messages, send } = await startWorker();
		const params = { freq: 137.2875, mode: 'nfm', bandwidth: 16000, enabled: false, digimode: 'orbcomm' };
		await send({ type: 'init', sampleRate: 240000, centerFreq: 137.2625, params });
		const iq = orbcommSignal({ seconds: 2.5, rate: 240000, offsetHz: 26200, satellite: 23 });
		const input = Int8Array.from(iq, (value) => Math.max(-127, Math.min(127, Math.round(value * 60))));
		let clock = performance.now();
		vi.spyOn(performance, 'now').mockImplementation(() => (clock += 300));
		for (let i = 0, chunkId = 1; i < input.length; i += 48000, chunkId++) {
			const block = input.slice(i, i + 48000);
			await send({ type: 'process', params, chunk: block.buffer, chunkLen: block.length, floatIq: false, chunkId });
		}
		const output = digimodeMessages(messages);
		expect(output.every(validDigimodeMessage)).toBe(true);
		expect(output.some((message) => message.status?.message.includes('137.2875 MHz'))).toBe(true);
		const records = output.flatMap((message) => message.records);
		expect(records.some((record) => record.text.includes('Message fragment 1/2'))).toBe(true);
		expect(records.some((record) => record.text.includes('Downlink info 1/3'))).toBe(true);
	}, 20_000);
	it('decodes a channel 70 distress alert 50 kHz from the centre at 240 kS/s', async () => {
		const { messages, send } = await startWorker();
		const params = { freq: 156.525, mode: 'nfm', bandwidth: 12500, enabled: false, digimode: 'dsc-vhf' };
		await send({ type: 'init', sampleRate: 240000, centerFreq: 156.475, params });
		const bits = dscFrameBits(dscBuildDistress('247123450', 101, 43.7, 10.3, 21, 15, 100), 127, 200);
		const iq = vhfDscSignal(bits, { rate: 240000, offsetHz: 50000 + 700, noiseLevel: 0.3 });
		const input = Int8Array.from(iq, (value) => Math.max(-127, Math.min(127, Math.round(value * 90))));
		let clock = performance.now();
		vi.spyOn(performance, 'now').mockImplementation(() => (clock += 300));
		for (let i = 0, chunkId = 1; i < input.length; i += 48000, chunkId++) {
			const block = input.slice(i, i + 48000);
			await send({ type: 'process', params, chunk: block.buffer, chunkLen: block.length, floatIq: false, chunkId });
		}
		const output = digimodeMessages(messages);
		expect(output.every(validDigimodeMessage)).toBe(true);
		expect(output.at(-1).status.state).toBe('receiving');
		const records = output.flatMap((message) => message.records);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ mode: 'dsc-vhf', alert: true, damaged: false });
		expect(records[0].text).toBe("Distress alert: 247123450 → all stations - Flooding at 43°42'N 010°18'E");
	}, 20_000);
	it('decodes NAVTEX on 518 kHz 18 kHz from the centre at 240 kS/s', async () => {
		const { messages, send } = await startWorker();
		const params = { freq: 0.518, mode: 'usb', bandwidth: 2400, enabled: false, digimode: 'navtex' };
		await send({ type: 'init', sampleRate: 240000, centerFreq: 0.5, params });
		const bits = navtexBits('ZCZC GA01\nWIND SW 5 TO 6.\nNNNN\n', { idle: 24 });
		const iq = navtexSignal(bits, { rate: 240000, offsetHz: 18000 - 70, noiseLevel: 0.3, lead: 0.5 });
		const input = Int8Array.from(iq, (value) => Math.max(-127, Math.min(127, Math.round(value * 90))));
		let clock = performance.now();
		vi.spyOn(performance, 'now').mockImplementation(() => (clock += 300));
		for (let i = 0, chunkId = 1; i < input.length; i += 48000, chunkId++) {
			const block = input.slice(i, i + 48000);
			await send({ type: 'process', params, chunk: block.buffer, chunkLen: block.length, floatIq: false, chunkId });
		}
		const output = digimodeMessages(messages);
		expect(output.every(validDigimodeMessage)).toBe(true);
		const records = output.flatMap((message) => message.records);
		expect(records.map((record) => record.text)).toEqual(['NAVTEX G Navigational warning 01: WIND SW 5 TO 6.']);
	}, 20_000);
	it('decodes a VDL2 ACARS burst on 136.975 MHz 25 kHz from the centre at 240 kS/s', async () => {
		const { messages, send } = await startWorker();
		const params = { freq: 136.975, mode: 'nfm', bandwidth: 12500, enabled: false, digimode: 'vdl2' };
		await send({ type: 'init', sampleRate: 240000, centerFreq: 136.95, params });
		const gs = { addr: 0x10a000, type: 4, status: false };
		const aircraft = { addr: 0x4a1234, type: 1, status: false };
		const info = vdl2AcarsInfo('G-EUUA', 'H1', '3', 'M07ABA0117#DFB/FUEL 145/ETA 1230');
		const iq = vdl2Signal([{ frames: [avlcFrame(gs, aircraft, controlI(2, 1, false), info)] }], {
			rate: 240000,
			offsetHz: 25000 + 300,
			snrDb: 25,
			leadSec: 0.3,
		});
		const input = Int8Array.from(iq, (value) => Math.max(-127, Math.min(127, Math.round(value * 800))));
		let clock = performance.now();
		vi.spyOn(performance, 'now').mockImplementation(() => (clock += 300));
		for (let i = 0, chunkId = 1; i < input.length; i += 48000, chunkId++) {
			const block = input.slice(i, i + 48000);
			await send({ type: 'process', params, chunk: block.buffer, chunkLen: block.length, floatIq: false, chunkId });
		}
		const output = digimodeMessages(messages);
		expect(output.every(validDigimodeMessage)).toBe(true);
		const records = output.flatMap((message) => message.records);
		expect(records.map((record) => record.text)).toEqual([
			'4A1234 (G-EUUA) → GS 10A000 · I · ACARS H1 (Terminal message) BA0117: #DFB/FUEL 145/ETA 1230',
		]);
		expect(records[0]).toMatchObject({ mode: 'vdl2', damaged: false });
	}, 20_000);
	it('reports a channel that does not fit the received band', async () => {
		const { messages, send } = await startWorker();
		const params = { freq: 156.525, mode: 'nfm', bandwidth: 12500, enabled: false, digimode: 'dsc-vhf' };
		await send({ type: 'init', sampleRate: 240000, centerFreq: 155, params });
		const block = new Int8Array(4800);
		await send({ type: 'process', params, chunk: block.buffer, chunkLen: block.length, floatIq: false, chunkId: 1 });
		expect(digimodeMessages(messages).at(-1).status).toMatchObject({ state: 'error' });
	});
});
