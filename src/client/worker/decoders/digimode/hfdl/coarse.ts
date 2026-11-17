// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/hfdl/hfdl_rx.cpp (HfdlReceiver::Impl: coarseRefs, coarseSoa,
// coarse), https://github.com/adswill/OnAir; see third_party/onair. Changes: the same measure computed another way, for
// JavaScript: OnAir multiplies every search position's 254 samples by the reference turned by each of the 9 trial
// offsets (vectorised over the offsets); here every sample is turned by each offset once, the magnitude of a chunk
// is computed once per (sample, chunk, offset) and kept, as every sample starts one chunk for 32 search positions, and
// the 8 signed terms of a chunk are the sum of two entries of tables of signed sums of four. The magnitudes and the
// measure are the same (up to rounding).
//
// The burst search correlates A1 + A2 in 8-symbol chunks added without their phase, against the reference turned by 9
// trial offsets 100 Hz apart, so a carrier off by a few hundred Hz does not matter. The magnitude of a chunk does not
// depend on the phase it starts from: the samples are turned by the trial offset from a fixed time (t mod 72 samples
// is a whole number of turns of every offset), and a chunk is the sum of its 8 samples with the reference's signs.

import type { HfdlSamples } from './front';
import { SPS } from './front';
import { A_LEN, HFDL_BAUD, preambleRef } from './phy';

/** A1 + A2. */
export const SEARCH_SYMS = 2 * A_LEN;
const CHUNK = 8;
const CHUNKS = Math.ceil(SEARCH_SYMS / CHUNK);
/** Trial offsets of the coarse search: -4 .. 4 steps of 100 Hz (+-400 Hz in 8-symbol chunks). */
const HYP = 9;
const COARSE_STEP = 100;
/** Blind preamble correlation: noise alone averages 1/sqrt(8) = 0.35 per hypothesis, more as the best of 9. */
export const COARSE_THR = 0.5;
/** Samples after which every trial offset has turned a whole number of times (100 Hz at 7200 Hz: 72). */
const PERIOD = (SPS * HFDL_BAUD) / COARSE_STEP;
/** The kept magnitudes: a ring of samples, enough for the span of one position (31 chunks of 32 samples). */
const RING = 1024;

const REF = preambleRef(0);
/** The reference's signs of a chunk's first and last four symbols (bit set: -1); symbols past A2 count as +1. */
const signs = (q0: number): number => {
	let v = 0;
	for (let j = 0; j < 4; j++) if (q0 + j < SEARCH_SYMS && REF[q0 + j] < 0) v |= 1 << j;
	return v;
};
/** Per chunk, where its two halves are in the table of signed sums (QR / QI); the last chunk holds 6 symbols, its
 * second half is the pair of symbols 4 and 5 alone (entries 32 .. 35). */
const LO = Uint8Array.from({ length: CHUNKS }, (_, c) => signs(c * CHUNK));
const HI = Uint8Array.from({ length: CHUNKS }, (_, c) => (c === CHUNKS - 1 ? 32 + (signs(c * CHUNK + 4) & 3) : 16 + signs(c * CHUNK + 4)));
/** e^{-j 2 pi f t} of trial offset h (0 .. 8: -400 .. 400 Hz) at sample t mod PERIOD. */
const ROT_RE = new Float64Array(HYP * PERIOD);
const ROT_IM = new Float64Array(HYP * PERIOD);
for (let h = 0; h < HYP; h++)
	for (let t = 0; t < PERIOD; t++) {
		const ph = (-2 * Math.PI * (h - 4) * COARSE_STEP * t) / (SPS * HFDL_BAUD);
		ROT_RE[h * PERIOD + t] = Math.cos(ph);
		ROT_IM[h * PERIOD + t] = Math.sin(ph);
	}

/** Signed sums of the quads: QR[16 g + k] for the first (g 0) or second (g 1) four symbols with signs k; then those of
 * the pair of symbols 4 and 5. */
const QR = new Float64Array(36);
const QI = new Float64Array(36);
/** Signed sums of a pair: PR[4 p + k], k: bit 0 the first negated, bit 1 the second. */
const PR = new Float64Array(16);
const PI = new Float64Array(16);
const SUM = new Float64Array(HYP);
const SLOTS = new Int32Array(CHUNK);

