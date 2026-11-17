// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR from OnAir tests/dpmr/test_dpmr_proto.cpp, https://github.com/adswill/OnAir;
// see third_party/onair.
// Changes: vitest cases; the soft decoder is also checked against double errors.
//
// dPMR air interface pieces: syncs, Hamming (12,8) with errors, CRCs, interleaved blocks, header / CCH / end / data round
// trips, colour codes, the PMR446 channel raster.
import { describe, expect, it } from 'vitest';
import {
	FS1,
	FS2,
	FS3,
	FS4,
	blockDecode,
	blockDecodeSoft,
	blockEncode,
	ccDecode,
	ccSymbols,
	cchBits,
	cchParse,
	dataBits,
	dataParse,
	endBits,
	endParse,
	hamDecode,
	hamEncode,
	headerBits,
	headerParse,
	idText,
	pmr446Mhz,
} from '@/worker/decoders/dsd/dpmr/proto';

describe('dPMR air interface (OnAir test_dpmr_proto)', () => {
	it('frame syncs: FS1 starts +3 +3 +3 -3, and the four differ', () => {
		expect([FS1[0], FS1[3], FS2[0], FS3[0], FS4[0]]).toEqual([3, -3, 3, 3, -3]);
		expect([FS1.length, FS2.length, FS3.length, FS4.length]).toEqual([24, 12, 24, 24]);
		let same13 = 0;
		let same14 = 0;
		for (let i = 0; i < 24; i++) {
			same13 += FS1[i] === FS3[i];
			same14 += FS1[i] === FS4[i];
		}
		expect(same13).toBeLessThan(16);
		expect(same14).toBeLessThan(16);
	});
	it('Hamming (12,8) corrects every single error', () => {
		for (let v = 0; v < 256; v++) {
			const d = Uint8Array.from({ length: 8 }, (_, i) => (v >> i) & 1);
			const c = new Uint8Array(12);
			hamEncode(d, c);
			for (let e = 0; e < 12; e++) {
				const x = c.slice();
				x[e] ^= 1;
				expect(hamDecode(x)).toBe(1);
				expect(x.subarray(0, 8)).toEqual(c.subarray(0, 8));
			}
		}
	});
	it('a header block survives a burst of ten air bits, and CRC-8 catches an error', () => {
		const h = { type: 0, called: 0xabcdef, own: 1234567, commMode: 0, callType: 0, emergency: true, extra: 9 };
		const air = blockEncode(headerBits(h), 10);
		for (let i = 30; i < 40; i++) air[i] ^= 1;
		const back = new Uint8Array(80);
		expect(blockDecode(air, 10, back)).toBe(10);
		expect(headerParse(back)).toEqual(h);
		back[5] ^= 1;
		expect(headerParse(back)).toBeNull();
	});
	it('CCH, end frame and data block round trips', () => {
		const c = { frame: 2, idPart: 0x5a5, commMode: 0, version: 0, callType: 1, emergency: false, slowData: 0x2a5a5 };
		const ca = blockEncode(cchBits(c), 6);
		ca[7] ^= 1;
		const cb = new Uint8Array(48);
		expect(blockDecode(ca, 6, cb)).toBe(1);
		expect(cchParse(cb)).toEqual(c);
		expect(endParse(endBits({ type: 0, own: 777 }))).toEqual({ type: 0, own: 777 });
		expect(dataParse(dataBits(3, 'HELLO'))).toEqual({ block: 3, text: 'HELLO' });
	});
	it('soft decision repairs double errors that the hard decoder only detects', () => {
		const c = { frame: 1, idPart: 0x123, commMode: 0, version: 0, callType: 1, emergency: false, slowData: 7 };
		const air = blockEncode(cchBits(c), 6);
		// two errors in word 0 (air bit k of word 0 is k * 6), received with low confidence: data bit 3 and parity
		// bit 0 give syndrome 7 ^ 8 = 15, which matches no single bit
		const soft = Float32Array.from(air, (b) => (b ? 1 : -1));
		for (const k of [3, 8]) soft[k * 6] = -0.2 * soft[k * 6];
		const info = new Uint8Array(48);
		const bad = Uint8Array.from(soft, (v) => (v > 0 ? 1 : 0));
		expect(blockDecode(bad, 6, info)).toBe(-1);
		expect(blockDecodeSoft(soft, 6, info)).toBe(2);
		expect(cchParse(info)).toEqual(c);
	});
	it('colour codes with one symbol lost', () => {
		for (let cc = 0; cc < 64; cc++) {
			const v = Float32Array.from(ccSymbols(cc), (s) => s * 0.8);
			v[cc % 12] = 0;
			expect(ccDecode(v).cc).toBe(cc);
		}
	});
	it('PMR446 channels and ids', () => {
		expect(pmr446Mhz(1)).toBe(446.103125);
		expect(pmr446Mhz(16)).toBeGreaterThan(446.196);
		expect(pmr446Mhz(16)).toBeLessThan(446.197);
		expect([idText(0xffffff), idText(42), idText(-1)]).toEqual(['ALL', '00000042', '?']);
	});
});
