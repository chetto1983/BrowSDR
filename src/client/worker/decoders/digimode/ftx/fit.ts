// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/hfdig/hfdig_ftx.cpp (SlotDecoder::baseband, symbol, twiddles,
// syncMetric and the fine fit and tone amplitudes of tryCandidate: each candidate cut out of the slot's large FFT into a
// narrow complex baseband, WSJT-X's way, then fitted in time and frequency on its sync symbols),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: the sync metric correlates only the tones it uses
// (FT8 / FT4 the sync tone, WSPR all four), and over a run of start times slides each correlation one sample at a time
// instead of computing it anew: the same sums, to rounding, with fewer operations.

import type { SlotSearch } from './search';
import type { FtxCand, FtxFit, FtxLayout, FtxSymbols } from './types';
import { fftOf } from './search';

/** Frequency steps of the coarse fit: sixteenths of the spacing over +- half of it. */
const NFQ = 9;

/** Twiddle sets of a candidate: the nine coarse frequencies, three fine ones, the fit, the symbols. */
const SETS = NFQ + 5;

/** The candidate's fit and the tone correlations of its symbols. */
export class CandidateFit {
	readonly fit: FtxFit = { valid: false, yr: new Float64Array(0), yi: new Float64Array(0), kc: 0, bestT: 0, base: 0, dfr: 0, tfrac: 0 };
	private readonly nspsb: number;
	private readonly fsb: number;
	private readonly zr = new Float64Array(8);
	private readonly zi = new Float64Array(8);
	/** exp(-j 2 pi (c sp + base + dfr) n / fsb) for tone c and sample n of a symbol (c * nspsb + n), one set per use. */
	private readonly wr: Float64Array[] = [];
	private readonly wi: Float64Array[] = [];
	private readonly syncK: Int32Array;
	private readonly syncT: Int32Array;
	private readonly amp: Float64Array;
	private readonly szr: Float64Array;
	private readonly szi: Float64Array;
	private readonly metrics = new Float64Array(64);

	constructor(
		private readonly S: SlotSearch,
		private readonly L: FtxLayout,
		private readonly wspr: boolean,
	) {
		this.nspsb = L.nsps / L.ndown;
		this.fsb = L.rate / L.ndown;
		for (let i = 0; i < SETS; i++) {
			this.wr.push(new Float64Array(L.nt * this.nspsb));
			this.wi.push(new Float64Array(L.nt * this.nspsb));
		}
		this.syncK = Int32Array.from(L.sync, ([k]) => k);
		this.syncT = Int32Array.from(L.sync, ([, t]) => t);
		this.amp = new Float64Array(L.nsym * L.nt);
		this.szr = new Float64Array(L.nsym * L.nt);
		this.szi = new Float64Array(L.nsym * L.nt);
	}

	/** Twiddle set `set` for a frequency offset dfr from the candidate's base. */
	private twiddles(set: number, base: number, dfr: number): number {
		const { L, nspsb, fsb } = this;
		const [wr, wi] = [this.wr[set], this.wi[set]];
		for (let c = 0; c < L.nt; c++)
			for (let n = 0; n < nspsb; n++) {
				const ph = (-2 * Math.PI * (c * L.sp + base + dfr) * n) / fsb;
				wr[c * nspsb + n] = Math.cos(ph);
				wi[c * nspsb + n] = Math.sin(ph);
			}
		return set;
	}

	/** The complex baseband around tone 0 at f0 (mirrored: conjugated, so that the tones go up), at rate / ndown. */
	private baseband(f0: number, mir: boolean): void {
		const { S, L, fit } = this;
		const fc = f0 + (mir ? -1 : 1) * (L.nt - 1) * 0.5 * L.sp;
		fit.kc = Math.round(fc / S.df);
		const n2 = S.nBig / L.ndown;
		if (fit.yr.length !== n2) [fit.yr, fit.yi] = [new Float64Array(n2), new Float64Array(n2)];
		const { yr, yi } = fit;
		yr.fill(0);
		yi.fill(0);
		const w1 = (L.nt * 0.5 + 1) * L.sp;
		const w2 = w1 + 1.5 * L.sp;
		const reach = Math.min(n2 >> 1, Math.ceil(w2 / S.df) + 1);
		for (let j = -reach; j < reach; j++) {
			const k = fit.kc + j;
			const f = Math.abs(j * S.df);
			if (k < 0 || k >= S.nBig / 2 || f >= w2) continue;
			const tap = f <= w1 ? 1 : 0.5 * (1 + Math.cos((Math.PI * (f - w1)) / (w2 - w1)));
			yr[(j + n2) % n2] = S.Xr[k] * tap;
			yi[(j + n2) % n2] = S.Xi[k] * tap;
		}
		fftOf(n2).inverse(yr, yi);
		const g = 1 / S.nBig;
		const gi = (mir ? -1 : 1) * g;
		for (let i = 0; i < n2; i++) {
			yr[i] *= g;
			yi[i] *= gi;
		}
	}

