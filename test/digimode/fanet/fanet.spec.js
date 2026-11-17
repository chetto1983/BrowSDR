// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir tests/avroad/test_avroad_air.cpp (testFanet: one tracking frame
// at carrier offsets of -30, 0 and +25 kHz and clock errors of +-30 ppm; the 500 kHz zone; the SNR sweep in 250 kHz,
// all frames down to -4 dB; three frames in a row; noise alone), https://github.com/adswill/OnAir; see
// third_party/onair. Format facts as credited there: the FANET protocol description (protocol.txt of Skytraxx's
// fanet-stm32). Changes: through BrowSDR's FanetDecoder on its VFO channel (OnAir: the receiver at 1 MS/s); the frames
// are in noise at 0 dB unless the sweep says otherwise; added the records (pace, privacy, distance, the other frame
// types), the 125 kHz zones, chunk sizes and the decode time.

import { describe, expect, it } from 'vitest';
import { FANET_125, FANET_250, FANET_500 } from '@/worker/decoders/digimode/fanet';
import {
	fanetFrames,
	fanetGround,
	fanetLandmark,
	fanetMessage,
	fanetName,
	fanetThermal,
	fanetTrack,
	fanetWeather,
	field,
	runFanet,
} from './fixtures';

const STATION = { lat: 46.45, lon: 7.85 };
const cpu = (r, what) =>
	console.log(
		`${what}: ${r.seconds.toFixed(2)} s of signal in ${r.ms.toFixed(0)} ms (${((r.ms / r.seconds) * 0.1).toFixed(1)} % of a core)`,
	);

describe('FANET receiver (OnAir testFanet)', () => {
	it('decodes a tracking frame at carrier offsets and clock errors', () => {
		for (const freqHz of [-30000, 0, 25000])
			for (const sroPpm of [-30, 30]) {
				const r = runFanet(fanetFrames([fanetTrack(1, 77, 54.0, 25.0, 900)], { freqHz, sroPpm }));
				expect(
					r.records.map((x) => x.text.split(' · ').slice(0, 3).join(' · ')),
					`${freqHz} Hz ${sroPpm} ppm`,
				).toEqual(['FANET 01:004D · paraglider · 54.00000, 25.00000']);
				expect(r.decoder.stats).toMatchObject({ frames: 1, crcBad: 0, invalid: 0 });
			}
	}, 60_000);
	it('decodes the 500 kHz zone (920.8 MHz) and the 125 kHz zones', () => {
		for (const band of [FANET_500, FANET_125]) {
			const r = runFanet(fanetFrames([fanetTrack(1, 88, 40.0, -100.0, 900)], { bwHz: band.bwHz, freqHz: 3000, snrDb: -2 }), { band });
			cpu(r, `FANET ${band.bwHz / 1000} kHz`);
			expect(r.records.map((x) => x.text.split(' · ').slice(0, 2).join(' · '))).toEqual(['FANET 01:0058 · paraglider']);
			expect(field(r.records[0], 'Bandwidth')).toBe(`${band.bwHz / 1000} kHz`);
		}
	}, 60_000);
	it('decodes every frame down to -4 dB in 250 kHz', () => {
		const got = [];
		for (const snrDb of [10, 0, -4, -8, -12]) {
			let n = 0;
			for (let seed = 1; seed <= 5; seed++)
				n += runFanet(fanetFrames([fanetTrack(1, 77, 54.0, 25.0, 900)], { snrDb, freqHz: 2000 }), { seed }).records.length;
			got.push(`${snrDb} dB ${n}/5`);
			if (snrDb >= -4) expect(n, `${snrDb} dB`).toBe(5);
		}
		console.log(`FANET SNR in 250 kHz: ${got.join(', ')}`);
	}, 120_000);
	it('decodes three aircraft in a row and nothing from noise alone', () => {
		const three = runFanet(fanetFrames([1, 2, 3].map((dev) => fanetTrack(1, dev, 54, 25, 400 + 100 * dev))));
		expect(three.records.map((r) => field(r, 'Aircraft ID'))).toEqual(['01:0001', '01:0002', '01:0003']);
		expect(three.records.map((r) => field(r, 'Altitude'))).toEqual(['500 m', '600 m', '700 m']);
		for (const band of [FANET_250, FANET_500, FANET_125]) {
			const noise = runFanet([], { band, durationSec: 4, seed: 9 });
			cpu(noise, `FANET ${band.bwHz / 1000} kHz, noise alone`);
			expect(noise.records).toHaveLength(0);
			expect(noise.status.at(-1)).toEqual([`Listening for FANET (SF7, ${band.bwHz / 1000} kHz)`, false]);
		}
	}, 60_000);
});

