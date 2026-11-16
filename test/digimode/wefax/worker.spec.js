import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MeteorModule from '../../../wasm/meteor/pkg/meteor.js';
import { BAND_LEVELS, bandMeans, faxPlan, faxSignal } from './fixtures';
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

describe('Weather fax through the production DSP worker', () => {
	it('decodes a short chart from DWD Pinneberg 7880 kHz (dial 7878.1 kHz), 28 kHz from the centre at 240 kS/s', async () => {
		const { messages, send } = await startWorker();
		const params = { freq: 7.8781, mode: 'usb', bandwidth: 2700, enabled: false, digimode: 'wefax' };
		await send({ type: 'init', sampleRate: 240000, centerFreq: 7.85, params });
		const rows = 12;
		const plan = faxPlan({ ioc: 576, lpm: 120, startS: 2, phasing: 8, rows, stopS: 2, blackS: 0.5 });
		const iq = faxSignal(plan, { rate: 240000, offsetHz: 28100, mistuneHz: 30, snrDb: 20, seed: 3 });
		const input = Int8Array.from(iq, (value) => Math.max(-127, Math.min(127, Math.round(value * 30))));
		let clock = performance.now();
		vi.spyOn(performance, 'now').mockImplementation(() => (clock += 300));
		for (let i = 0, chunkId = 1; i < input.length; i += 48000, chunkId++) {
			const block = input.slice(i, i + 48000);
			await send({ type: 'process', params, chunk: block.buffer, chunkLen: block.length, floatIq: false, chunkId });
		}
		const output = messages.filter((message) => message.type === 'digimode');
		expect(output.every(validDigimodeMessage)).toBe(true);
		expect(output.at(-1).status).toMatchObject({ state: 'receiving', records: 1 });
		const records = output.flatMap((message) => message.records);
		expect(records.map((record) => [record.mode, record.text, record.damaged])).toEqual([
			['wefax', 'Weather fax chart, 13 lines (120 lpm, IOC 576)', false],
		]);
		// The picture as the app assembles it: one picture, 1809 px wide, the white line and the bands.
		const images = output.map((message) => message.image).filter(Boolean);
		expect(new Set(images.map((image) => image.picture)).size).toBe(1);
		expect(images.every((image) => image.width === 1809 && image.title === 'Weather fax 120 lpm, IOC 576')).toBe(true);
		const picture = [];
		for (const image of images)
			for (let r = image.from; r < image.to; r++)
				picture[r] = Uint8Array.from({ length: 1809 }, (_, x) => image.rgb[((r - image.from) * 1809 + x) * 3]);
		expect(picture).toHaveLength(rows + 1);
		expect(picture[0].filter((v) => v < 200).length).toBeLessThan(20);
		for (const row of picture.slice(1)) bandMeans(row, 1809).forEach((mean, b) => expect(Math.abs(mean - BAND_LEVELS[b])).toBeLessThan(10));
	}, 20_000);
});
