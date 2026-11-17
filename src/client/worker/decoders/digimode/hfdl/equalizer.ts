// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/hfdl/hfdl_rx.cpp (HfdlReceiver::Impl::burst: the half-symbol
// samples of a burst, and its equaliser modes 0 and 1 with the run() step), https://github.com/adswill/OnAir; see
// third_party/onair. Changes: the equaliser state lives in a small class over typed arrays instead of a closure over
// vectors; complex values are pairs of numbers.
//
// An adaptive equaliser: fractionally spaced (25 taps at half a symbol) with 6 decision feedback taps, normalised LMS,
// trained on the preamble (twice) and the 15-symbol probes, running on decisions in the data, with a phase loop. With
// the taps frozen at the gain found on A1 + A2 it is a gain and phase tracker (mode 1, for weak bursts, where 25 taps
// adapt to the noise).

import type { HfdlSamples } from './front';
import { SPS } from './front';
import { BLOCK_LEN, DATA_LEN, HFDL_BAUD, PRE_LEN, T_LEN, T_SEQ, burstSyms, hfdlRate, preambleRef, pskDecide, pskIm, pskRe } from './phy';
import type { HfdlBurstSamples, HfdlEqualised, HfdlPreamble } from './types';

/** Feed-forward taps each side, half a symbol apart. */
export const EQ_L = 12;
const NF = 2 * EQ_L + 1;
/** Feedback taps. */
const NB = 6;
/** Normalised LMS steps on decisions and on the probes. */
const MU_D = 0.15;
const MU_P = 0.5;
const tmp = new Float64Array(2);

/** The samples of the burst at half-symbol spacing, turned by its carrier offset; `off` and `slope` correct the timing (symbols). */
export function burstSamples(x: HfdlSamples, pre: HfdlPreamble, off = 0, slope = 0): HfdlBurstSamples {
	const nsym = burstSyms(pre.m1);
	const nu = 2 * nsym + 4 * EQ_L + 4;
	const uoff = 2 * EQ_L + 2;
	const re = new Float32Array(nu);
	const im = new Float32Array(nu);
	for (let m = 0; m < nu; m++) {
		const si = (m - uoff) / 2;
		x.cubicAt(pre.t0 + (si + off + slope * si) * SPS, tmp);
		const ph = Math.fround((-2 * Math.PI * pre.cfoHz * si) / HFDL_BAUD);
		const c = Math.cos(ph);
		const s = Math.sin(ph);
		re[m] = tmp[0] * c - tmp[1] * s;
		im[m] = tmp[0] * s + tmp[1] * c;
	}
	let pw = 0;
	for (let i = 0; i < PRE_LEN; i++) pw += re[uoff + 2 * i] ** 2 + im[uoff + 2 * i] ** 2;
	return { re, im, uoff, nsym, pw: pw / PRE_LEN };
}

/** One run of the equaliser over a burst. */
class Lms {
	private readonly wr = new Float64Array(NF);
	private readonly wi = new Float64Array(NF);
	private readonly br = new Float64Array(NB);
	private readonly bi = new Float64Array(NB);
	readonly dr = new Float64Array(NB);
	readonly di = new Float64Array(NB);
	theta = 0;
	errKnown = 0;
	nKnown = 0;
	/** The output of the last step. */
	zr = 0;
	zi = 0;

	constructor(
		private readonly u: HfdlBurstSamples,
		private readonly eqOn: boolean,
		private readonly bps: number,
		private readonly scr: Int8Array,
		hRe: number,
		hIm: number,
	) {
		const n = hRe * hRe + hIm * hIm + 1e-30;
		this.wr[EQ_L] = hRe / n;
		this.wi[EQ_L] = -hIm / n;
	}

	/** The filter output at symbol i and the norm of its input, into zr, zi; returns the norm. */
	private filter(i: number): number {
		const { re, im } = this.u;
		const base = this.u.uoff + 2 * i - EQ_L;
		let yr = 0;
		let yi = 0;
		let nrm = 1e-9;
		for (let q = 0; q < NF; q++) {
			const vr = re[base + q];
			const vi = im[base + q];
			yr += this.wr[q] * vr - this.wi[q] * vi;
			yi += this.wr[q] * vi + this.wi[q] * vr;
			nrm += vr * vr + vi * vi;
		}
		for (let q = 0; q < NB; q++) {
			yr += this.br[q] * this.dr[q] - this.bi[q] * this.di[q];
			yi += this.br[q] * this.di[q] + this.bi[q] * this.dr[q];
			nrm += this.dr[q] * this.dr[q] + this.di[q] * this.di[q];
		}
		const c = Math.cos(-this.theta);
		const s = Math.sin(-this.theta);
		this.zr = yr * c - yi * s;
		this.zi = yr * s + yi * c;
		return nrm;
	}

