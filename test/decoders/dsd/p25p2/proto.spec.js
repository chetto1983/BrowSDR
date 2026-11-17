// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR from OnAir tests/p25p2/test_p25p2_proto.cpp and the message length checks (C14 / C15)
// of tests/p25p2/test_p25p2_audit.cpp, https://github.com/adswill/OnAir; see third_party/onair.
// Changes: written against the merged protocol.ts (the repository's burst primitives ischValue, ischDecode, p25p2Duid,
// p25p2Scramble and p25p2AmbeFrame, whose own cases stay in ../p25p2-protocol.spec.js); OnAir's earlier private MAC layout
// (macEncode / macDecode) is not ported, so its checks are left out; the random numbers come from a seeded generator of
// the test (not std::mt19937); the seed solver (BrowSDR's) is checked against scrambled MAC PDUs of the standard's coding.
//
// P25 Phase 2 protocol layer: ISCH (sync word and the (40,9) I-ISCH), the (8,4) DUID, the scrambling sequence (against
// XMC_SDR's), the AMBE+2 frame places, the ESS (RS(44,16)), and the MAC PDU codewords (Reed-Solomon + CRC-12) with errors.
import { describe, expect, it } from 'vitest';
import { ISCH_WORDS } from '@/worker/decoders/dsd/p25p2/data';
import {
	ALG_CLEAR,
	DUID_2V,
	DUID_4V,
	DUID_FACCH,
	DUID_POSITIONS,
	DUID_SACCH,
	ESS_B_POS,
	P25P2_SYNC,
	P25P2_VOICE_OFFSETS,
	PAYLOAD_POS,
	ambeFlatten,
	ambePut,
	ambeUnflatten,
	argField,
	be16,
	be24,
	duidPut,
	duidWord,
	essDecode,
	essEncode,
	hexbitsGet,
	hexbitsPut,
	ischDecode,
	ischInfo,
	ischInfoOf,
	ischSync,
	ischSyncDistance,
	ischValue,
	macDecodeAir,
	macEncodeAir,
	macMsgLen,
	macMsgLenAt,
	macOpcode,
	p25p2AmbeFrame,
	p25p2Duid,
	p25p2Scramble,
	payloadGet,
	payloadPut,
	slotChannel,
} from '@/worker/decoders/dsd/p25p2/protocol';
import { crc12, rs63Decode, rsEncode } from '@/worker/decoders/dsd/p25p2/rs';
import { P25p2SeedSolver } from '@/worker/decoders/dsd/p25p2/seed';
import { rngOf } from '../voice-fixtures.js';
import { macPtt, msgGrpVGrant, put16, put24 } from './fixtures.js';

const rng = rngOf(5);
const rand = (n) => Math.floor(rng() * n);

/** count distinct values below n */
function distinct(count, n) {
	const s = new Set();
	while (s.size < count) s.add(rand(n));
	return [...s];
}

describe('P25 Phase 2 ISCH and DUID (OnAir test_p25p2_proto)', () => {
	it('the sync word and the 128 I-ISCH code words, with seven bit errors', () => {
		const d = new Uint8Array(20);
		ischSync(d);
		expect(ischSyncDistance(d)).toBe(0);
		expect(ischValue(d)).toBe(P25P2_SYNC);
		const words = new Set();
		const fields = (v) => ({ channel: (v >> 5) & 3, location: (v >> 3) & 3, first: (v >> 2) & 1, ultraframe: v & 3 });
		for (let v = 0; v < 128; v++) {
			ischInfo(v, d);
			words.add(ischValue(d));
			expect(ischValue(d)).toBe(ISCH_WORDS[v]);
			expect(ischDecode(d)).toEqual({ ...fields(v), errors: 0 });
			expect(ischSyncDistance(d)).toBeGreaterThan(10);
			for (const b of distinct(7, 40)) d[19 - (b >> 1)] ^= 1 << (b & 1);
			expect(ischDecode(d)).toEqual({ ...fields(v), errors: 7 });
		}
		expect(words.size).toBe(128);
		ischSync(d);
		expect(ischDecode(d)).toBeNull();
		expect(ischInfoOf(1, 2, 0, 3)).toBe(51);
		expect(ischInfoOf(0, 1, 0, 0)).toBe(8);
		// the logical channel of each slot: slot parity, swapped in slots 10 and 11
		expect(Array.from({ length: 12 }, (_, s) => slotChannel(s))).toEqual([0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 1, 0]);
	});

	it('every DUID with any one bit wrong, and the code words heard on the air', () => {
		const b = new Uint8Array(180);
		for (let duid = 0; duid < 16; duid++) {
			duidPut(duid, b);
			expect(p25p2Duid(b)).toBe(duid);
			expect(duidWord(duid) >> 4).toBe(duid);
			for (let bit = 0; bit < 8; bit++) {
				const e = b.slice();
				e[DUID_POSITIONS[bit >> 1]] ^= bit & 1 ? 1 : 2;
				expect(p25p2Duid(e)).toBe(duid);
			}
		}
		expect([DUID_4V, DUID_2V, DUID_SACCH, DUID_FACCH].map(duidWord)).toEqual([0x00, 0x65, 0x39, 0x9a]);
	});
});