	/** The correlation of the symbol at baseband sample i with tone c of twiddle set w, into zr[c], zi[c]. */
	private tone(i: number, c: number, w: number): void {
		const { yr, yi } = this.fit;
		const nspsb = this.nspsb;
		const wr = this.wr[w];
		const wi = this.wi[w];
		let ar = 0;
		let ai = 0;
		const from = Math.max(0, -i);
		const to = Math.min(nspsb, yr.length - i);
		const o = c * nspsb;
		for (let n = from; n < to; n++) {
			const vr = yr[i + n];
			const vi = yi[i + n];
			const cr = wr[o + n];
			const ci = wi[o + n];
			ar += vr * cr - vi * ci;
			ai += vr * ci + vi * cr;
		}
		this.zr[c] = ar;
		this.zi[c] = ai;
	}

	private power(c: number): number {
		return this.zr[c] * this.zr[c] + this.zi[c] * this.zi[c];
	}

	private syncMetric(tt: number, w: number): number {
		const { syncK, syncT, nspsb } = this;
		let m = 0;
		for (let s = 0; s < syncK.length; s++) {
			const i = tt + syncK[s] * nspsb;
			const sy = syncT[s];
			if (this.wspr) {
				for (let c = 0; c < 4; c++) this.tone(i, c, w);
				m += this.power(sy) + this.power(sy + 2) - this.power(1 - sy) - this.power(3 - sy);
			} else {
				this.tone(i, sy, w);
				m += this.power(sy);
			}
		}
		return m;
	}

	/**
	 * The sync metric at the starts t0 .. t0 + count - 1 (into this.metrics): each tone correlation computed once and then
	 * slid one sample at a time, X(i + 1) = exp(j theta) (X(i) - y(i)) + y(i + N) exp(-j theta (N - 1)).
	 */
	private metricsOver(t0: number, count: number, w: number): Float64Array {
		const out = this.metrics;
		out.fill(0, 0, count);
		const { nspsb: N, fit, syncK, syncT } = this;
		const wr = this.wr[w];
		const wi = this.wi[w];
		const { yr, yi } = fit;
		const len = yr.length;
		for (let s = 0; s < syncK.length; s++) {
			const sy = syncT[s];
			for (let c = this.wspr ? 0 : sy; c <= (this.wspr ? 3 : sy); c++) {
				const sign = !this.wspr || c === sy || c === sy + 2 ? 1 : -1;
				const i0 = t0 + syncK[s] * N;
				this.tone(i0, c, w);
				let xr = this.zr[c];
				let xi = this.zi[c];
				// exp(j theta) and exp(-j theta (N - 1)) from the twiddles of this tone
				const er = wr[c * N + 1];
				const ei = -wi[c * N + 1];
				const lr = wr[c * N + N - 1];
				const li = wi[c * N + N - 1];
				for (let j = 0; j < count; j++) {
					out[j] += sign * (xr * xr + xi * xi);
					const i = i0 + j;
					let ar = xr;
					let ai = xi;
					if (i >= 0 && i < len) {
						ar -= yr[i];
						ai -= yi[i];
					}
					let br = 0;
					let bi = 0;
					if (i + N >= 0 && i + N < len) {
						br = yr[i + N];
						bi = yi[i + N];
					}
					xr = er * ar - ei * ai + br * lr - bi * li;
					xi = er * ai + ei * ar + br * li + bi * lr;
				}
			}
		}
		return out;
	}