describe('FANET records', () => {
	it('paces an aircraft (first frame, then every 5 s), adds its name and the distance', () => {
		const frames = [
			{ payload: fanetName(0x11, 0x2233, 'Bob'), at: 0.05 },
			...[0.2, 1.7, 3.2, 4.7, 6.2].map((at, i) => ({
				payload: fanetTrack(0x11, 0x2233, 46.5 + 0.001 * i, 7.9, 1200, { extra: [0x80 | 2, 0x05] }),
				at,
			})),
		];
		const r = runFanet(fanetFrames(frames, { snrDb: -2, freqHz: -7000 }), { station: STATION });
		cpu(r, 'FANET 250 kHz, six frames');
		expect(r.records.map((x) => x.text)).toEqual([
			'FANET 11:2233 · name: Bob',
			'FANET 11:2233 · paraglider · 46.50000, 7.90001 · 1200 m · 20 km/h · heading 90° · +1.2 m/s · 6.8 km',
			'FANET 11:2233 · paraglider · 46.50400, 7.90001 · 1200 m · 20 km/h · heading 90° · +1.2 m/s · 7.1 km',
		]);
		const t = r.records[1];
		expect([field(t, 'Name'), field(t, 'ID type'), field(t, 'Turn rate'), field(t, 'QNE offset')]).toEqual([
			'Bob',
			'FANET address, FANET+ (0x11)',
			'+2.00°/s',
			'+5 m',
		]);
		expect(field(t, 'Distance')).toBe('6.8 km, bearing 35°');
		expect(field(t, 'Spreading factor')).toBe('SF7');
		expect(r.status.at(-1)).toEqual(['1 aircraft · 6 frames', true]);
	}, 60_000);
	it('counts positions with online tracking off and never shows them', () => {
		const frames = fanetFrames([
			fanetTrack(0x01, 0x0101, 46.5, 7.9, 1000, { online: false }),
			fanetGround(0x01, 0x0101, 46.5, 7.9, 1, false),
			fanetTrack(0x01, 0x0202, 46.6, 7.8, 900),
		]);
		const r = runFanet(frames);
		expect(r.records.map((x) => field(x, 'Aircraft ID'))).toEqual(['01:0202']);
		expect(r.decoder.stats.privacyFrames).toBe(2);
		expect(r.status.at(-1)[0]).toBe('1 aircraft · 3 frames · 1 with online tracking off (not shown)');
	}, 60_000);
	it('shows messages, pilots on the ground, weather, thermals and landmarks', () => {
		const frames = fanetFrames([
			fanetMessage(0x11, 0x2233, 'see you at the LZ', [0x11, 0x4455]),
			fanetGround(0x11, 0x2233, 46.48, 7.88, 13),
			fanetGround(0x11, 0x6677, 46.47, 7.87, 9),
			fanetWeather(0xfb, 0x1234, 46.6, 8.0),
			fanetThermal(0x01, 0x0042, 46.55, 7.95),
			fanetLandmark(0x01, 0x0042, [
				[46.501, 7.902],
				[46.5103, 7.9101],
				[46.4999, 7.92],
			]),
		]);
		const r = runFanet(frames, { station: STATION, chunk: 4096 });
		expect(r.records.map((x) => x.text)).toEqual([
			'FANET 11:2233 → 11:4455 · message: see you at the LZ',
			'FANET 11:2233 · on the ground: need medical help · 46.48000, 7.88001 · 4.1 km',
			'FANET 11:6677 · on the ground: landed well · 46.47000, 7.87001 · 2.7 km',
			'FANET FB:1234 · service, 15.0 C, wind 270 deg 10.0 km/h gust 15.0, humidity 60%, 1008.8 hPa · 46.60000, 8.00000 · 20.2 km',
			'FANET 01:0042 · thermal, 1500 m, climb 2.5 m/s, quality 71%, wind 10.0 km/h from 270 deg · 46.55000, 7.95000 · 13.5 km',
			'FANET 01:0042 · landmark: area (warning), 3 points, for 30 min · 46.50100, 7.90200 · 6.9 km',
		]);
		expect(r.records.map((x) => !!x.alert)).toEqual([false, true, false, false, false, false]);
		expect(field(r.records[0], 'To')).toBe('11:4455, FANET+ (0x11)');
		expect(field(r.records[3], 'Manufacturer')).toBe('Espressif base station (0xFB)');
		expect(field(r.records[3], 'Wind')).toBe('10.0 km/h from 270°, gusts 15.0 km/h');
		expect(field(r.records[5], 'Points')).toBe('46.50100, 7.90200; 46.51033, 7.91012; 46.49989, 7.92001');
	}, 60_000);
	it('gives the same records from small and large chunks', () => {
		const frames = fanetFrames(
			[fanetName(0x11, 0x2233, 'Bob'), fanetTrack(0x11, 0x2233, 46.5, 7.9, 1200), fanetThermal(1, 0x42, 46.5, 7.9)],
			{
				snrDb: -3,
			},
		);
		const texts = [1000, 16384, 100000].map((chunk) => runFanet(frames, { chunk }).records.map((x) => x.text));
		expect(texts[0]).toHaveLength(3);
		expect(texts[1]).toEqual(texts[0]);
		expect(texts[2]).toEqual(texts[0]);
	}, 60_000);
	it('uses the bands of its catalog entries', () => {
		expect([FANET_250, FANET_500, FANET_125].map((b) => b.rate / b.bwHz)).toEqual([2, 2, 2]);
	});
});