describe('P25 Phase 2 scrambling, voice and ESS (OnAir test_p25p2_proto)', () => {
	it('the sequence of XMC_SDR for WACN BEE00, system 2D1, colour code 2D1 (the NSW PSN)', () => {
		const seq = p25p2Scramble(0xbee00, 0x2d1, 0x2d1);
		const head = '00000000002332320000023101023101232102230022203012122321213202121201322031002330';
		const tail = '11120110303310123033122021310212001311323333203313033111121210301131000021021322';
		expect(Array.from(seq.subarray(0, 80)).join('')).toBe(head);
		expect(Array.from(seq.subarray(2090, 2170)).join('')).toBe(tail);
		expect(p25p2Scramble(0, 0, 0).every((v) => v === 0)).toBe(true);
	});

	it('AMBE+2 frames land in their own places; the DUID and the ESS-B are not touched', () => {
		const b = new Uint8Array(180);
		duidPut(DUID_4V, b);
		const bits = Array.from({ length: 4 }, () => Uint8Array.from({ length: 72 }, () => rand(2)));
		for (let k = 0; k < 4; k++) ambePut(ambeUnflatten(bits[k]), P25P2_VOICE_OFFSETS[k], b);
		expect(p25p2Duid(b)).toBe(DUID_4V);
		expect(b.subarray(ESS_B_POS, ESS_B_POS + 12).every((v) => v === 0)).toBe(true);
		for (let k = 0; k < 4; k++) expect(ambeFlatten(p25p2AmbeFrame(b, P25P2_VOICE_OFFSETS[k]))).toEqual(bits[k]);
	});

	it('the ESS: RS(44,16) corrects 14 hexbits; algorithm 0 is reported as clear', () => {
		for (let it = 0; it < 100; it++) {
			const alg = it % 2 ? 0x84 : 0x80;
			const key = rand(0x10000);
			const mi = Uint8Array.from({ length: 9 }, () => rand(256));
			const { b, a } = essEncode(alg, key, mi);
			expect(essDecode(b.slice(), a)).toEqual({ algId: alg, keyId: key, mi, fixed: 0 });
			const b2 = b.slice();
			const a2 = a.slice();
			for (const p of distinct(14, 44)) {
				if (p < 16) b2[p] ^= 1 + rand(63);
				else a2[p - 16] ^= 1 + rand(63);
			}
			expect(essDecode(b2, a2)).toMatchObject({ algId: alg, keyId: key, mi });
		}
		const { b, a } = essEncode(0, 0, new Uint8Array(9));
		expect(essDecode(b, a)?.algId).toBe(ALG_CLEAR);
		const hex = Uint8Array.from({ length: 16 }, () => rand(64));
		const dib = new Uint8Array(48);
		hexbitsPut(hex, 16, dib);
		const back = new Uint8Array(16);
		hexbitsGet(dib, 0, 16, back);
		expect(back).toEqual(hex);
	});
});

