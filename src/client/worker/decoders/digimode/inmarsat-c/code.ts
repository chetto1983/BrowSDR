// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/inmc/inmc_code.cpp and core/include/dect2/inmc/inmc_code.h,
// https://github.com/adswill/OnAir; see third_party/onair. Changes: the Viterbi survivors are kept as two 32-bit words per
// step; the frame buffers are typed arrays allocated per call.
//
// Inmarsat-C TDM frame coding: unique word, scrambler, rate 1/2 K = 7 convolutional code, interleaver, packet check bytes.
// The frame is 640 bytes (639 of data and a flush byte), 8.64 s at 1200 symbols/s: 10240 coded symbols plus 128 unique
// word symbols. OnAir's sources (facts only): the layout, the unique word, the row permutation, the scrambler and the check
// bytes follow the open decoder "inmarsatc" (Scytale-C library), which cites Calcutt and Tetley, Satellite communications,
// and the Nera Inmarsat-C service manual.

import type { InmcFrameDecode, InmcUwFit } from './types';

export const FRAME_BYTES = 640;
/** Interleaver block as sent: 64 rows of 2 unique word symbols and 160 data symbols. */
export const ROWS = 64;
export const COLS = 162;
export const DATA_COLS = 160;
export const FRAME_SYMS = ROWS * COLS;
export const CODED_SYMS = ROWS * DATA_COLS;
export const SYMBOL_RATE = 1200;
export const FRAME_SECONDS = 8.64;

/** Unique word: one bit per row, sent twice at the start of each row, rows in transmission order (inmarsatc nrmPolUwPattern). */
export const UW = Uint8Array.of(
	0,
	0,
	0,
	0,
	0,
	1,
	1,
	1,
	1,
	1,
	1,
	0,
	1,
	0,
	1,
	0,
	1,
	1,
	0,
	0,
	1,
	1,
	0,
	1,
	1,
	1,
	0,
	1,
	1,
	0,
	1,
	0,
	0,
	1,
	0,
	0,
	1,
	1,
	1,
	0,
	0,
	0,
	1,
	0,
	1,
	1,
	1,
	1,
	0,
	0,
	1,
	0,
	1,
	0,
	0,
	0,
	1,
	1,
	0,
	0,
	0,
	0,
	1,
	0,
);

/** Row j of the transmitted block carries row (39 j) mod 64 of the interleaver matrix; the coded stream is written down the columns. */
export const matrixRowOfTxRow = (j: number): number => (j * 39) & 63;

const parity = (v: number): number => {
	let x = v ^ (v >> 4);
	x ^= x >> 2;
	x ^= x >> 1;
	return x & 1;
};

/** Scrambler groups (x^7 + x^5 + x^4 + x^3, start 0x80, output bit 0) and the code's output pairs. */
const FLAGS = (() => {
	const flags = new Uint8Array(160);
	let r = 0x80;
	for (let g = 0; g < 160; g++) {
		flags[g] = r & 1;
		const fb = (r & 1) ^ ((r >> 2) & 1) ^ ((r >> 3) & 1) ^ ((r >> 4) & 1);
		r = (r >> 1) | (fb << 7);
	}
	return flags;
})();
const OUT = Uint8Array.from({ length: 128 }, (_, s) => (parity(s & 0x6d) << 1) | parity(s & 0x4f));

/** 1 when the scrambler complements group `group` (4 bytes) of the frame. */
export const scramblerFlag = (group: number): number => FLAGS[group];

/** Complements the flagged groups of the 640 bytes; the same call descrambles. */
export function scrambleBytes(b: Uint8Array): void {
	for (let g = 0; g < 160; g++) if (FLAGS[g]) for (let k = 0; k < 4; k++) b[g * 4 + k] = ~b[g * 4 + k] & 0xff;
}

/**
 * Convolutional code: constraint length 7, polynomials 0x6d and 0x4f with the newest bit in the lowest position (the K = 7
 * NASA code with the bit order reversed). Bit 1 of the result is the first symbol, bit 0 the second.
 */