	/** The taps move by g E conj(v) (E: the error turned back by the phase loop). */
	private adapt(i: number, g: number, er: number, ei: number): void {
		const { re, im } = this.u;
		const base = this.u.uoff + 2 * i - EQ_L;
		for (let q = 0; q < NF; q++) {
			const vr = re[base + q];
			const vi = im[base + q];
			this.wr[q] += g * (er * vr + ei * vi);
			this.wi[q] += g * (ei * vr - er * vi);
		}
		for (let q = 0; q < NB; q++) {
			this.br[q] += g * (er * this.dr[q] + ei * this.di[q]);
			this.bi[q] += g * (ei * this.dr[q] - er * this.di[q]);
		}
	}

	/** One symbol: a known one (ref) or a decision on data symbol di; the output in zr, zi. */
	run(i: number, known: boolean, ref: number, mu: number, di: number): void {
		const nrm = this.filter(i);
		const { zr, zi } = this;
		let dRe = ref;
		let dIm = 0;
		if (!known) {
			const sg = this.scr[di];
			const v = pskDecide(this.bps, zr * sg, zi * sg);
			dRe = pskRe(this.bps, v) * sg;
			dIm = pskIm(this.bps, v) * sg;
		}
		const er = dRe - zr;
		const ei = dIm - zi;
		if (known) {
			this.errKnown += er * er + ei * ei;
			this.nKnown++;
		}
		if (this.eqOn) {
			// E = e conj(rr), rr = e^{-j theta}
			const c = Math.cos(this.theta);
			const s = Math.sin(this.theta);
			this.adapt(i, mu / nrm, er * c - ei * s, er * s + ei * c);
		}
		this.theta += (0.03 * (zi * dRe - zr * dIm)) / (dRe * dRe + dIm * dIm + 1e-9);
		this.dr.copyWithin(1, 0, NB - 1);
		this.di.copyWithin(1, 0, NB - 1);
		this.dr[0] = dRe;
		this.di[0] = dIm;
	}
}

/** Mode 0 (eqOn: the adaptive equaliser) or mode 1 (the gain and phase tracker) over the burst. */
export function equalise(u: HfdlBurstSamples, pre: HfdlPreamble, eqOn: boolean, scr: Int8Array): HfdlEqualised {
	const rate = hfdlRate(pre.m1);
	const ref = preambleRef(pre.m1);
	const lms = new Lms(u, eqOn, rate.bitsPerSym, scr, pre.hRe, pre.hIm);
	for (let pass = 0; pass < 2; pass++) {
		lms.dr.fill(0);
		lms.di.fill(0);
		lms.theta = 0;
		lms.errKnown = lms.nKnown = 0;
		for (let i = 0; i < PRE_LEN; i++) lms.run(i, true, ref[i], pass === 0 ? 0.25 : 0.1, 0);
	}
	const probeErr = new Float64Array(rate.blocks + 1);
	probeErr[0] = lms.errKnown / Math.max(1, lms.nKnown);
	lms.errKnown = lms.nKnown = 0;
	const nd = rate.blocks * DATA_LEN;
	const re = new Float32Array(nd);
	const im = new Float32Array(nd);
	let di = 0;
	for (let blk = 0; blk < rate.blocks; blk++) {
		const i0 = PRE_LEN + blk * BLOCK_LEN;
		for (let q = 0; q < DATA_LEN; q++, di++) {
			lms.run(i0 + q, false, 0, MU_D, di);
			re[di] = lms.zr * scr[di];
			im[di] = lms.zi * scr[di];
		}
		const e0 = lms.errKnown;
		const n0 = lms.nKnown;
		for (let q = 0; q < T_LEN; q++) lms.run(i0 + DATA_LEN + q, true, T_SEQ[q], MU_P, 0);
		probeErr[blk + 1] = (lms.errKnown - e0) / Math.max(1, lms.nKnown - n0);
	}
	return { re, im, probeErr, sig2: Math.max(1e-4, lms.errKnown / Math.max(1, lms.nKnown)) };
}
