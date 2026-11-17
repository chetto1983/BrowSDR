// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/inmc/inmc_rx.cpp (Chan: carrier search, carrier mixer, matched
// filter, Gardner timing recovery, Costas loop, Es/N0 estimate, the lock bookkeeping of report()),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: BrowSDR's channel filter has already moved the VFO to
// 0 Hz and cut the channel at the decoder's rate, so the channel mixer and the CIC decimator of OnAir's front end are left
// out (the decoder's rate is OnAir's first rate r1); the timing counters are rebased now and then so that they stay small;
// the band search for more channels (WideSearch) and the move of the tuned channel to a far carrier are left out.
//
// Chain: carrier search by squaring and an FFT (the squared BPSK signal has a line at twice the carrier offset, so +-20 kHz
// is found without a pilot), carrier mixer driven by a Costas loop, root raised cosine matched filter (roll-off 1) that also
// decimates to about 9.6 kHz, Gardner timing recovery with a cubic interpolator, soft symbols at 1200 symbols/s.

import { Fft } from '@/worker/decoders/dab/ofdm/fft';
import { SYMBOL_RATE } from './code';

/** FFT size of the carrier search. */
const ACQ_N = 32768;
/** Carrier loop noise bandwidth, Hz. */
const CARRIER_BN_HZ = 15;
/** Search range (a radio 10 ppm off at 1.54 GHz is 15 kHz away). */
export const MAX_CFO_HZ = 20000;
const TIMING_KP = 0.012;
const TIMING_KI = 0.00002;
/** Seconds without carrier lock after which the carrier is searched again. */
const RELOCK_SEC = 3;

/** One of the two carrier searches on the same samples: long blocks (weak signals), short ones (a drifting carrier stays in a bin). */
class Search {
	readonly fft: Fft;
	readonly win: Float64Array;
	readonly pw: Float64Array;
	readonly re: Float64Array;
	readonly im: Float64Array;
	blocks = 0;
	constructor(readonly n: number) {
		this.fft = new Fft(n);
		this.win = Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
		this.pw = new Float64Array(n);
		this.re = new Float64Array(n);
		this.im = new Float64Array(n);
	}
	clear(): void {
		this.pw.fill(0);
		this.blocks = 0;
	}
	/** Squares, windows, transforms and adds the power of `count` blocks of the samples. */
	accumulate(xr: Float32Array, xi: Float32Array, count: number): void {
		const n = this.n;
		for (let blk = 0; blk < count; blk++) {
			for (let i = 0; i < n; i++) {
				const a = xr[blk * n + i],
					b = xi[blk * n + i];
				this.re[i] = (a * a - b * b) * this.win[i];
				this.im[i] = 2 * a * b * this.win[i];
			}
			this.fft.forward(this.re, this.im);
			for (let i = 0; i < n; i++) this.pw[i] += this.re[i] * this.re[i] + this.im[i] * this.im[i];
			this.blocks++;
		}
	}
}

/** Root raised cosine, roll-off 1, +-3 symbols, with a Hann taper; unit gain at DC. */
function matchedFilter(sps: number): Float32Array {
	const half = Math.ceil(3 * sps);
	const taps = new Float64Array(2 * half + 1);
	let sum = 0;
	for (let i = -half; i <= half; i++) {
		const t = i / sps;
		let v: number;
		if (Math.abs(t) < 1e-9) v = 4 / Math.PI;
		else if (Math.abs(Math.abs(4 * t) - 1) < 1e-6)
			v = (1 / Math.SQRT2) * ((1 + 2 / Math.PI) * Math.sin(Math.PI / 4) + (1 - 2 / Math.PI) * Math.cos(Math.PI / 4));
		else v = (4 * t * Math.cos(2 * Math.PI * t)) / (Math.PI * t * (1 - 16 * t * t));
		v *= 0.5 + 0.5 * Math.cos((Math.PI * i) / (half + 1));
		taps[i + half] = v;
		sum += v;
	}
	return Float32Array.from(taps, (v) => v / sum);
}