export const convOutput = (reg7: number): number => OUT[reg7 & 127];

/** Frame bytes (the last one is ignored, the flush byte is sent as zero) to the 10368 symbols (0 or 1) in transmission order. */
export function encodeFrame(info: Uint8Array): Uint8Array {
	const b = info.slice(0, FRAME_BYTES);
	scrambleBytes(b);
	b[FRAME_BYTES - 1] = 0; // the flush byte is added after scrambling so that the encoder ends in state 0
	const coded = new Uint8Array(CODED_SYMS);
	let reg = 0;
	let k = 0;
	for (let n = 0; n < FRAME_BYTES; n++)
		for (let bit = 0; bit < 8; bit++) {
			reg = ((reg << 1) | ((b[n] >> bit) & 1)) & 127;
			coded[k++] = OUT[reg] >> 1;
			coded[k++] = OUT[reg] & 1;
		}
	const sym = new Uint8Array(FRAME_SYMS);
	for (let j = 0; j < ROWS; j++) {
		const i = matrixRowOfTxRow(j);
		const p = j * COLS;
		sym[p] = sym[p + 1] = UW[j];
		for (let c = 0; c < DATA_COLS; c++) sym[p + 2 + c] = coded[c * ROWS + i];
	}
	return sym;
}

/** Unique word errors of the frame whose first symbol is hard[offset]: 128 compares, normal polarity. */
export function uwErrors(hard: Uint8Array, offset = 0): number {
	let e = 0;
	for (let r = 0; r < ROWS; r++) e += Number(hard[offset + r * COLS] !== UW[r]) + Number(hard[offset + r * COLS + 1] !== UW[r]);
	return e;
}

/**
 * The unique word fit that allows one polarity flip inside the frame (a cycle slip of the carrier loop): d[r] is the
 * number of the two unique word symbols of row r that disagree with the normal polarity. The fewest wrong symbols over:
 * normal or reversed all through, or a flip before row slipRow. A flip must save at least 8 symbols over the plain fit,
 * so that noise does not invent one.
 */
export function uwFit(d: Uint8Array): InmcUwFit {
	let all = 0;
	for (let r = 0; r < ROWS; r++) all += d[r];
	let startRev = all > ROWS;
	let slipRow = ROWS;
	let best = startRev ? 2 * ROWS - all : all;
	const plain = best;
	for (let rev = 0; rev < 2; rev++) {
		let c = 0; // wrong symbols so far when the frame starts with polarity rev and flips before row k
		let tail = 0; // wrong symbols of the rows from k on, in the flipped polarity
		for (let r = 0; r < ROWS; r++) tail += rev ? d[r] : 2 - d[r];
		for (let k = 1; k < ROWS; k++) {
			c += rev ? 2 - d[k - 1] : d[k - 1];
			tail -= rev ? d[k - 1] : 2 - d[k - 1];
			if (c + tail + 8 <= plain && c + tail < best) {
				best = c + tail;
				slipRow = k;
				startRev = rev !== 0;
			}
		}
	}
	return { errors: best, startRev, slipRow };
}

/** Deinterleaves the 10368 soft values (transmission order) into the coded stream; returns the unique word errors. */
function deinterleave(soft: Float32Array, coded: Float32Array): number {
	let uwErr = 0;
	for (let j = 0; j < ROWS; j++) {
		const i = matrixRowOfTxRow(j);
		const p = j * COLS;
		const u = UW[j] !== 0;
		uwErr += Number(soft[p] > 0 !== u) + Number(soft[p + 1] > 0 !== u);
		for (let c = 0; c < DATA_COLS; c++) coded[c * ROWS + i] = soft[p + 2 + c];
	}
	return uwErr;
}