/** The coarse preamble measure of OnAir, with its chunk magnitudes and turned samples kept between search positions. */
export class CoarseSearch {
	private readonly stamp = new Float64Array(RING).fill(-1);
	private readonly mag = new Float32Array(RING * CHUNKS * HYP);
	/** The samples turned by every trial offset, by absolute sample: [h][slot]. */
	private readonly vStamp = new Float64Array(RING).fill(-1);
	private readonly vr = new Float64Array(RING * HYP);
	private readonly vi = new Float64Array(RING * HYP);

	/**
	 * The measure at absolute sample s: the best over the trial offsets of the chunk magnitudes summed, over the summed
	 * |x|; 0 when the samples are not all in (two symbols more than the preamble, for the chunk tables).
	 */
	measure(x: HfdlSamples, s: number): number {
		const i0 = s - x.base;
		if (i0 < 0 || i0 + (SEARCH_SYMS + 1) * SPS >= x.len) return 0;
		let sumA = 0;
		for (let q = 0; q < SEARCH_SYMS; q++) sumA += x.mag[i0 + q * SPS];
		if (sumA <= 1e-6 * SEARCH_SYMS) return 0;
		SUM.fill(0);
		for (let c = 0; c < CHUNKS; c++) {
			const a = s + c * CHUNK * SPS;
			const slot = a & (RING - 1);
			if (this.stamp[slot] !== a) this.fill(x, a, slot);
			const at = (slot * CHUNKS + c) * HYP;
			for (let h = 0; h < HYP; h++) SUM[h] += this.mag[at + h];
		}
		let best = 0;
		for (let h = 0; h < HYP; h++) best = Math.max(best, SUM[h]);
		return best / sumA;
	}

	/** Forgets what was kept (the samples were replaced). */
	clear(): void {
		this.stamp.fill(-1);
		this.vStamp.fill(-1);
	}

	/** Sample b turned by every trial offset, kept at its slot. */
	private turn(x: HfdlSamples, b: number): number {
		const slot = b & (RING - 1);
		if (this.vStamp[slot] === b) return slot;
		this.vStamp[slot] = b;
		const re = x.re[b - x.base];
		const im = x.im[b - x.base];
		const t = b % PERIOD;
		for (let h = 0; h < HYP; h++) {
			const r = h * PERIOD + t;
			this.vr[h * RING + slot] = re * ROT_RE[r] - im * ROT_IM[r];
			this.vi[h * RING + slot] = re * ROT_IM[r] + im * ROT_RE[r];
		}
		return slot;
	}

	/** The magnitudes of every chunk and trial offset starting at sample a. */
	private fill(x: HfdlSamples, a: number, slot: number): void {
		this.stamp[slot] = a;
		for (let j = 0; j < CHUNK; j++) SLOTS[j] = this.turn(x, a + j * SPS);
		for (let h = 0; h < HYP; h++) {
			for (let p = 0; p < 4; p++) pair(p, this.vr, this.vi, h * RING + SLOTS[2 * p], h * RING + SLOTS[2 * p + 1]);
			quads();
			const out = slot * CHUNKS * HYP + h;
			for (let c = 0; c < CHUNKS; c++) {
				const re = QR[LO[c]] + QR[HI[c]];
				const im = QI[LO[c]] + QI[HI[c]];
				this.mag[out + c * HYP] = Math.sqrt(re * re + im * im);
			}
		}
	}
}

/** The four signed sums of pair p from the turned samples at ka and kb. */
function pair(p: number, vr: Float64Array, vi: Float64Array, ka: number, kb: number): void {
	const o = 4 * p;
	PR[o] = vr[ka] + vr[kb];
	PI[o] = vi[ka] + vi[kb];
	PR[o + 1] = vr[kb] - vr[ka];
	PI[o + 1] = vi[kb] - vi[ka];
	PR[o + 2] = -PR[o + 1];
	PI[o + 2] = -PI[o + 1];
	PR[o + 3] = -PR[o];
	PI[o + 3] = -PI[o];
}

/** The 16 signed sums of each half from its two pairs, then the pair of symbols 4 and 5. */
function quads(): void {
	for (let g = 0; g < 2; g++)
		for (let k = 0; k < 16; k++) {
			const a = 8 * g + (k & 3);
			const b = 8 * g + 4 + (k >> 2);
			QR[16 * g + k] = PR[a] + PR[b];
			QI[16 * g + k] = PI[a] + PI[b];
		}
	for (let k = 0; k < 4; k++) {
		QR[32 + k] = PR[8 + k];
		QI[32 + k] = PI[8 + k];
	}
}
