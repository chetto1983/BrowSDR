// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/hfdl/hfdl_rx.cpp (cubicAt; HfdlReceiver::Impl: the matched
// filter of setup(), symSample, X, trim) and core/include/dect2/dsp/rrc.h (rrc), https://github.com/adswill/OnAir; see
// third_party/onair. Changes: one channel, handed over by BrowSDR's channel filter at exactly 7200 Hz (4 samples per
// symbol, OnAir's channel rate), so OnAir's mixer, moving sums, 3.4 kHz FIR and cubic interpolator to 7200 Hz are
// BrowSDR's channel (DDC) here; the matched filter output is kept in typed arrays that grow and are trimmed in place.
//
// The receive root raised cosine filter (roll-off 0.35, 12 symbols, unit DC gain) and the store of its output: x(i)
// and |x(i)| by absolute sample number, read with cubic interpolation between samples; the noise floor follows the
// quiet quarter seconds.

import { RRC_ALPHA } from './phy';

/** The channel rate: 4 samples per symbol. */
export const HFDL_RATE = 7200;
export const SPS = 4;
/** Samples kept behind the search position, and the slack before the store is trimmed. */
const KEEP_BEHIND = 64;
const TRIM_SLACK = 40000;

/** The impulse response at t symbols of the root raised cosine filter with roll-off a (unit energy per symbol). */
export function rrc(t: number, a: number): number {
	if (Math.abs(t) < 1e-9) return 1 - a + (4 * a) / Math.PI;
	if (a > 0 && Math.abs(Math.abs(t) - 1 / (4 * a)) < 1e-9)
		return (a / Math.SQRT2) * ((1 + 2 / Math.PI) * Math.sin(Math.PI / (4 * a)) + (1 - 2 / Math.PI) * Math.cos(Math.PI / (4 * a)));
	return (Math.sin(Math.PI * t * (1 - a)) + 4 * a * t * Math.cos(Math.PI * t * (1 + a))) / (Math.PI * t * (1 - 16 * a * a * t * t));
}

/** The matched filter: 6 symbols each side, normalised to a sum of 1. */
const MF = (() => {
	const h = Float64Array.from({ length: 12 * SPS + 1 }, (_, k) => rrc((k - 6 * SPS) / SPS, RRC_ALPHA));
	const s = h.reduce((a, b) => a + b, 0);
	return h.map((v) => v / s);
})();
const MF_LEN = MF.length;

/** The matched filter output of one channel, by absolute sample number. */
export class HfdlSamples {
	re = new Float32Array(1 << 16);
	im = new Float32Array(1 << 16);
	/** |x|, stored once when the sample is made (the coarse search reads it). */
	mag = new Float32Array(1 << 16);
	/** Samples held. */
	len = 0;
	/** The absolute number of re[0]. */
	base = 0;
	/** The noise floor (power), -1 before the first quarter second. */
	noisePow = -1;
	private readonly histRe = new Float64Array(2 * MF_LEN);
	private readonly histIm = new Float64Array(2 * MF_LEN);
	private hpos = 0;
	private blkPow = 0;
	private blkN = 0;

	/** One past the last absolute sample held. */
	get end(): number {
		return this.base + this.len;
	}

	/** Filters the input (interleaved I/Q at 7200 Hz) into the store. */
	push(iq: Float32Array): void {
		const n = iq.length >> 1;
		this.reserve(n);
		for (let i = 0; i < n; i++) {
			let vr = iq[2 * i];
			let vi = iq[2 * i + 1];
			if (!Number.isFinite(vr) || !Number.isFinite(vi)) vr = vi = 0;
			this.filter(vr, vi);
		}
	}

	/** Forgets the samples before the search position, once enough have gathered. */
	trim(searchAt: number): void {
		const keep = searchAt - KEEP_BEHIND;
		const drop = keep - this.base;
		if (drop <= TRIM_SLACK) return;
		this.re.copyWithin(0, drop, this.len);
		this.im.copyWithin(0, drop, this.len);
		this.mag.copyWithin(0, drop, this.len);
		this.len -= drop;
		this.base = keep;
	}

	/** Starts again at absolute sample `at` (a gap in the input). */
	restart(at: number): void {
		this.len = 0;
		this.base = at;
		this.histRe.fill(0);
		this.histIm.fill(0);
		this.hpos = 0;
	}

	/** x at fractional absolute position `pos`, cubic interpolation (zero outside the store), into out[0], out[1]. */
	cubicAt(pos: number, out: Float64Array): void {
		const rel = pos - this.base;
		const i = Math.floor(rel);
		const f = rel - i;
		const re = this.re;
		const im = this.im;
		const len = this.len;
		const ar = i - 1 >= 0 && i - 1 < len ? re[i - 1] : 0;
		const ai = i - 1 >= 0 && i - 1 < len ? im[i - 1] : 0;
		const br = i >= 0 && i < len ? re[i] : 0;
		const bi = i >= 0 && i < len ? im[i] : 0;
		const cr = i + 1 >= 0 && i + 1 < len ? re[i + 1] : 0;
		const ci = i + 1 >= 0 && i + 1 < len ? im[i + 1] : 0;
		const dr = i + 2 >= 0 && i + 2 < len ? re[i + 2] : 0;
		const di = i + 2 >= 0 && i + 2 < len ? im[i + 2] : 0;
		out[0] = cubic(ar, br, cr, dr, f);
		out[1] = cubic(ai, bi, ci, di, f);
	}

	private reserve(n: number): void {
		if (this.len + n <= this.re.length) return;
		const size = Math.max(2 * this.re.length, this.len + n);
		for (const key of ['re', 'im', 'mag'] as const) {
			const grown = new Float32Array(size);
			grown.set(this[key].subarray(0, this.len));
			this[key] = grown;
		}
	}

	private filter(vr: number, vi: number): void {
		// the history twice over, so the newest MF_LEN samples are always one run
		const p = this.hpos;
		this.histRe[p] = this.histRe[p + MF_LEN] = vr;
		this.histIm[p] = this.histIm[p + MF_LEN] = vi;
		this.hpos = p + 1 === MF_LEN ? 0 : p + 1;
		const start = this.hpos;
		let ar = 0;
		let ai = 0;
		for (let k = 0; k < MF_LEN; k++) {
			ar += this.histRe[start + k] * MF[k];
			ai += this.histIm[start + k] * MF[k];
		}
		const j = this.len++;
		this.re[j] = ar;
		this.im[j] = ai;
		this.mag[j] = Math.sqrt(ar * ar + ai * ai);
		this.floor(ar * ar + ai * ai);
	}

	/** A quarter second at a time: the noise floor follows the quiet blocks. */
	private floor(pow: number): void {
		this.blkPow += pow;
		if (++this.blkN < 1800) return;
		const p = this.blkPow / this.blkN;
		if (this.noisePow <= 0) this.noisePow = p;
		else if (p < this.noisePow * 2) this.noisePow += 0.1 * (p - this.noisePow);
		else this.noisePow *= 1.01;
		this.blkPow = 0;
		this.blkN = 0;
	}
}

/** Cubic interpolation between b (f = 0) and c (f = 1). */
function cubic(a: number, b: number, c: number, d: number, f: number): number {
	const c1 = 0.5 * (c - a);
	const c2 = a - 2.5 * b + 2 * c - 0.5 * d;
	const c3 = 0.5 * (d - a) + 1.5 * (b - c);
	return ((c3 * f + c2) * f + c1) * f + b;
}
