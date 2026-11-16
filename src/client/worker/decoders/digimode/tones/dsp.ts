// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/tones/tones_rx.cpp (Biquad, goertzel, fft, the Hann windows) and
// core/include/dect2/dmr/dmr_dsp.h (lowpassTaps), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the FFT works on separate real and imaginary arrays.

/** Goertzel power |X(f)|^2 of x[0..n). */
export function goertzel(x: ArrayLike<number>, n: number, f: number, fs: number): number {
	const coeff = 2 * Math.cos((2 * Math.PI * f) / fs);
	let s1 = 0;
	let s2 = 0;
	for (let i = 0; i < n; i++) {
		const s0 = x[i] + coeff * s1 - s2;
		s2 = s1;
		s1 = s0;
	}
	return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

/** Second order section (RBJ cookbook), transposed direct form II. */
export class Biquad {
	private b0 = 1;
	private b1 = 0;
	private b2 = 0;
	private a1 = 0;
	private a2 = 0;
	private z1 = 0;
	private z2 = 0;

	lowpass(fc: number, fs: number, q: number): this {
		const w = (2 * Math.PI * fc) / fs;
		const c = Math.cos(w);
		const al = Math.sin(w) / (2 * q);
		const a0 = 1 + al;
		this.b0 = (1 - c) / 2 / a0;
		this.b1 = (1 - c) / a0;
		this.b2 = this.b0;
		this.a1 = (-2 * c) / a0;
		this.a2 = (1 - al) / a0;
		return this;
	}

	reset(): void {
		this.z1 = this.z2 = 0;
	}

	step(x: number): number {
		const y = this.b0 * x + this.z1;
		this.z1 = this.b1 * x - this.a1 * y + this.z2;
		this.z2 = this.b2 * x - this.a2 * y;
		return y;
	}
}

/** In-place radix-2 FFT; the length is a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
	const n = re.length;
	for (let i = 1, j = 0; i < n; i++) {
		let bit = n >> 1;
		for (; j & bit; bit >>= 1) j ^= bit;
		j ^= bit;
		if (i < j) {
			[re[i], re[j]] = [re[j], re[i]];
			[im[i], im[j]] = [im[j], im[i]];
		}
	}
	for (let len = 2; len <= n; len <<= 1) {
		const ang = (-2 * Math.PI) / len;
		const [wlr, wli] = [Math.cos(ang), Math.sin(ang)];
		for (let i = 0; i < n; i += len) {
			let [wr, wi] = [1, 0];
			for (let j = 0; j < len / 2; j++) {
				const [a, b] = [i + j, i + j + len / 2];
				const vr = re[b] * wr - im[b] * wi;
				const vi = re[b] * wi + im[b] * wr;
				re[b] = re[a] - vr;
				im[b] = im[a] - vi;
				re[a] += vr;
				im[a] += vi;
				[wr, wi] = [wr * wlr - wi * wli, wr * wli + wi * wlr];
			}
		}
	}
}

/** Periodic-style Hann window of OnAir: 0.5 - 0.5 cos(2 pi (i + 0.5) / n). */
export const hann = (n: number): Float64Array =>
	Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / n));

function besselI0(x: number): number {
	let s = 1;
	let t = 1;
	for (let k = 1; k < 60; k++) {
		t *= (x / (2 * k)) * (x / (2 * k));
		s += t;
	}
	return s;
}

/** Kaiser-windowed low-pass with unity gain at DC (dmr_dsp.h lowpassTaps). */
export function lowpassTaps(fpass: number, fstop: number, fs: number, attenDb = 60, minTaps = 9, maxTaps = 1501): Float64Array {
	fstop = Math.min(fstop, fs * 0.5 * 0.999);
	const fc = (0.5 * (fpass + fstop)) / fs;
	const df = Math.max((fstop - fpass) / fs, 1e-4);
	const n = Math.min(maxTaps, Math.max(minTaps, Math.ceil((attenDb - 7.95) / (14.36 * df)) + 1)) | 1;
	const beta = attenDb > 50 ? 0.1102 * (attenDb - 8.7) : 0.5842 * Math.pow(attenDb - 21, 0.4) + 0.07886 * (attenDb - 21);
	const h = new Float64Array(n);
	const m = n >> 1;
	let sum = 0;
	for (let i = 0; i < n; i++) {
		const x = i - m;
		const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
		const r = x / (m + 0.5);
		h[i] = (sinc * besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r)))) / besselI0(beta);
		sum += h[i];
	}
	return h.map((v) => v / sum);
}
