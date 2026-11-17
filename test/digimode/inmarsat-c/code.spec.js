// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir tests/inmc/test_inmc_code.cpp, https://github.com/adswill/OnAir;
// see third_party/onair. Changes: vitest cases; the Viterbi curve uses 40 frames per point (OnAir 120) and its own seeded
// noise; known answers as in OnAir (from the open decoder "inmarsatc" and its documentation comments).

import { describe, expect, it } from 'vitest';
import {
	COLS,
	convOutput,
	decodeFrame,
	encodeFrame,
	FRAME_BYTES,
	FRAME_SYMS,
	matrixRowOfTxRow,
	packetCheckOk,
	packetCheckSet,
	ROWS,
	scramblerFlag,
	UW,
	uwErrors,
	uwFit,
} from '@/worker/decoders/digimode/inmarsat-c/code';
import { gaussian, xorshift } from './fixtures';

const randomInfo = (rng) => Uint8Array.from({ length: FRAME_BYTES }, () => rng() >>> 24);
const softOf = (sym, sigma = 0, noise = () => 0) => Float32Array.from(sym, (s) => (s ? 1 : -1) + sigma * noise());
const sameData = (a, b) => a.subarray(0, FRAME_BYTES - 1).every((v, i) => v === b[i]);
const popcount = (v) => {
	let n = 0;
	for (let x = v; x; x &= x - 1) n++;
	return n;
};

describe('Inmarsat-C frame coding', () => {
	it('has the reference unique word, scrambler, interleaver rows and code', () => {
		expect([...UW]).toEqual([
			0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 1, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 0, 1, 1, 1, 0, 0, 0, 1, 0, 1,
			1, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0,
		]);
		// first row of revPolUwPattern
		expect([...UW.subarray(0, 16)].map((b) => b ^ 1)).toEqual([1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 1]);
		expect(Array.from({ length: 8 }, (_, i) => scramblerFlag(i))).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
		const ones = Array.from({ length: 160 }, (_, i) => scramblerFlag(i)).reduce((a, b) => a + b, 0);
		expect(ones).toBeGreaterThan(50);
		expect(ones).toBeLessThan(110);
		expect([0, 1, 2].map(matrixRowOfTxRow)).toEqual([0, 39, 14]);
		const seen = new Set();
		for (let j = 0; j < 64; j++) {
			const i = matrixRowOfTxRow(j);
			expect((i * 23) % 64).toBe(j);
			seen.add(i);
		}
		expect(seen.size).toBe(64);
		// the decoder's partabIdx: the symbol pair of each state with a zero input
		const partabIdx = [0, 1, 3, 2, 3, 2, 0, 1, 0, 1, 3, 2, 3, 2, 0, 1, 2, 3, 1, 0, 1, 0, 2, 3, 2, 3, 1, 0, 1, 0, 2, 3];
		expect(Array.from({ length: 32 }, (_, i) => convOutput(i << 1))).toEqual(partabIdx);
		for (let t = 0; t < 7; t++) {
			const o = convOutput(1 << t);
			expect([(o >> 1) & 1, o & 1]).toEqual([(0x6d >> t) & 1, (0x4f >> t) & 1]);
		}
	});

	it('checks packets and catches every single byte error', () => {
		const pk = Uint8Array.of(0x7d, 1, 2, 3, 0, 0);
		packetCheckSet(pk, 6);
		expect([pk[4], pk[5]]).toEqual([0x7f, 0xfe]);
		expect(packetCheckOk(pk, 6)).toBe(true);
		const q = Uint8Array.from({ length: 20 }, (_, i) => (i * 37 + 5) & 0xff);
		packetCheckSet(q, 20);
		let missed = 0;
		for (let i = 0; i < 20; i++)
			for (let v = 1; v < 256; v++) {
				const w = q.slice();
				w[i] = (w[i] + v) & 0xff;
				if (packetCheckOk(w, 20)) missed++;
			}
		expect(missed).toBe(0);
	});

	it('round-trips a frame, and needs the polarity told', () => {
		const info = randomInfo(xorshift(12345));
		const sym = encodeFrame(info);
		for (let j = 0; j < ROWS; j++) expect([sym[j * COLS], sym[j * COLS + 1]]).toEqual([UW[j], UW[j]]);
		expect(uwErrors(sym)).toBe(0);
		const d = decodeFrame(softOf(sym));
		expect(sameData(d.bytes, info)).toBe(true);
		expect([d.symbolErrors, d.uwErrors]).toEqual([0, 0]);
		const inverted = decodeFrame(softOf(sym).map((v) => -v));
		expect(sameData(inverted.bytes, info)).toBe(false);
		expect(inverted.uwErrors).toBe(128);
	});

	it('corrects bit errors as a K = 7 rate 1/2 code with soft decisions does', () => {
		const rng = xorshift(77);
		const noise = gaussian(77);
		const ber = [1, 3, 5].map((ebn0) => {
			const sigma = Math.sqrt(1 / (2 * 10 ** ((ebn0 - 3.0103) / 10)));
			let errs = 0,
				bits = 0;
			for (let f = 0; f < 40; f++) {
				const info = randomInfo(rng);
				const d = decodeFrame(softOf(encodeFrame(info), sigma, noise));
				for (let i = 0; i < FRAME_BYTES - 1; i++) errs += popcount(d.bytes[i] ^ info[i]);
				bits += (FRAME_BYTES - 1) * 8;
			}
			return errs / bits;
		});
		// published: about 1e-5 at 4.4 dB and 1e-3 near 3 dB
		expect(ber[2]).toBeLessThan(3e-4);
		expect(ber[1]).toBeGreaterThan(5e-5);
		expect(ber[1]).toBeLessThan(2e-2);
		expect(ber[0]).toBeGreaterThan(ber[1]);
	});

	it('finds and repairs a polarity flip inside a frame, and invents none in noise', () => {
		const info = randomInfo(xorshift(5));
		const sym = encodeFrame(info);
		const noise = gaussian(9);
		for (const startRev of [false, true])
			for (const slipAt of [10, 30, 55]) {
				const soft = softOf(sym, 0.3, noise);
				for (let i = 0; i < FRAME_SYMS; i++) if (Math.floor(i / COLS) >= slipAt !== startRev) soft[i] = -soft[i];
				const d = Uint8Array.from(
					{ length: ROWS },
					(_, q) => Number(soft[q * COLS] > 0 !== !!UW[q]) + Number(soft[q * COLS + 1] > 0 !== !!UW[q]),
				);
				const fit = uwFit(d);
				expect(fit).toEqual({ errors: 0, startRev, slipRow: slipAt });
				for (let i = 0; i < FRAME_SYMS; i++) if (Math.floor(i / COLS) >= fit.slipRow !== fit.startRev) soft[i] = -soft[i];
				expect(sameData(decodeFrame(soft).bytes, info)).toBe(true);
			}
		expect(uwFit(new Uint8Array(ROWS))).toEqual({ errors: 0, startRev: false, slipRow: ROWS });
		expect(uwFit(new Uint8Array(ROWS).fill(2))).toEqual({ errors: 0, startRev: true, slipRow: ROWS });
		const rng = xorshift(3);
		let falseFlips = 0;
		for (let t = 0; t < 2000; t++) {
			const d = Uint8Array.from({ length: ROWS }, () => Number(rng() % 100 < 15) + Number(rng() % 100 < 15));
			const fit = uwFit(d);
			if (fit.errors < 128 && fit.slipRow !== ROWS) falseFlips++;
		}
		expect(falseFlips).toBe(0);
	});
});
