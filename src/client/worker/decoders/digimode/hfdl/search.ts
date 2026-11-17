// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/hfdl/hfdl_rx.cpp (HfdlReceiver::Impl: refProducts, corrAt,
// and the preamble part of burst(): the frequency search, timing, the A1 to A2 phase step, the coherence check and M1),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: the rotations of the frequency search are tabled;
// the estimate returns what it found and the receiver moves the search position, as burst() does in OnAir.
//
// A preamble found by the coarse search (coarse.ts) gets its carrier offset from a coherent search over +-250 Hz on
// A1 + A2 refined by the phase step from A1 to A2, its timing from the correlation peak, and its rate from M1 (8 cyclic
// shifts).

import { SEARCH_SYMS } from './coarse';
import type { HfdlSamples } from './front';
import { SPS } from './front';
import { A_LEN, HFDL_BAUD, M1_LEN, mBit, preambleRef } from './phy';
import type { HfdlPreamble } from './types';

const MAX_CFO = 250;
const CFO_STEP = 1.5;
const REF = preambleRef(0);

const tmp = new Float64Array(2);

/** y_k = ref_k * x(t0 + 4k), interpolated, for k < n. */
function refProducts(x: HfdlSamples, t0: number, n: number, yRe: Float64Array, yIm: Float64Array): void {
	for (let q = 0; q < n; q++) {
		x.cubicAt(t0 + q * SPS, tmp);
		yRe[q] = tmp[0] * REF[q];
		yIm[q] = tmp[1] * REF[q];
	}
}

/** sum over k0 <= k < k1 of y_k r^k, r = rc + j rs (one symbol's rotation), into out. */
function corrRot(yRe: Float64Array, yIm: Float64Array, rc: number, rs: number, k0: number, k1: number, out: Float64Array): void {
	const w = Math.atan2(rs, rc);
	let pc = k0 ? Math.cos(w * k0) : 1;
	let ps = k0 ? Math.sin(w * k0) : 0;
	let ar = 0;
	let ai = 0;
	for (let q = k0; q < k1; q++) {
		ar += yRe[q] * pc - yIm[q] * ps;
		ai += yRe[q] * ps + yIm[q] * pc;
		const n = pc * rc - ps * rs;
		ps = pc * rs + ps * rc;
		pc = n;
	}
	out[0] = ar;
	out[1] = ai;
}

/** sum over k0 <= k < k1 of y_k e^{-j 2 pi f k / 1800}, into out. */
function corrAt(yRe: Float64Array, yIm: Float64Array, f: number, k0: number, k1: number, out: Float64Array): void {
	const w = (-2 * Math.PI * f) / HFDL_BAUD;
	corrRot(yRe, yIm, Math.cos(w), Math.sin(w), k0, k1, out);
}

/** The frequency grid of the coherent search and the rotation of each of its frequencies. */
const GRID: number[] = [];
for (let f = -MAX_CFO; f <= MAX_CFO + 1e-9; f += CFO_STEP) GRID.push(f);
const GRID_C = Float64Array.from(GRID, (f) => Math.cos((-2 * Math.PI * f) / HFDL_BAUD));
const GRID_S = Float64Array.from(GRID, (f) => Math.sin((-2 * Math.PI * f) / HFDL_BAUD));

const yRe = new Float64Array(SEARCH_SYMS);
const yIm = new Float64Array(SEARCH_SYMS);
const c1 = new Float64Array(2);
const c2 = new Float64Array(2);
const mags = new Float64Array(GRID.length);

const absAt = (f: number): number => {
	corrAt(yRe, yIm, f, 0, SEARCH_SYMS, c1);
	return Math.hypot(c1[0], c1[1]);
};

/** Parabolic peak offset (in steps) from three values around a maximum; 0 when not a peak. */
function parabola(a: number, b: number, c: number): number {
	const den = a - 2 * b + c;
	return den < 0 ? (0.5 * (a - c)) / den : 0;
}

