// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir core/src/drm/drm_fft.cpp (DrmFft: mixed radix decimation in time
// FFT, radix 4, 2, 3, 5 and a general odd radix), https://github.com/adswill/OnAir; see third_party/onair. Changes: complex
// values as separate real and imaginary Float64Arrays; forward transform only (the AAC encoder's MDCT needs no other).

/** Complex FFT of any size whose prime factors are small (1920 for the AAC 960 transform). */
export class DrmFft {
	constructor(n) {
		this.n = n;
		this.factors = [];
		let rest = n;
		for (const p of [4, 2, 3, 5])
			while (rest % p === 0) {
				rest /= p;
				this.factors.push(p, 0);
			}
		for (let p = 7; rest > 1; p += 2)
			while (rest % p === 0) {
				rest /= p;
				this.factors.push(p, 0);
			}
		let m = n;
		for (let i = 0; i < this.factors.length; i += 2) {
			m /= this.factors[i];
			this.factors[i + 1] = m;
		}
		this.twr = new Float64Array(n);
		this.twi = new Float64Array(n);
		for (let i = 0; i < n; i++) {
			this.twr[i] = Math.cos((-2 * Math.PI * i) / n);
			this.twi[i] = Math.sin((-2 * Math.PI * i) / n);
		}
		this.tr = new Float64Array(n);
		this.ti = new Float64Array(n);
		this.sr = new Float64Array(16);
		this.si = new Float64Array(16);
	}

	/** X[k] = sum x[n] exp(-j 2 pi n k / N), in place. */
	forward(re, im) {
		this.tr.set(re);
		this.ti.set(im);
		this.work(re, im, 0, 0, 1, 0);
	}

	work(or, oi, out, inp, fstride, f) {
		const p = this.factors[f],
			m = this.factors[f + 1];
		if (m === 1) {
			for (let k = 0; k < p; k++, inp += fstride) {
				or[out + k] = this.tr[inp];
				oi[out + k] = this.ti[inp];
			}
		} else for (let k = 0; k < p; k++, inp += fstride) this.work(or, oi, out + k * m, inp, fstride * p, f + 2);
		if (p === 2) this.radix2(or, oi, out, m, fstride);
		else if (p === 4) this.radix4(or, oi, out, m, fstride);
		else this.radixP(or, oi, out, p, m, fstride);
	}

	radix2(or, oi, out, m, fstride) {
		const N = this.n;
		for (let u = 0; u < m; u++) {
			const t = (u * fstride) % N;
			const a = out + u,
				b = out + u + m;
			const xr = or[b] * this.twr[t] - oi[b] * this.twi[t];
			const xi = or[b] * this.twi[t] + oi[b] * this.twr[t];
			or[b] = or[a] - xr;
			oi[b] = oi[a] - xi;
			or[a] += xr;
			oi[a] += xi;
		}
	}

	radix4(or, oi, out, m, fstride) {
		const N = this.n,
			wr = this.twr,
			wi = this.twi;
		for (let u = 0; u < m; u++) {
			const r = [0, 0, 0, 0],
				i = [0, 0, 0, 0];
			for (let q = 0; q < 4; q++) {
				const at = out + u + q * m,
					t = (u * q * fstride) % N;
				r[q] = or[at] * wr[t] - oi[at] * wi[t];
				i[q] = or[at] * wi[t] + oi[at] * wr[t];
			}
			const s02r = r[0] + r[2],
				s02i = i[0] + i[2],
				d02r = r[0] - r[2],
				d02i = i[0] - i[2];
			const s13r = r[1] + r[3],
				s13i = i[1] + i[3],
				d13r = r[1] - r[3],
				d13i = i[1] - i[3];
			// multiplication by -j
			const jr = d13i,
				ji = -d13r;
			or[out + u] = s02r + s13r;
			oi[out + u] = s02i + s13i;
			or[out + u + m] = d02r + jr;
			oi[out + u + m] = d02i + ji;
			or[out + u + 2 * m] = s02r - s13r;
			oi[out + u + 2 * m] = s02i - s13i;
			or[out + u + 3 * m] = d02r - jr;
			oi[out + u + 3 * m] = d02i - ji;
		}
	}

	radixP(or, oi, out, p, m, fstride) {
		const N = this.n,
			wr = this.twr,
			wi = this.twi,
			sr = this.sr,
			si = this.si;
		const step = m * fstride;
		for (let u = 0; u < m; u++) {
			for (let q = 0; q < p; q++) {
				const at = out + u + q * m,
					t = (u * q * fstride) % N;
				sr[q] = or[at] * wr[t] - oi[at] * wi[t];
				si[q] = or[at] * wi[t] + oi[at] * wr[t];
			}
			for (let k = 0; k < p; k++) {
				let ar = sr[0],
					ai = si[0];
				for (let q = 1; q < p; q++) {
					const t = (step * ((q * k) % p)) % N;
					ar += sr[q] * wr[t] - si[q] * wi[t];
					ai += sr[q] * wi[t] + si[q] * wr[t];
				}
				or[out + u + k * m] = ar;
				oi[out + u + k * m] = ai;
			}
		}
	}
}