describe('P25 Phase 2 MAC PDU codewords as on the air (OnAir test_p25p2_proto)', () => {
	// hexbit errors the punctured code corrects (28 roots, 6 or 9 of them spent on the punctured parity)
	it.each([
		['SACCH', false, 21, 11, 52],
		['FACCH', true, 18, 9, 45],
	])('%s: clean, with t hexbit errors, and hopeless words rejected', (_name, facch, nb, t, nSent) => {
		let rejected = 0;
		const damage = (pay, errs) => {
			const bad = pay.slice();
			for (const q of distinct(errs, nSent)) {
				const k = q * 3 + rand(3);
				bad[facch && k >= 67 ? k + 21 : k] ^= 1 + rand(3);
			}
			return bad;
		};
		for (let it = 0; it < 200; it++) {
			const mac = Uint8Array.from({ length: nb }, () => rand(256));
			const pay = macEncodeAir(facch, mac);
			expect(macDecodeAir(facch, pay)).toEqual({ mac, corrected: 0 });
			expect(macDecodeAir(facch, damage(pay, t))).toEqual({ mac, corrected: t });
			const hopeless = macDecodeAir(facch, damage(pay, nSent - 6));
			if (hopeless) expect(hopeless.mac).toEqual(mac);
			else rejected++;
			const tooMany = macDecodeAir(facch, damage(pay, t + 3));
			expect(tooMany?.mac ?? null).not.toEqual(mac);
		}
		expect(rejected).toBeGreaterThan(190);
	});

	it('the FACCH codeword leaves 21 payload dibits alone; CRC-12 is complemented; the erasure decoder', () => {
		const pay = macEncodeAir(true, new Uint8Array(18));
		expect(pay.subarray(67, 88).every((v) => v === 0)).toBe(true);
		expect(crc12(new Uint8Array(8), 8)).not.toBe(0);
		// a codeword with only its punctured symbols erased and 5 errors
		const sym = new Uint8Array(63);
		for (let i = 5; i < 35; i++) sym[i] = rand(64);
		rsEncode(sym, 63, 35);
		const w = sym.slice();
		const era = [57, 58, 59, 60, 61, 62];
		for (const e of era) w[e] = 33;
		for (const q of [7, 20, 31, 40, 52]) w[q] ^= 21;
		expect(rs63Decode(w, era)).toBe(5);
		expect(w).toEqual(sym);
	});

	it('the codeword in the burst: around the DUID dibits', () => {
		const b = new Uint8Array(180);
		const cw = Uint8Array.from({ length: 156 }, () => rand(4));
		duidPut(DUID_FACCH, b);
		payloadPut(cw, 156, b);
		expect(payloadGet(b)).toEqual(cw);
		expect(p25p2Duid(b)).toBe(DUID_FACCH);
	});

	it('builders and field offsets', () => {
		const p = macPtt(20, 0xabcdef, 0x1234, 0x84);
		expect(p.length).toBe(20);
		expect(macOpcode(p[0])).toBe(1);
		expect([be24(p, 13), be16(p, 16), p[10]]).toEqual([0xabcdef, 0x1234, 0x84]);
		expect(p.subarray(1, 10).every((v) => v === 0)).toBe(true);
		const g = msgGrpVGrant(0xc0, 0x1005, 777, 424242);
		expect(g.length).toBe(9);
		expect(macMsgLen(g[0])).toBe(9);
		expect([argField(g, 1, 24, 16), argField(g, 1, 0, 24), argField(g, 1, 40, 16), argField(g, 1, 56, 8)]).toEqual([
			777, 424242, 0x1005, 0xc0,
		]);
		for (const op of [0x01, 0x02, 0x40, 0x42, 0x44, 0x74, 0x7a, 0x7b, 0x7c, 0x7d]) expect(macMsgLen(op)).toBeGreaterThan(0);
		expect(macMsgLen(0x56)).toBe(0);
	});
});

describe('P25 Phase 2 MAC message lengths (OnAir test_p25p2_audit C14 / C15)', () => {
	it('null, avoid-zero-bias, variable lists, manufacturer and extended grants', () => {
		expect(macMsgLenAt([0x00, 1, 2, 3, 4, 5], 0, 6)).toBe(6);
		expect(macMsgLenAt([0x08, 0x03, 0, 0], 0, 4)).toBe(3);
		expect(macMsgLenAt([0x11, 0x01, 0, 0, 0, 0, 0, 0], 0, 8)).toBe(6);
		expect(macMsgLenAt([0x12, 0x02, ...new Array(10).fill(0)], 0, 12)).toBe(11);
		expect(macMsgLenAt([0x90, 0x90, 0x05, ...new Array(9).fill(0)], 0, 12)).toBe(5);
		expect(macMsgLenAt([0x80, 0x90, 0x00, ...new Array(9).fill(0)], 0, 12)).toBe(macMsgLen(0x80));
		expect(macMsgLenAt([0xc0, ...new Array(11).fill(0)], 0, 12)).toBe(11);
		expect(macMsgLen(0xc3)).toBe(8);
		expect(macMsgLenAt([0xc0], 0, 0)).toBe(0);
		const v = [0, 0, 0, 0, 0];
		put16(v, 0, 0x1234);
		put24(v, 2, 0xabcdef);
		expect(v).toEqual([0x12, 0x34, 0xab, 0xcd, 0xef]);
	});
});

describe('P25 Phase 2 descrambler seed from a MAC burst (BrowSDR)', () => {
	const scrambled = (facch, mac, seed, slot) => {
		const seq = p25p2Scramble(seed.wacn, seed.sysId, seed.nac);
		const pay = macEncodeAir(facch, mac);
		return pay.map((d, k) => d ^ seq[slot * 180 + PAYLOAD_POS[k]]);
	};
	it.each([
		['SACCH', false, 21],
		['FACCH', true, 18],
	])('%s in every slot: the seed comes out, and a burst with errors gives none', (_name, facch, nb) => {
		const solver = new P25p2SeedSolver();
		for (let slot = 0; slot < 12; slot++) {
			const seed = { wacn: rand(0x100000), sysId: rand(0x1000), nac: rand(0x1000) };
			const mac = Uint8Array.from({ length: nb }, () => rand(256));
			const pay = scrambled(facch, mac, seed, slot);
			expect(solver.solve(slot, facch, pay)).toEqual(seed);
			pay[rand(facch ? 60 : 150)] ^= 1;
			expect(solver.solve(slot, facch, pay)).toBeNull();
		}
		const pay = macEncodeAir(facch, new Uint8Array(nb));
		expect(solver.solve(3, facch, pay)).toEqual({ wacn: 0, sysId: 0, nac: 0 });
	});
});