	/**
	 * Fine search by coordinate descent: time over +- half a symbol at the middle frequency, frequency in steps of a
	 * sixteenth of the spacing over +- half of it at that time, then the time again around the best frequency; then twice
	 * as fine in frequency and a parabola in time and frequency.
	 */
	fitCandidate(c: FtxCand, mir: boolean, binHz: number): void {
		const { L, fit, nspsb } = this;
		const f0 = c.bin * binHz;
		this.baseband(f0, mir);
		fit.base = (mir ? -1 : 1) * (f0 - fit.kc * this.S.df);
		const base = fit.base;
		const tc = Math.trunc((c.frame * (L.nsps / 4)) / L.ndown);
		const made = new Uint8Array(NFQ);
		const Wq = (q: number) => (made[q]++ ? q : this.twiddles(q, base, ((q - (NFQ >> 1)) * L.sp) / 16));
		let bestM = -1e300;
		let bestT = tc;
		let bestF = NFQ >> 1;
		const half = nspsb >> 1;
		const m1 = this.metricsOver(tc - half, 2 * half + 1, Wq(NFQ >> 1));
		for (let dt = -half; dt <= half; dt++) if (m1[dt + half] > bestM) [bestM, bestT] = [m1[dt + half], tc + dt];
		for (let q = 0; q < NFQ; q++) {
			if (q === NFQ >> 1) continue;
			const m = this.syncMetric(bestT, Wq(q));
			if (m > bestM) [bestM, bestF] = [m, q];
		}
		if (bestF !== NFQ >> 1) {
			const t0 = bestT;
			const m2 = this.metricsOver(t0 - 3, 7, Wq(bestF));
			for (let dt = -3; dt <= 3; dt++) if (dt && m2[dt + 3] > bestM) [bestM, bestT] = [m2[dt + 3], t0 + dt];
		}
		let dfr = ((bestF - (NFQ >> 1)) * L.sp) / 16;
		const mm = [-1, 0, 1].map((k) => this.syncMetric(bestT, this.twiddles(NFQ + 1 + k, base, dfr + (k * L.sp) / 32)));
		let kb = 1;
		if (mm[0] > mm[kb]) kb = 0;
		if (mm[2] > mm[kb]) kb = 2;
		dfr += ((kb - 1) * L.sp) / 32;
		if (kb === 1) {
			const den = mm[0] - 2 * mm[1] + mm[2];
			if (den < 0) dfr += (((0.5 * (mm[0] - mm[2])) / den) * L.sp) / 32;
		}
		const m3 = this.metricsOver(bestT - 1, 3, this.twiddles(NFQ + 3, base, dfr));
		const [a, b, cc] = [m3[0], m3[1], m3[2]];
		const den = a - 2 * b + cc;
		const tfrac = den < 0 && b >= a && b >= cc ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - cc)) / den)) : 0;
		Object.assign(fit, { valid: true, bestT, dfr, tfrac });
	}

	/**
	 * Tone amplitudes and complex correlations of every symbol at the fitted start and frequency plus `nudge` spacings
	 * (kept until the next call). The phase of a continuous-phase transmission runs on by 2 pi (base + dfr) T per symbol
	 * whatever the tone: taken out of the correlations, so that those of neighbouring symbols add up coherently.
	 */
	symbols(nudge: number, f0: number, mir: boolean, x0: number): FtxSymbols {
		const { L, fit, nspsb, fsb, amp, szr: zr, szi: zi } = this;
		const dfr = fit.dfr + nudge * L.sp;
		const w = this.twiddles(NFQ + 4, fit.base, dfr);
		const ns = L.nsym;
		const step = (-2 * Math.PI * (fit.base + dfr) * nspsb) / fsb;
		const [rr, ri] = [Math.cos(step), Math.sin(step)];
		let pr = 1;
		let pi = 0;
		for (let k = 0; k < ns; k++) {
			for (let t = 0; t < L.nt; t++) {
				this.tone(fit.bestT + k * nspsb, t, w);
				const ar = this.zr[t];
				const ai = this.zi[t];
				amp[k * L.nt + t] = Math.sqrt(ar * ar + ai * ai);
				zr[k * L.nt + t] = ar * pr - ai * pi;
				zi[k * L.nt + t] = ar * pi + ai * pr;
			}
			const npr = pr * rr - pi * ri;
			pi = pr * ri + pi * rr;
			pr = npr;
		}
		const startSec = x0 + ((fit.bestT + fit.tfrac) * L.ndown) / L.rate;
		return { amp, zr, zi, f0fine: f0 + (mir ? -1 : 1) * dfr, startSec, bestT: fit.bestT, tfrac: fit.tfrac };
	}
}
