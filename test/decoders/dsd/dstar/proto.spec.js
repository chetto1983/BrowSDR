// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR from OnAir tests/dstar/test_dstar_proto.cpp and rust/onair_dstar/src/tests.rs,
// https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the AMBE bit order is DSD's (constants.ts DSTAR_W / DSTAR_X, the same tables as OnAir's ambe_frame).
import { describe, expect, it } from 'vitest';
import { DSTAR_W, DSTAR_X } from '@/worker/decoders/dsd/constants';
import { dprsCrc, nmeaChecksum, parseDprs, parseNmea } from '@/worker/decoders/dsd/dstar/gps';
import {
	HEADER_BITS,
	dstarCrc,
	flagText,
	headerDecode,
	headerEncode,
	headerPack,
	headerUnpack,
	interleave,
} from '@/worker/decoders/dsd/dstar/header';
import { dstarDprs, dstarGga, dstarRmc, header } from './fixtures.js';

const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));
const repeater = header({ flag: [0x40, 0, 0], rpt2: 'LY0VNO G', rpt1: 'LY0VNO B', ur: 'CQCQCQ', my: 'N0CALL', sfx: 'ID51' });

describe('D-STAR protocol pieces (OnAir test_dstar_proto)', () => {
	it('CRC-CCITT as D-STAR uses it is CRC-16/X-25: check value 0x906E', () => {
		expect(dstarCrc(ascii('123456789'))).toBe(0x906e);
	});

	it('the interleaver is a permutation', () => {
		const seen = new Set();
		for (let i = 0; i < HEADER_BITS; i++) {
			const one = new Uint8Array(HEADER_BITS);
			one[i] = 1;
			interleave(one).forEach((b, k) => b && seen.add(k));
		}
		expect(seen.size).toBe(HEADER_BITS);
	});

	it.each([0, 8, 20, 30])('the header through the whole chain with %i spread bit errors', (nerr) => {
		const bits = headerEncode(headerPack(repeater));
		const soft = Float32Array.from(bits, (b) => (b ? 1 : -1));
		for (let k = 0; k < nerr; k++) {
			const i = (Math.floor((k * HEADER_BITS) / Math.max(1, nerr)) + 5) % HEADER_BITS;
			soft[i] = -soft[i];
		}
		const { bytes, errors } = headerDecode(soft);
		const { header: h, ok } = headerUnpack(bytes);
		expect(ok).toBe(true);
		expect(errors).toBe(nerr);
		expect(h).toEqual(repeater);
	});

	it('header round trip through the FEC with 5 errors (rust tests)', () => {
		const h = header({ my: 'LY1TST', sfx: 'D75' });
		const soft = Float32Array.from(headerEncode(headerPack(h)), (b) => (b ? 1 : -1));
		for (const k of [5, 90, 300, 301, 590]) soft[k] = -soft[k];
		const { bytes, errors } = headerDecode(soft);
		expect(errors).toBe(5);
		expect(headerUnpack(bytes)).toEqual({ header: h, ok: true });
	});

	it('a damaged header fails its CRC; the flags as text', () => {
		const d = headerPack(repeater);
		d[30] ^= 4;
		expect(headerUnpack(d).ok).toBe(false);
		expect(flagText(0x40)).toBe('via repeater');
		expect(flagText(0x08 | 0x80)).toBe('data, simplex, EMERGENCY');
		expect(flagText(0x47)).toBe('via repeater, repeater control');
	});

	it('AMBE order: every one of the 72 bits lands in its own place', () => {
		const seen = new Set(Array.from({ length: 72 }, (_, i) => DSTAR_W[i] * 24 + DSTAR_X[i]));
		expect(seen.size).toBe(72);
	});

	it('GPS: what the generator writes, the parsers read back', () => {
		let l = dstarRmc(54.6872, 25.2797, 36, 90).replace(/\r\n$/, '');
		let f = parseNmea(l);
		expect(f).toMatchObject({ velValid: true, course: 90 });
		expect(Math.abs(f.lat - 54.6872)).toBeLessThan(1e-4);
		expect(Math.abs(f.lon - 25.2797)).toBeLessThan(1e-4);
		expect(Math.abs(f.speedKmh - 36)).toBeLessThan(0.2);
		const bad = l.slice(0, 20) + (l[20] === '1' ? '2' : '1') + l.slice(21);
		expect(parseNmea(bad)).toBeNull();
		l = dstarGga(-33.9, -70.65, 520).replace(/\r\n$/, '');
		f = parseNmea(l);
		expect(Math.abs(f.lat + 33.9)).toBeLessThan(1e-4);
		expect(Math.abs(f.lon + 70.65)).toBeLessThan(1e-4);
		expect(f.altValid).toBe(true);
		expect(Math.abs(f.altM - 520)).toBeLessThan(0.5);
		l = dstarDprs('LY1TST-7', 54.8985, 23.9036, 'hello').replace(/\r\n$/, '');
		f = parseDprs(l);
		expect(f).toMatchObject({ call: 'LY1TST-7', comment: 'hello', aprs: true });
		expect(Math.abs(f.lat - 54.8985)).toBeLessThan(2e-4);
		expect(Math.abs(f.lon - 23.9036)).toBeLessThan(2e-4);
		expect(parseDprs(l.slice(0, -2) + 'X' + l.slice(-1))).toBeNull();
		// A line from a real radio's format: no course / speed, altitude.
		const body = 'DL1ABC-9>API705,DSTAR*:!4811.50N/01622.35E>/A=000656 mobile';
		f = parseDprs(`$$CRC${dprsCrc(body).toString(16).toUpperCase().padStart(4, '0')},${body}`);
		expect(f).toMatchObject({ altValid: true, comment: ' mobile' });
		expect(Math.abs(f.lat - 48.19167)).toBeLessThan(1e-4);
		expect(Math.abs(f.lon - 16.3725)).toBeLessThan(1e-4);
		expect(Math.abs(f.altM - 200)).toBeLessThan(1);
	});

	it('NMEA RMC of the rust tests', () => {
		const body = 'GPRMC,123519,A,5441.2320,N,02516.7800,E,019.4,090.0,230394,003.1,W';
		const f = parseNmea(`$${body}*${nmeaChecksum(body)}`);
		expect(Math.abs(f.lat - 54.6872)).toBeLessThan(1e-4);
		expect(Math.abs(f.lon - 25.2797)).toBeLessThan(1e-4);
		expect(f).toMatchObject({ velValid: true, course: 90 });
	});
});