/** The coherent carrier search over +-250 Hz at the trial start s0: the offset, Hz. */
function frequency(x: HfdlSamples, s0: number): number {
	refProducts(x, s0, SEARCH_SYMS, yRe, yIm);
	let bf = 0;
	let bv = -1;
	const n = GRID.length;
	for (let i = 0; i < n; i++) {
		corrRot(yRe, yIm, GRID_C[i], GRID_S[i], 0, SEARCH_SYMS, c1);
		const v = Math.hypot(c1[0], c1[1]);
		mags[i] = v;
		if (v > bv) {
			bv = v;
			bf = GRID[i];
		}
	}
	const i = Math.round((bf + MAX_CFO) / CFO_STEP);
	if (i > 0 && i + 1 < n) bf += CFO_STEP * parabola(mags[i - 1], mags[i], mags[i + 1]);
	return bf;
}

/** The fractional start of A1 near s0 at the carrier offset bf. */
function timing(x: HfdlSamples, s0: number, bf: number): number {
	const tv = new Float64Array(5);
	for (let d = -2; d <= 2; d++) {
		refProducts(x, s0 + d, SEARCH_SYMS, yRe, yIm);
		tv[d + 2] = absAt(bf);
	}
	let bd = 2;
	for (let d = 0; d < 5; d++) if (tv[d] > tv[bd]) bd = d;
	let tau = bd - 2;
	if (bd > 0 && bd < 4) tau += parabola(tv[bd - 1], tv[bd], tv[bd + 1]);
	return s0 + tau;
}

/** The M1 shift (rate) that fits the symbols after A2 best, and its normalised score. */
function rateOf(x: HfdlSamples, t0: number, bf: number, hRe: number, hIm: number): { m1: number; score: number } {
	const msRe = new Float64Array(M1_LEN);
	let me = 0;
	for (let j = 0; j < M1_LEN; j++) {
		const i = SEARCH_SYMS + j;
		x.cubicAt(t0 + i * SPS, tmp);
		const ph = (-2 * Math.PI * bf * i) / HFDL_BAUD;
		const sr = tmp[0] * Math.cos(ph) - tmp[1] * Math.sin(ph);
		const si = tmp[0] * Math.sin(ph) + tmp[1] * Math.cos(ph);
		// * conj(h)
		msRe[j] = sr * hRe + si * hIm;
		const mi = si * hRe - sr * hIm;
		me += msRe[j] * msRe[j] + mi * mi;
	}
	let m1 = -1;
	let bs = -1e30;
	for (let sc = 0; sc < 8; sc++) {
		let sum = 0;
		for (let j = 0; j < M1_LEN; j++) sum += (mBit(sc, j) ? -1 : 1) * msRe[j];
		if (sum > bs) {
			bs = sum;
			m1 = sc;
		}
	}
	return { m1, score: bs / Math.sqrt(M1_LEN * me + 1e-30) };
}

/**
 * The preamble at the coarse peak s0: carrier offset, timing, gain and rate. 'coherence' when A1 + A2 do not add up
 * coherently, 'm1' when no M1 shift fits: not a preamble after all.
 */
export function estimate(x: HfdlSamples, s0: number): HfdlPreamble | 'coherence' | 'm1' {
	let bf = frequency(x, s0);
	const t0 = timing(x, s0, bf);
	refProducts(x, t0, SEARCH_SYMS, yRe, yIm);
	corrAt(yRe, yIm, bf, 0, A_LEN, c1);
	corrAt(yRe, yIm, bf, A_LEN, SEARCH_SYMS, c2);
	// arg(C2 conj(C1))
	const df = (Math.atan2(c2[1] * c1[0] - c2[0] * c1[1], c2[0] * c1[0] + c2[1] * c1[1]) * HFDL_BAUD) / (2 * Math.PI * A_LEN);
	if (Math.abs(df) < 6) bf += df;
	corrAt(yRe, yIm, bf, 0, SEARCH_SYMS, c1);
	const hRe = c1[0] / SEARCH_SYMS;
	const hIm = c1[1] / SEARCH_SYMS;
	let se = 0;
	for (let q = 0; q < SEARCH_SYMS; q++) se += yRe[q] * yRe[q] + yIm[q] * yIm[q];
	const call2 = c1[0] * c1[0] + c1[1] * c1[1];
	if (call2 < 0.3 * SEARCH_SYMS * se || hRe * hRe + hIm * hIm < 1e-12) return 'coherence';
	const { m1, score } = rateOf(x, t0, bf, hRe, hIm);
	if (score < 0.3) return 'm1';
	return { s0, t0, cfoHz: bf, hRe, hIm, m1 };
}