/**
 * Peak over the floor around it: the sum of three neighbouring bins (a drifting or off-bin line spreads) against the same
 * sum in the bins 12 to 400 away; the squared noise is not flat, so a mean over all bins would give false lines near 0 Hz.
 * The thresholds are OnAir's (above the largest ratio of 150 to 500 runs of white noise). Returns the offset in Hz or null.
 */
function detect(sr: Search, rate: number, need: readonly number[], thr: readonly number[]): number | null {
	const lvl = need.indexOf(sr.blocks);
	if (lvl < 0) return null;
	const n = sr.n;
	const pw = sr.pw;
	const binHz = rate / n;
	const p3 = new Float64Array(n);
	for (let i = 0; i < n; i++) p3[i] = pw[(i + n - 1) % n] + pw[i] + pw[(i + 1) % n];
	let best = -1;
	let bv = 0;
	for (let i = 0; i < n; i++) {
		const k = i < n / 2 ? i : i - n;
		if (Math.abs(k * binHz) <= 2 * MAX_CFO_HZ && p3[i] > bv) {
			bv = p3[i];
			best = i;
		}
	}
	if (best < 0) return null;
	let fs = 0;
	for (let d = 12; d <= 400; d++) fs += p3[(best + d) % n] + p3[(best - d + n) % n];
	if (bv < (thr[lvl] * fs) / (2 * 389)) return null;
	// parabolic interpolation on the log power of the single bins
	const a = Math.log(pw[(best + n - 1) % n] + 1e-20),
		b = Math.log(pw[best] + 1e-20),
		c = Math.log(pw[(best + 1) % n] + 1e-20);
	const den = a - 2 * b + c;
	const d = Math.max(-1, Math.min(1, den < -1e-9 ? (0.5 * (a - c)) / den : 0));
	const k = best < n / 2 ? best : best - n;
	return ((k + d) * binHz) / 2;
}

/** Long blocks after 2, 4, 8, 16, 32 blocks; short blocks after 8, 16, 32, 64 (OnAir's thresholds over pure noise). */
const NEED_LONG = [2, 4, 8, 16, 32];
const THR_LONG = [9.0, 5.3, 3.8, 2.9, 2.2];
const NEED_SHORT = [8, 16, 32, 64];
const THR_SHORT = [4.2, 3.5, 2.6, 2.2];

/** The Inmarsat-C channel from complex baseband to soft symbols: carrier, matched filter, timing, carrier loop. */
export class InmcDemod {
	readonly r1: number;
	private readonly m: number;
	private readonly spsR1: number;
	private readonly tsNom: number;
	private readonly taps: Float32Array;
	private readonly lineRe: Float32Array;
	private readonly lineIm: Float32Array;
	private hpos = 0;
	private mcount = 0;
	// carrier
	acquired = false;
	carrierLock = false;
	private phase = 0;
	/** Carrier frequency in rad per symbol. */
	private wSym = 0;
	private lockEma = 0;
	private sinceLock = 0;
	private readonly acqRe = new Float32Array(ACQ_N);
	private readonly acqIm = new Float32Array(ACQ_N);
	private acqN = 0;
	private readonly longSearch = new Search(ACQ_N);
	private readonly shortSearch = new Search(ACQ_N / 4);
	// timing
	private readonly yRe = new Float32Array(32);
	private readonly yIm = new Float32Array(32);
	private n2 = 0;
	private nextPos = 0;
	private ts = 0;
	private prevRe = 0;
	private prevIm = 0;
	private agcPow = 1;
	// symbol statistics
	private m2 = 1;
	private m4 = 1;
	private esn0 = 0;
	private haveSnr = false;
	/** A new carrier was found since the caller last looked (Hz), or null. */
	found: number | null = null;

	/** `onSymbol` gets the soft decision of every symbol (in-phase arm, positive for 1). */
	constructor(
		rate: number,
		private readonly onSymbol: (soft: number) => void,
	) {
		this.r1 = rate;
		this.m = Math.max(1, Math.floor(rate / 9600));
		this.spsR1 = rate / SYMBOL_RATE;
		this.tsNom = rate / this.m / SYMBOL_RATE;
		this.taps = matchedFilter(this.spsR1);
		this.lineRe = new Float32Array(2 * this.taps.length);
		this.lineIm = new Float32Array(2 * this.taps.length);
		this.reset();
	}

