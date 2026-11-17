// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR from OnAir tests/nxdn/test_nxdn_proto.cpp and rust/onair_nxdn/src/tests.rs,
// https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the AMBE+2 bit order is ambe.ts (DSD's DMR schedule, the same tables as OnAir's NXDN order); the frame sync
// check of the 4800 symbols/s chain (nxdnSyncAt) is BrowSDR's and tested here too.
import { describe, expect, it } from 'vitest';
import { ambeFrame } from '@/worker/decoders/dsd/ambe';
import { SYNC_WORDS } from '@/worker/decoders/dsd/constants';
import {
	CAC,
	FACCH1,
	FSW,
	SACCH,
	SD_DATA,
	SITE_INFO,
	VCALL,
	airBits,
	buildMsg,
	crc12,
	crc16,
	crc6,
	decode,
	emptyMsg,
	encode,
	infoBits,
	lichDecode,
	lichEncode,
	nxdnSyncAt,
	parseMsg,
	pn9,
	PN9,
} from '@/worker/decoders/dsd/nxdn/proto';

let rng = 7;
const rnd = () => {
	rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
	return rng >>> 8;
};

describe('NXDN protocol (OnAir test_nxdn_proto)', () => {
	it('CRC: a single flipped bit is caught', () => {
		const b = Uint8Array.from({ length: 40 }, () => rnd() & 1);
		const [c6, c12, c16] = [crc6(b), crc12(b), crc16(b)];
		b[13] ^= 1;
		expect(crc6(b)).not.toBe(c6);
		expect(crc12(b)).not.toBe(c12);
		expect(crc16(b)).not.toBe(c16);
		expect(c6 < 64 && c12 < 4096 && c16 < 65536).toBe(true);
	});

	it('LICH round trip and parity', () => {
		for (let v = 0; v < 128; v++) {
			const l = { rfct: (v >> 5) & 3, fct: (v >> 3) & 3, opt: (v >> 1) & 3, dir: v & 1 };
			const e = lichEncode(l);
			expect(lichDecode(e)).toEqual(l);
			expect(lichDecode(e ^ 0x80)).toBeNull();
		}
	});

	it.each([
		[SACCH, 3],
		[FACCH1, 3],
		[CAC, 10],
	])('coded channel %i: clean, with %i spread bit errors, random', (c, fixable) => {
		const ni = infoBits(c);
		const na = airBits(c);
		let okClean = 0;
		let okErr = 0;
		let falseOk = 0;
		for (let trial = 0; trial < 50; trial++) {
			const info = Uint8Array.from({ length: ni }, () => rnd() & 1);
			const soft = Float32Array.from(encode(c, info), (b) => (b ? 1 : -1));
			const clean = decode(c, soft);
			if (clean && clean.errors === 0 && clean.info.every((b, i) => b === info[i])) okClean++;
			const pos = new Set();
			while (pos.size < fixable) pos.add(rnd() % na);
			for (const p of pos) soft[p] = -soft[p];
			const fixed = decode(c, soft);
			if (fixed && fixed.errors === fixable && fixed.info.every((b, i) => b === info[i])) okErr++;
			if (
				decode(
					c,
					Float32Array.from({ length: na }, () => (rnd() & 1 ? 1 : -1)),
				)
			)
				falseOk++;
		}
		expect(okClean).toBe(50);
		expect(okErr).toBeGreaterThanOrEqual(45);
		expect(falseOk).toBeLessThanOrEqual(c === SACCH ? 4 : 0);
	});

	it('layer 3 messages', () => {
		const m = { ...emptyMsg(VCALL), callType: 4, option: 2, src: 54321, dst: 65000, cipher: 1, keyId: 9 };
		expect(parseMsg(buildMsg(m, 72), 72)).toEqual(m);
		expect(parseMsg(buildMsg(m, 72), 56)).toEqual(m);
		const d = { ...emptyMsg(SD_DATA), block: 3, text: 'ABCDEFGH' };
		expect(parseMsg(buildMsg(d, 80), 80)).toMatchObject({ block: 3, text: 'ABCDEFGH' });
		expect(parseMsg(buildMsg(d, 80), 70)).toBeNull();
		const s = { ...emptyMsg(SITE_INFO), location: 0xabcdef, service: 0x3c00, channel: 0x0101 };
		expect(parseMsg(buildMsg(s, 147), 147)).toMatchObject({ location: 0xabcdef, service: 0x3c00, channel: 0x0101 });
	});

	it('AMBE+2 order: every one of the 72 bits lands in its own place', () => {
		const seen = new Set();
		for (let i = 0; i < 72; i++) {
			const b = new Uint8Array(72);
			b[i] = 1;
			const fr = ambeFrame(b);
			expect(fr.reduce((a, x) => a + x, 0)).toBe(1);
			seen.add(fr.indexOf(1));
		}
		expect(seen.size).toBe(72);
	});

	it('PN9: period 511, first bits from the seed 0xE4', () => {
		const p = pn9(1022);
		expect(p.subarray(0, 511)).toEqual(p.subarray(511));
		expect(Array.from(p.subarray(0, 8))).toEqual([0, 0, 1, 0, 0, 1, 1, 1]);
	});
});

describe("NXDN96 frame sync on the 4800 symbols/s chain (BrowSDR's)", () => {
	const history = (l, inverted = false) => {
		const lb = lichEncode(l);
		const sym = [...FSW, ...Array.from({ length: 8 }, (_, k) => (((lb >> (7 - k)) & 1) ^ PN9[k] ? -3 : 3))];
		return sym.map((s) => (s > 0 !== inverted ? '1' : '3')).join('');
	};
	it("finds DSD's NXDN sync words, as sent and inverted", () => {
		for (const [name, w] of Object.entries(SYNC_WORDS))
			if (name.includes('NXDN')) expect(nxdnSyncAt('0123' + w)).toBe(name.startsWith('INV') ? -1 : 1);
	});
	it('finds the LICH values the decoder reads, not the others', () => {
		expect(nxdnSyncAt(history({ rfct: 0, fct: 0, opt: 0, dir: 1 }))).toBe(1);
		expect(nxdnSyncAt(history({ rfct: 1, fct: 2, opt: 3, dir: 1 }, true))).toBe(-1);
		expect(nxdnSyncAt(history({ rfct: 1, fct: 0, opt: 0, dir: 0 }))).toBe(1);
		expect(nxdnSyncAt(history({ rfct: 0, fct: 0, opt: 0, dir: 0 }))).toBe(0); // inbound CAC
		expect(nxdnSyncAt(history({ rfct: 1, fct: 1, opt: 0, dir: 1 }))).toBe(0); // UDCH
		const bad = history({ rfct: 1, fct: 2, opt: 3, dir: 1 }).split('');
		bad[17] = bad[17] === '1' ? '3' : '1';
		expect(nxdnSyncAt(bad.join(''))).toBe(0); // LICH parity
		expect(nxdnSyncAt('1' + history({ rfct: 1, fct: 2, opt: 3, dir: 1 }).slice(1))).toBe(0); // FSW
	});
});
