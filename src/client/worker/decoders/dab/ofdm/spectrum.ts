// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/dab/dab_rx.cpp (windowFft, cirFast, cirOf, placeWindow),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: the spectra live in reused Float64Arrays; the derotation
// of a window is a table per carrier offset instead of a running phasor; the median
// is a quickselect on a scratch array (std::nth_element); cirOf returns the peak ratio and leaves the offset in `idx`.

import * as geometry from '@/worker/decoders/dab/constants';
import type { SampleBuffer } from './buffer';
import { Fft } from './fft';
import * as tables from './tables';

// module-level copies of the imports used in the loops (see demod.ts)
const { TG, TU } = geometry;
const { PHASE_REF_CONJ } = tables;

/** Demodulation windows start this many samples before the useful part (inside the guard interval). */
export const BACKOFF = 16;

/** The k-th smallest of a[0..n) (reorders `a`). */
export function select(a: Float32Array, n: number, k: number): number {
	let lo = 0,
		hi = n - 1;
	while (lo < hi) {
		const pivot = a[(lo + hi) >> 1];
		let i = lo,
			j = hi;
		while (i <= j) {
			while (a[i] < pivot) i++;
			while (a[j] > pivot) j--;
			if (i <= j) {
				const t = a[i];
				a[i] = a[j];
				a[j] = t;
				i++;
				j--;
			}
		}
		if (k <= j) hi = j;
		else if (k >= i) lo = i;
		else return a[k];
	}
	return a[k];
}

/** The FFT of demodulation windows and the impulse response against the phase reference. */
export class Spectrum {
	readonly fft = new Fft(TU);
	/** The spectrum of the last window. */
	readonly re = new Float64Array(TU);
	readonly im = new Float64Array(TU);
	/** The impulse response of the last correlation. */
	private readonly tr = new Float64Array(TU);
	private readonly ti = new Float64Array(TU);
	/** |impulse response| of the last cirOf. */
	readonly mag = new Float32Array(TU);
	private readonly scratch = new Float32Array(TU);
	/** The derotation of a window and the carrier offset it is for. */
	private readonly rotR = new Float64Array(TU);
	private readonly rotI = new Float64Array(TU);
	private rotCfo = NaN;
	/** Signed offset of the strongest path of the last cirOf (negative: the window starts before the useful part). */
	idx = 0;

	/** FFT of TU samples from `abs`, derotated by `cfoBins` carrier spacings (silence outside the buffer). */
	window(buf: SampleBuffer, abs: number, cfoBins: number): void {
		const re = this.re,
			im = this.im;
		if (abs < buf.base || abs + TU > buf.end) {
			re.fill(0);
			im.fill(0);
			return;
		}
		if (cfoBins !== this.rotCfo) this.rotation(cfoBins);
		const d = buf.data,
			tr = this.rotR,
			ti = this.rotI;
		// the phase at the window start, exp(-j 2 pi cfo abs / TU), times the steps within the window
		let x = (cfoBins * abs) / TU;
		x -= Math.floor(x);
		const pr = Math.cos(-2 * Math.PI * x),
			pi = Math.sin(-2 * Math.PI * x);
		for (let i = 0, o = buf.offset(abs); i < TU; i++, o += 2) {
			const rr = pr * tr[i] - pi * ti[i],
				ri = pr * ti[i] + pi * tr[i];
			const a = d[o],
				b = d[o + 1];
			re[i] = a * rr - b * ri;
			im[i] = a * ri + b * rr;
		}
		this.fft.forward(re, im);
	}

	/** exp(-j 2 pi cfo i / TU) for i < TU. */
	private rotation(cfoBins: number): void {
		this.rotCfo = cfoBins;
		for (let i = 0; i < TU; i++) {
			const a = (-2 * Math.PI * cfoBins * i) / TU;
			this.rotR[i] = Math.cos(a);
			this.rotI[i] = Math.sin(a);
		}
	}

	/** The spectrum shifted by `shift` bins times the conjugated phase reference, to the delay domain. */
	private correlate(shift: number): void {
		const re = this.re,
			im = this.im,
			tr = this.tr,
			ti = this.ti;
		const pr = PHASE_REF_CONJ.re,
			pi = PHASE_REF_CONJ.im;
		const s = ((shift % TU) + TU) % TU;
		for (let k = 0; k < TU; k++) {
			let j = k + s;
			if (j >= TU) j -= TU;
			const a = re[j],
				b = im[j];
			tr[k] = a * pr[k] - b * pi[k];
			ti[k] = a * pi[k] + b * pr[k];
		}
		this.fft.inverse(tr, ti);
	}

	/** Peak against the mean power of the impulse response: ranks many (position, shift) pairs cheaply. */
	cirFast(shift: number): number {
		this.correlate(shift);
		const tr = this.tr,
			ti = this.ti;
		let pk = 0,
			sum = 0;
		for (let i = 0; i < TU; i++) {
			const n = tr[i] * tr[i] + ti[i] * ti[i];
			sum += n;
			if (n > pk) pk = n;
		}
		return pk / (sum / TU + 1e-18);
	}

	/** Peak / median of |impulse response|; the strongest path's signed offset goes to `idx`, the magnitudes to `mag`. */
	cirOf(shift: number): number {
		this.correlate(shift);
		const tr = this.tr,
			ti = this.ti,
			m = this.mag;
		let pk = 0,
			at = 0;
		for (let i = 0; i < TU; i++) {
			m[i] = Math.sqrt(tr[i] * tr[i] + ti[i] * ti[i]);
			if (m[i] > pk) {
				pk = m[i];
				at = i;
			}
		}
		this.scratch.set(m);
		const median = select(this.scratch, TU, TU / 2);
		this.idx = at < TU / 2 ? at : at - TU;
		return pk / (median + 1e-9);
	}

	/**
	 * Where the useful part starts, from the impulse response `mag` of the last cirOf (`peak` the strongest path). In a
	 * single frequency network a weaker transmitter is often heard first: the window goes on the earliest path within
	 * 10 dB of the strongest when all of them fit in the guard interval; when they do not, where most of their energy does.
	 */
	placeWindow(mag: Float32Array, peak: number): number {
		const P = (off: number) => {
			const v = mag[((off % TU) + TU) % TU];
			return v * v;
		};
		const c = this.scratch;
		for (let i = 0; i < TU; i++) c[i] = mag[i] * mag[i];
		const median = select(c, TU, TU / 2);
		const pk = P(peak);
		const thr = Math.max(0.1 * pk, 12 * median);
		const span = TG - BACKOFF;
		let first = peak,
			last = peak;
		for (let o = peak - span; o < peak; o++)
			if (P(o) >= thr) {
				first = o;
				break;
			}
		for (let o = peak + span; o > peak; o--)
			if (P(o) >= thr) {
				last = o;
				break;
			}
		if (last - first <= span - 8) return first;
		let best = peak,
			bestE = -1;
		for (let u = first; u <= last; u++) {
			let e = 0;
			for (let o = u - BACKOFF; o <= u + span; o++) {
				const v = P(o);
				if (v >= thr) e += v;
			}
			if (e > bestE + 1e-12) {
				bestE = e;
				best = u;
			}
		}
		return best;
	}
}