	reset(): void {
		this.lineRe.fill(0);
		this.lineIm.fill(0);
		this.hpos = this.mcount = 0;
		this.restartSearch();
		this.lockEma = this.sinceLock = 0;
		this.yRe.fill(0);
		this.yIm.fill(0);
		this.n2 = 0;
		this.ts = this.tsNom;
		this.nextPos = 3 * this.tsNom;
		this.prevRe = this.prevIm = 0;
		this.agcPow = 1;
		this.m2 = this.m4 = 1;
		this.esn0 = 0;
		this.haveSnr = false;
		this.found = null;
	}

	/** Forget the carrier and look for it again. */
	restartSearch(): void {
		this.acquired = this.carrierLock = false;
		this.wSym = this.phase = 0;
		this.acqN = 0;
		this.longSearch.clear();
		this.shortSearch.clear();
	}

	/** Carrier error, Hz (0 while searching). */
	get cfoHz(): number {
		return this.acquired ? (this.wSym * SYMBOL_RATE) / (2 * Math.PI) : 0;
	}

	/** Es/N0 in dB while the carrier is locked, else 0. */
	get esn0Db(): number {
		return this.haveSnr && this.carrierLock ? 10 * Math.log10(Math.max(this.esn0, 1e-3)) : 0;
	}

	process(iq: Float32Array): void {
		const n = iq.length >> 1;
		for (let i = 0; i < n; i++) this.onR1(iq[2 * i], iq[2 * i + 1]);
	}

	/** Every report period: a carrier that never locked, or lost lock for good, is searched again. */
	tick(dt: number): boolean {
		if (!this.acquired || this.carrierLock) return false;
		this.sinceLock += dt;
		if (this.sinceLock <= RELOCK_SEC) return false;
		this.restartSearch();
		return true;
	}

	private onR1(xr: number, xi: number): void {
		if (!this.acquired) {
			this.acqRe[this.acqN] = xr;
			this.acqIm[this.acqN] = xi;
			if (++this.acqN === ACQ_N) {
				this.acquire();
				this.acqN = 0;
			}
		}
		const c = Math.cos(this.phase),
			s = Math.sin(this.phase);
		this.phase += this.wSym / this.spsR1;
		if (this.phase > Math.PI) this.phase -= 2 * Math.PI;
		else if (this.phase < -Math.PI) this.phase += 2 * Math.PI;
		const L = this.taps.length;
		const yr = xr * c + xi * s,
			yi = xi * c - xr * s;
		this.lineRe[this.hpos] = this.lineRe[this.hpos + L] = yr;
		this.lineIm[this.hpos] = this.lineIm[this.hpos + L] = yi;
		this.hpos = this.hpos + 1 === L ? 0 : this.hpos + 1;
		if (++this.mcount < this.m) return;
		this.mcount = 0;
		let re = 0,
			im = 0;
		const taps = this.taps;
		for (let k = 0, p = this.hpos; k < L; k++, p++) {
			re += taps[k] * this.lineRe[p];
			im += taps[k] * this.lineIm[p];
		}
		this.onR2(re, im);
	}

	private acquire(): void {
		this.longSearch.accumulate(this.acqRe, this.acqIm, 1);
		this.shortSearch.accumulate(this.acqRe, this.acqIm, 4);
		let f = detect(this.longSearch, this.r1, NEED_LONG, THR_LONG);
		if (f === null) f = detect(this.shortSearch, this.r1, NEED_SHORT, THR_SHORT);
		if (this.longSearch.blocks >= 48) this.longSearch.clear();
		if (this.shortSearch.blocks >= 96) this.shortSearch.clear();
		if (f === null) return;
		this.wSym = (2 * Math.PI * f) / SYMBOL_RATE;
		this.acquired = true;
		this.carrierLock = false;
		this.lockEma = this.sinceLock = 0;
		this.longSearch.clear();
		this.shortSearch.clear();
		this.found = f;
	}

