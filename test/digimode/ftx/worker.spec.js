// FT8 through the production DSP worker: the channel cut from the received band at the catalog's rate and offset,
// the slot clock from Date.now, the slot decoded a step at a time between blocks.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MeteorModule from '../../../wasm/meteor/pkg/meteor.js';
import { addWave, ampFor, FT8, gauss, T0, tonesOf } from './fixtures';
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

describe('FT8 through the production DSP worker', () => {
	it('decodes two stations on 14.074 MHz, 10 kHz above the centre at 48 kS/s', async () => {
		const rate = 48000;
		const dialOffset = 10000;
		const stations = [
			{ msg: 'CQ DL1XYZ JO62', hz: 900, snrDb: -8, dt: 0.1 },
			{ msg: 'DL1XYZ K1ABC -15', hz: 1900, snrDb: -12, dt: -0.2 },
		];
		const count = 22 * rate;
		const re = new Float64Array(count);
		const im = new Float64Array(count);
		// the noise of the 8 kHz channel (SIGMA per component) spread over 48 kHz
		const sigma = 0.05 * Math.sqrt(rate / 8000);
		for (const s of stations)
			addWave(FT8, tonesOf(FT8, s.msg), dialOffset + s.hz, ampFor(s.snrDb), rate, (0.5 + s.dt) * rate, false, re, im);
		const g = gauss(17);
		const input = new Int8Array(2 * count);
		for (let n = 0; n < count; n++) {
			input[2 * n] = Math.max(-127, Math.min(127, Math.round(60 * (re[n] + sigma * g()))));
			input[2 * n + 1] = Math.max(-127, Math.min(127, Math.round(60 * (im[n] + sigma * g()))));
		}
		const { messages, send } = await startWorker();
		const params = { freq: 14.074, mode: 'usb', bandwidth: 2700, enabled: false, digimode: 'ft8' };
		await send({ type: 'init', sampleRate: rate, centerFreq: 14.074 - dialOffset / 1e6, params });
		let fed = 0;
		vi.spyOn(Date, 'now').mockImplementation(() => (T0 + fed / rate) * 1000);
		const block = 2 * 4800;
		for (let i = 0, chunkId = 1; i < input.length; i += block, chunkId++) {
			const part = input.slice(i, i + block);
			fed += part.length / 2;
			await send({ type: 'process', params, chunk: part.buffer, chunkLen: part.length, floatIq: false, chunkId });
		}
		// the last records go out with the next message, at most 250 ms after them
		await new Promise((resolve) => setTimeout(resolve, 300));
		const tail = input.slice(0, block);
		await send({ type: 'process', params, chunk: tail.buffer, chunkLen: tail.length, floatIq: false, chunkId: input.length / block + 1 });
		const output = messages.filter((message) => message.type === 'digimode');
		expect(output.every(validDigimodeMessage)).toBe(true);
		const records = output.flatMap((message) => message.records);
		expect(records.map((r) => r.text.split(' Hz ')[1]).sort()).toEqual(stations.map((s) => s.msg).sort());
		expect(records.every((r) => r.mode === 'ft8')).toBe(true);
		for (const s of stations) {
			const r = records.find((x) => x.text.endsWith(s.msg));
			expect(Math.abs(Number(r.fields.find(([k]) => k === 'Audio frequency')[1].split(' ')[0]) - s.hz)).toBeLessThanOrEqual(2);
			expect(Math.abs(Number(r.fields.find(([k]) => k === 'DT')[1].split(' ')[0]) - s.dt)).toBeLessThan(0.15);
		}
		expect(output.at(-1).status).toMatchObject({ state: 'receiving', records: 2, locked: true });
	}, 60_000);
});
