// FLARM, OGN and ADS-L through the production DSP worker: the 400 kS/s channel cut at 868.3 MHz from a 2.4 MS/s band
// centred 300 kHz lower, the FLARM key time from Date.now and the station location from the VFO parameters.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MeteorModule from '../../../wasm/meteor/pkg/meteor.js';
import { adslAircraft, adslBurst, adslTrafficNet, field, flarmBursts, mk, REF_LAT, REF_LON, scene, twice, U0 } from './fixtures';
import { ognPacket, ognScene } from './ogn-fixtures';
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

describe('FLARM, OGN and ADS-L through the production DSP worker', () => {
	it('lists a FLARM glider, an OGN tracker and an ADS-L aircraft from a 2.4 MS/s band', async () => {
		const rate = 2400000;
		const centre = 868.0e6;
		const bursts = [
			...flarmBursts(twice([mk(0.2, 0, 0xdd1234, 1500, -2000)])),
			adslBurst(1.0, 1, adslTrafficNet(adslAircraft(0x4a1b2c, 7, 54.75, 25.4))),
		];
		const iq = scene(rate, 3.2, bursts, 22, { centreHz: centre, seed: 3 });
		const ogn = ognScene(rate, 868.4e6 - centre, [ognPacket(0x0123ab, 6, 54.65, 25.2, 1100)], { amp: 0.5 });
		for (let i = 0; i < ogn.length && i < iq.length; i++) iq[i + Math.floor(1.5 * rate) * 2] += ogn[i];
		const input = Int8Array.from(iq, (v) => Math.max(-127, Math.min(127, Math.round(v * 40))));
		const { messages, send } = await startWorker();
		const params = {
			freq: 868.3,
			mode: 'nfm',
			bandwidth: 12500,
			enabled: false,
			digimode: 'flarm',
			digimodeStation: { lat: REF_LAT, lon: REF_LON },
		};
		await send({ type: 'init', sampleRate: rate, centerFreq: centre / 1e6, params });
		let fed = 0;
		vi.spyOn(Date, 'now').mockImplementation(() => (U0 + fed / rate) * 1000);
		let clock = performance.now();
		vi.spyOn(performance, 'now').mockImplementation(() => (clock += 300));
		const block = 2 * 120000;
		for (let i = 0, chunkId = 1; i < input.length; i += block, chunkId++) {
			const part = input.slice(i, i + block);
			fed += part.length / 2;
			await send({ type: 'process', params, chunk: part.buffer, chunkLen: part.length, floatIq: false, chunkId });
		}
		const output = messages.filter((message) => message.type === 'digimode');
		expect(output.every(validDigimodeMessage)).toBe(true);
		const records = output.flatMap((message) => message.records);
		// ADS-L at 1.0 s, OGN at 1.5 s, FLARM once its second packet (2.6 s) agrees with the first
		expect(records.map((r) => [r.mode, r.text.split(' · ').slice(0, 2).join(' · ')])).toEqual([
			['flarm', 'ADS-L 4A1B2C · paraglider'],
			['flarm', 'OGN 0123AB · hang glider'],
			['flarm', 'FLARM DD1234 · glider'],
		]);
		expect(Math.abs(parseFloat(field(records[2], 'Distance')) - 2.5)).toBeLessThan(0.2);
		expect([field(records[0], 'Channel'), field(records[1], 'Channel'), field(records[1], 'Altitude')]).toEqual([
			'868.4 MHz',
			'868.4 MHz',
			'1100 m',
		]);
		expect(output.at(-1).status).toMatchObject({ state: 'receiving', locked: true });
		expect(output.at(-1).status.message).toMatch(/^3 aircraft · FLARM 2, OGN 1, ADS-L 1 packets/);
	}, 60_000);
});
