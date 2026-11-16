// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/include/dect2/dsp/fftutil.h (Fft: in-place complex FFT, unnormalised
// inverse), https://github.com/adswill/OnAir; see third_party/onair. Changes: written anew as an iterative radix-2 FFT on
// separate real and imaginary Float64Arrays with precomputed bit reversal and twiddles, two stages per pass (radix 2^2)
// to halve the memory traffic in JavaScript; the inverse is the forward transform with real and imaginary parts swapped.

/** Complex FFT of a power-of-two size, in place, without allocation. */
export class Fft {
	readonly n: number;
	private readonly swapA: Uint32Array;
	private readonly swapB: Uint32Array;
	/** exp(-j pi k / h) at index h + k, for every stage half-size h. */
	private readonly wr: Float64Array;
	private readonly wi: Float64Array;

	constructor(n: number) {
		if (n < 8 || (n & (n - 1)) !== 0) throw new Error(`FFT size ${n} is not a power of two of at least 8`);
		this.n = n;
		const bits = Math.round(Math.log2(n));
		const a: number[] = [];
		const b: number[] = [];
		for (let i = 0; i < n; i++) {
			let r = 0;
			for (let k = 0; k < bits; k++) r |= ((i >> k) & 1) << (bits - 1 - k);
			if (i < r) {
				a.push(i);
				b.push(r);
			}
		}
		this.swapA = Uint32Array.from(a);
		this.swapB = Uint32Array.from(b);
		this.wr = new Float64Array(n);
		this.wi = new Float64Array(n);
		for (let h = 1; h < n; h <<= 1)
			for (let k = 0; k < h; k++) {
				this.wr[h + k] = Math.cos((Math.PI * k) / h);
				this.wi[h + k] = -Math.sin((Math.PI * k) / h);
			}
	}

	/** X[k] = sum x[n] exp(-j 2 pi n k / N) */
	forward(re: Float64Array, im: Float64Array): void {
		this.run(re, im);
	}

	/** x[n] = sum X[k] exp(+j 2 pi n k / N), not divided by N */
	inverse(re: Float64Array, im: Float64Array): void {
		this.run(im, re);
	}

	private run(re: Float64Array, im: Float64Array): void {
		const n = this.n;
		const sa = this.swapA,
			sb = this.swapB;
		for (let s = 0; s < sa.length; s++) {
			const i = sa[s],
				j = sb[s];
			const tr = re[i];
			re[i] = re[j];
			re[j] = tr;
			const ti = im[i];
			im[i] = im[j];
			im[j] = ti;
		}
		// the first two stages together: butterflies of 4 with the twiddles 1 and -j
		for (let i = 0; i < n; i += 4) {
			const r0 = re[i] + re[i + 1],
				i0 = im[i] + im[i + 1];
			const r1 = re[i] - re[i + 1],
				i1 = im[i] - im[i + 1];
			const r2 = re[i + 2] + re[i + 3],
				i2 = im[i + 2] + im[i + 3];
			const r3 = re[i + 2] - re[i + 3],
				i3 = im[i + 2] - im[i + 3];
			re[i] = r0 + r2;
			im[i] = i0 + i2;
			re[i + 2] = r0 - r2;
			im[i + 2] = i0 - i2;
			// (r3 + j i3) * -j = i3 - j r3
			re[i + 1] = r1 + i3;
			im[i + 1] = i1 - r3;
			re[i + 3] = r1 - i3;
			im[i + 3] = i1 + r3;
		}
		let h = 4;
		for (; 4 * h <= n; h <<= 2) this.twoStages(re, im, h);
		if (2 * h <= n) this.lastStage(re, im, h);
	}

	/** The stages of half-size h and 2h in one pass over blocks of 4h. */
	private twoStages(re: Float64Array, im: Float64Array, h: number): void {
		const n = this.n,
			wr = this.wr,
			wi = this.wi;
		const h2 = 2 * h,
			size = 4 * h;
		for (let i0 = 0; i0 < n; i0 += size)
			for (let k = 0; k < h; k++) {
				const a = i0 + k,
					b = a + h,
					c = a + h2,
					d = c + h;
				const w1r = wr[h + k],
					w1i = wi[h + k],
					w2r = wr[h2 + k],
					w2i = wi[h2 + k];
				let xr = re[b],
					xi = im[b];
				const tbr = xr * w1r - xi * w1i,
					tbi = xr * w1i + xi * w1r;
				xr = re[d];
				xi = im[d];
				const tdr = xr * w1r - xi * w1i,
					tdi = xr * w1i + xi * w1r;
				const ar = re[a] + tbr,
					ai = im[a] + tbi,
					br = re[a] - tbr,
					bi = im[a] - tbi;
				const cr = re[c] + tdr,
					ci = im[c] + tdi,
					dr = re[c] - tdr,
					di = im[c] - tdi;
				const ur = cr * w2r - ci * w2i,
					ui = cr * w2i + ci * w2r;
				// (d w2) * -j: the twiddle of the odd half is w2 exp(-j pi / 2)
				const vr = dr * w2i + di * w2r,
					vi = -(dr * w2r - di * w2i);
				re[a] = ar + ur;
				im[a] = ai + ui;
				re[c] = ar - ur;
				im[c] = ai - ui;
				re[b] = br + vr;
				im[b] = bi + vi;
				re[d] = br - vr;
				im[d] = bi - vi;
			}
	}

	/** The last stage alone (half-size h = n / 2) when the stage count is odd. */
	private lastStage(re: Float64Array, im: Float64Array, h: number): void {
		const wr = this.wr,
			wi = this.wi;
		for (let i = 0; i < h; i++) {
			const j = i + h;
			const cr = wr[h + i],
				ci = wi[h + i];
			const xr = re[j],
				xi = im[j];
			const tr = xr * cr - xi * ci,
				ti = xr * ci + xi * cr;
			re[j] = re[i] - tr;
			im[j] = im[i] - ti;
			re[i] += tr;
			im[i] += ti;
		}
	}
}
