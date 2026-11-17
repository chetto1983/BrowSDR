// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir tests/avroad/test_avroad_air.cpp (testFanet: the formats against
// hand-built frames: tracking fields and position, a name, a unicast message with an extended header, a service frame
// with gateway, temperature and wind, a short frame), https://github.com/adswill/OnAir; see third_party/onair. Format
// facts as credited there: the FANET protocol description (protocol.txt of Skytraxx's fanet-stm32). Changes: added
// cases for what BrowSDR reads beyond OnAir (turn rate and QNE offset, ground tracking, weather values, thermals,
// landmarks with compressed coordinates) and random frames that must never throw.

import { describe, expect, it } from 'vitest';
import { fanetParse, uncompressCoordinate } from '@/worker/decoders/digimode/fanet/proto';
import { compressed, fanetGround, fanetLandmark, fanetThermal, fanetTrack, fanetWeather } from './fixtures';

const le16 = ([a, b]) => a | (b << 8);

describe('FANET frames (OnAir testFanet)', () => {
	it('reads a tracking frame', () => {
		const f = fanetParse(fanetTrack(0x11, 0x2233, 47.5, -8.25, 1200));
		expect(f).toMatchObject({ valid: true, type: 1, manufacturer: 0x11, device: 0x2233, altM: 1200, aircraftType: 1, online: true });
		expect(Math.abs(f.lat - 47.5)).toBeLessThan(2e-5);
		expect(Math.abs(f.lon + 8.25)).toBeLessThan(3e-5);
		expect(f.speedKmh).toBeCloseTo(20, 2);
		expect(f.climbMs).toBeCloseTo(1.2, 2);
		expect(f.headingDeg).toBeCloseTo(90, 2);
		expect(f.text).toBe('paraglider, 1200 m, 20.0 km/h, climb 1.2 m/s, heading 90');
	});
	it('reads a name, a unicast message and a service frame; refuses a short frame', () => {
		const n = Uint8Array.from([2, 1, 2, 0, 0x42, 0x6f, 0x62]);
		expect(fanetParse(n).text).toBe('name: Bob');
		const m = fanetParse(Uint8Array.from([0x83, 1, 2, 0, 0x20, 9, 8, 7, 0, 0x68, 0x69])); // extended header, unicast
		expect(m).toMatchObject({ unicast: true, destManufacturer: 9, destDevice: 0x0708, text: 'message: hi' });
		// gateway, temperature, wind with a position
		const s = fanetParse(Uint8Array.from([4, 1, 2, 0, 0xe0, 0x10, 0x20, 0x30, 0x10, 0x20, 0x30, 40, 64, 10, 20]));
		expect(s.hasPos).toBe(true);
		expect(s.text).toBe('service, internet gateway, 20.0 C, wind 90 deg 2.0 km/h gust 4.0');
		expect(fanetParse(n.subarray(0, 2)).valid).toBe(false);
	});
});

describe('FANET frames beyond OnAir (protocol description)', () => {
	it('reads the turn rate and QNE offset, and the online-tracking bit', () => {
		const f = fanetParse(fanetTrack(0x07, 0x0101, 46.0, 7.5, 800, { online: false, extra: [0x7c, 0x80 | 3] }));
		expect(f).toMatchObject({ online: false, turnRateDegS: -1, qneOffsetM: 12 });
		const big = fanetParse(fanetTrack(0x07, 0x0101, 46.0, 7.5, 1500, { speed: 0x80 | 30, climb: 0x80 | 0x7e, aircraft: 4 }));
		expect(big).toMatchObject({ altM: 1500, aircraftType: 4 });
		expect(big.speedKmh).toBeCloseTo(75, 5);
		expect(big.climbMs).toBeCloseTo(-1, 5);
	});
	it('reads ground tracking, weather and a thermal', () => {
		const g = fanetParse(fanetGround(0x01, 0x0042, 46.5, 7.9, 14, false));
		expect(g).toMatchObject({ type: 7, groundType: 14, online: false, hasPos: true, text: 'on the ground: distress call' });
		const w = fanetParse(fanetWeather(0xfb, 0x1234, 46.6, 8.0));
		const want = { tempC: 15, windDeg: 270, windKmh: 10, gustKmh: 15, humidityPct: 60, pressureHpa: 1008.8 };
		for (const [key, value] of Object.entries(want)) expect(w.service[key]).toBeCloseTo(value, 5);
		expect(w.service.gateway).toBe(false);
		expect(Math.abs(w.lat - 46.6)).toBeLessThan(2e-5);
		const t = fanetParse(fanetThermal(0x01, 0x0042, 46.7, 8.1));
		for (const [key, value] of Object.entries({ quality: 5, altM: 1500, climbMs: 2.5, windKmh: 10, windDeg: 270 }))
			expect(t.thermal[key]).toBeCloseTo(value, 5);
		expect(t.text).toBe('thermal, 1500 m, climb 2.5 m/s, quality 71%, wind 10.0 km/h from 270 deg');
	});
	it('reads landmarks: an area of compressed points and a text', () => {
		const pts = [
			[46.501, 7.902],
			[46.5103, 7.9101],
			[46.4999, 7.92],
			[46.495, 7.905],
		];
		const a = fanetParse(fanetLandmark(0x01, 0x0042, pts));
		expect(a.landmark).toMatchObject({ subtype: 3, layer: 1, ttlMin: 30 });
		expect(a.landmark.points).toHaveLength(4);
		a.landmark.points.forEach(([lat, lon], i) => {
			expect(Math.abs(lat - pts[i][0])).toBeLessThan(1e-4);
			expect(Math.abs(lon - pts[i][1])).toBeLessThan(1e-4);
		});
		expect(a.text).toBe('landmark: area (warning), 4 points, for 30 min');
		const t = fanetParse(fanetLandmark(0x01, 0x0042, [[46.52, 7.95]], 'LZ North'));
		expect(t.landmark).toMatchObject({ subtype: 0, layer: 0, text: 'LZ North' });
		expect(t.text).toBe('landmark: text (info), "LZ North", for 30 min');
	});
	it('decompresses coordinates across a whole degree', () => {
		for (const [deg, ref] of [
			[46.999, 47.2],
			[47.001, 46.8],
			[-8.4, -8.6],
			[-7.6, -7.4],
		])
			expect(Math.abs(uncompressCoordinate(le16(compressed(deg)), ref) - deg)).toBeLessThan(1e-4);
	});
	it('never throws on random frames', () => {
		let x = 7;
		const next = () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0) >>> 24;
		for (let k = 0; k < 4000; k++) {
			const b = Uint8Array.from({ length: k % 40 }, next);
			if (b.length) b[0] = (b[0] & 0xc0) | (k % 12);
			expect(typeof fanetParse(b).text).toBe('string');
		}
	});
});