	/** Cubic Lagrange interpolation of the r2 samples at `pos`. */
	private interp(pos: number): [number, number] {
		const i0 = Math.floor(pos);
		const mu = pos - i0;
		const c0 = (-mu * (mu - 1) * (mu - 2)) / 6,
			c1 = ((mu + 1) * (mu - 1) * (mu - 2)) / 2,
			c2 = (-(mu + 1) * mu * (mu - 2)) / 2,
			c3 = ((mu + 1) * mu * (mu - 1)) / 6;
		const a = (i0 - 1) & 31,
			b = i0 & 31,
			c = (i0 + 1) & 31,
			d = (i0 + 2) & 31;
		const y = this.yRe,
			z = this.yIm;
		return [y[a] * c0 + y[b] * c1 + y[c] * c2 + y[d] * c3, z[a] * c0 + z[b] * c1 + z[c] * c2 + z[d] * c3];
	}

	/** r2: slow gain control to unit mean power, then Gardner timing recovery. */
	private onR2(re: number, im: number): void {
		this.agcPow += 0.0005 * (re * re + im * im - this.agcPow);
		const g = 1 / Math.sqrt(this.agcPow + 1e-12);
		this.yRe[this.n2 & 31] = re * g;
		this.yIm[this.n2 & 31] = im * g;
		this.n2++;
		while (this.n2 - 1 >= Math.floor(this.nextPos) + 2) {
			const [cr, ci] = this.interp(this.nextPos);
			const [mr, mi] = this.interp(this.nextPos - 0.5 * this.ts);
			const e = mr * (cr - this.prevRe) + mi * (ci - this.prevIm);
			this.prevRe = cr;
			this.prevIm = ci;
			// the detector needs the carrier removed: until the carrier is found the clock runs free
			const ee = this.acquired ? Math.max(-2, Math.min(2, e)) : 0;
			this.nextPos += this.ts - TIMING_KP * ee;
			this.ts -= TIMING_KI * ee;
			this.ts = Math.max(this.tsNom * 0.997, Math.min(this.tsNom * 1.003, this.ts));
			this.symbol(cr, ci);
		}
		if (this.n2 >= 1 << 24) {
			// keep the counters small; the ring index (mod 32) does not change
			this.n2 -= 1 << 23;
			this.nextPos -= 1 << 23;
		}
	}

	/** Carrier loop, statistics, then the soft symbol. */
	private symbol(I: number, Q: number): void {
		if (this.acquired) this.costas(I, Q);
		const p2 = I * I + Q * Q;
		this.m2 += (p2 - this.m2) / 1024;
		this.m4 += (p2 * p2 - this.m4) / 1024;
		if (this.carrierLock) {
			const a = 2 * this.m2 * this.m2 - this.m4;
			const sig2 = 0.5 * (this.m2 - Math.sqrt(Math.max(a, 0)));
			const amp2 = this.m2 - 2 * sig2;
			if (sig2 > 1e-6 && amp2 > 0) {
				this.esn0 = amp2 / (2 * sig2);
				this.haveSnr = true;
			}
		}
		this.onSymbol(I);
	}

	private costas(I: number, Q: number): void {
		const bnT = CARRIER_BN_HZ / SYMBOL_RATE,
			zeta = 0.707;
		const th = bnT / (zeta + 1 / (4 * zeta));
		const den = 1 + 2 * zeta * th + th * th;
		const e = I * Q;
		this.phase += ((4 * zeta * th) / den) * e;
		this.wSym += ((4 * th * th) / den) * e;
		const lim = (2 * Math.PI * (MAX_CFO_HZ + 500)) / SYMBOL_RATE;
		this.wSym = Math.max(-lim, Math.min(lim, this.wSym));
		const nrm = I * I + Q * Q + 1e-9;
		this.lockEma += 0.01 * ((I * I - Q * Q) / nrm - this.lockEma);
		if (!this.carrierLock && this.lockEma > 0.25) {
			this.carrierLock = true;
			this.sinceLock = 0;
			this.m2 = nrm;
			this.m4 = nrm * nrm;
		} else if (this.carrierLock && this.lockEma < 0.1) this.carrierLock = false;
	}
}