/** Viterbi, 64 states (last six bits, newest lowest), from state 0 to state 0 (the flush byte): the decided bits and the path metric. */
function viterbi(coded: Float32Array, bits: Uint8Array): number {
	const nb = CODED_SYMS / 2;
	const decLo = new Uint32Array(nb);
	const decHi = new Uint32Array(nb);
	let pm = new Float64Array(64).fill(-1e30);
	let nm = new Float64Array(64);
	pm[0] = 0;
	const bm = new Float64Array(4);
	for (let t = 0; t < nb; t++) {
		const s0 = coded[2 * t],
			s1 = coded[2 * t + 1];
		bm[0] = -s0 - s1;
		bm[1] = -s0 + s1;
		bm[2] = s0 - s1;
		bm[3] = s0 + s1;
		let lo = 0,
			hi = 0;
		for (let ns = 0; ns < 64; ns++) {
			const p0 = ns >> 1;
			const r = (p0 << 1) | (ns & 1);
			const m0 = pm[p0] + bm[OUT[r]];
			const m1 = pm[p0 | 32] + bm[OUT[r | 64]];
			if (m1 > m0) {
				nm[ns] = m1;
				if (ns < 32) lo |= 1 << ns;
				else hi |= 1 << (ns - 32);
			} else nm[ns] = m0;
		}
		decLo[t] = lo;
		decHi[t] = hi;
		[pm, nm] = [nm, pm];
		if ((t & 63) === 63) {
			let mx = pm[0];
			for (let s = 1; s < 64; s++) mx = Math.max(mx, pm[s]);
			for (let s = 0; s < 64; s++) pm[s] -= mx;
		}
	}
	let st = 0;
	for (let t = nb - 1; t >= 0; t--) {
		bits[t] = st & 1;
		const p0 = st >> 1;
		const d = st < 32 ? (decLo[t] >>> st) & 1 : (decHi[t] >>> (st - 32)) & 1;
		st = d ? p0 | 32 : p0;
	}
	return pm[0];
}

/** soft: 10368 values in transmission order, positive for symbol 1. The polarity must already be right (see uwFit). */
export function decodeFrame(soft: Float32Array): InmcFrameDecode {
	const coded = new Float32Array(CODED_SYMS);
	const uw = deinterleave(soft, coded);
	const bits = new Uint8Array(CODED_SYMS / 2);
	const pathMetric = viterbi(coded, bits);
	const bytes = new Uint8Array(FRAME_BYTES);
	for (let n = 0; n < FRAME_BYTES; n++) {
		let v = 0;
		for (let bit = 0; bit < 8; bit++) v |= bits[n * 8 + bit] << bit;
		bytes[n] = v;
	}
	// channel symbol errors: re-encode the decoded bits and compare with the signs received
	let se = 0;
	let reg = 0;
	for (let t = 0; t < CODED_SYMS / 2; t++) {
		reg = ((reg << 1) | bits[t]) & 127;
		const o = OUT[reg];
		se += Number(((o >> 1) & 1) !== Number(coded[2 * t] > 0)) + Number((o & 1) !== Number(coded[2 * t + 1] > 0));
	}
	scrambleBytes(bytes);
	return { bytes, uwErrors: uw, symbolErrors: se, pathMetric };
}

/** inmarsatc PacketDecoder::computeCRC: the two check bytes count as zero; both sums run over all `len` bytes. */
function sums(p: Uint8Array, at: number, len: number): [number, number] {
	let c0 = 0,
		c1 = 0;
	for (let i = 0; i < len; i++) {
		c0 = (c0 + (i < len - 2 ? p[at + i] : 0)) & 0xffff;
		c1 = (c1 + c0) & 0xffff;
	}
	return [c0, c1];
}

/** Sets the two check bytes of the packet of `len` bytes at `at` (the last two are the check bytes). */
export function packetCheckSet(p: Uint8Array, len: number, at = 0): void {
	const [c0, c1] = sums(p, at, len);
	p[at + len - 2] = (c0 - c1) & 0xff;
	p[at + len - 1] = (c1 - 2 * c0) & 0xff;
}

export function packetCheckOk(p: Uint8Array, len: number, at = 0): boolean {
	if (len < 3) return false;
	const [c0, c1] = sums(p, at, len);
	return p[at + len - 2] === ((c0 - c1) & 0xff) && p[at + len - 1] === ((c1 - 2 * c0) & 0xff);
}
