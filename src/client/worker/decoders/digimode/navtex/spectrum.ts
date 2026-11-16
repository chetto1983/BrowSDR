// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/marine/marine_dsp.cpp (Spectrum: push, noisePerBin, findFsk),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: a radix-2 FFT of its own; the display spectrum
// (audioDb) and freqPower are left out.

import type { FskInfo } from './types';

const RATE = 24000;
const N = 8192;
const BIN_HZ = RATE / N;

/** In-place radix-2 FFT of N points with precomputed rotations. */
class Fft {
	private readonly cos = new Float64Array(N / 2);
	private readonly sin = new Float64Array(N / 2);
	private readonly rev = new Uint32Array(N);

	constructor() {
		for (let k = 0; k < N / 2; k++) {
			this.cos[k] = Math.cos((-2 * Math.PI * k) / N);
			this.sin[k] = Math.sin((-2 * Math.PI * k) / N);
		}
		for (let i = 1, j = 0; i < N; i++) {
			let bit = N >> 1;
			for (; j & bit; bit >>= 1) j ^= bit;
			j ^= bit;
			this.rev[i] = j;
		}
	}

	forward(re: Float64Array, im: Float64Array): void {
		for (let i = 1; i < N; i++) {
			const j = this.rev[i];
			if (i < j) {
				[re[i], re[j]] = [re[j], re[i]];
				[im[i], im[j]] = [im[j], im[i]];
			}
		}
		for (let width = 2; width <= N; width *= 2) {
			const half = width / 2;
			const step = N / width;
			for (let base = 0; base < N; base += width) {
				for (let k = 0; k < half; k++) {
					const [c, s] = [this.cos[k * step], this.sin[k * step]];
					const a = base + k;
					const b = a + half;
					const tr = re[b] * c - im[b] * s;
					const ti = re[b] * s + im[b] * c;
					re[b] = re[a] - tr;
					im[b] = im[a] - ti;
					re[a] += tr;
					im[a] += ti;
				}
			}
		}
	}
}

/** The bin of a signed bin number (negative frequencies at the top). */
const wrapBin = (k: number) => ((k % N) + N) % N;

/** 8192-point spectrum of the 24 kHz stream, averaged; finds the FSK pair and gives the noise level. */
export class FskSpectrum {
	private readonly avg = new Float64Array(N);
	private readonly bufR = new Float64Array(N);
	private readonly bufI = new Float64Array(N);
	private readonly win = new Float64Array(N);
	private readonly tmpR = new Float64Array(N);
	private readonly tmpI = new Float64Array(N);
	private readonly fft = new Fft();
	private win2 = 0;
	private fill = 0;
	private primed = false;

	constructor() {
		for (let i = 0; i < N; i++) {
			this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / N);
			this.win2 += this.win[i] * this.win[i];
		}
	}

	reset(): void {
		this.avg.fill(0);
		this.fill = 0;
		this.primed = false;
	}

	/** Interleaved complex samples; true when a new spectrum is ready (every 4096 samples). */
	push(iq: Float32Array): boolean {
		let got = false;
		for (let i = 0; i + 1 < iq.length; i += 2) {
			this.bufR[this.fill] = iq[i];
			this.bufI[this.fill] = iq[i + 1];
			if (++this.fill < N) continue;
			for (let k = 0; k < N; k++) {
				this.tmpR[k] = this.bufR[k] * this.win[k];
				this.tmpI[k] = this.bufI[k] * this.win[k];
			}
			this.fft.forward(this.tmpR, this.tmpI);
			const alpha = this.primed ? 0.25 : 1;
			for (let k = 0; k < N; k++) {
				const p = (this.tmpR[k] * this.tmpR[k] + this.tmpI[k] * this.tmpI[k]) / this.win2;
				this.avg[k] += alpha * (p - this.avg[k]);
			}
			this.primed = true;
			this.bufR.copyWithin(0, N / 2);
			this.bufI.copyWithin(0, N / 2);
			this.fill = N / 2;
			got = true;
		}
		return got;
	}

	/** Median power per bin over -3 .. +3 kHz (the wanted signal is narrow), linear. */
	noisePerBin(): number {
		const span = Math.floor(3000 / BIN_HZ);
		const v = new Float64Array(2 * span + 1);
		for (let k = -span; k <= span; k++) v[k + span] = this.avg[wrapBin(k)];
		v.sort();
		return v[v.length >> 1] * 1.05 + 1e-30;
	}

	/** The FSK pair of this shift with the most power within ±searchHz of 0 Hz. */
	findFsk(shiftHz: number, searchHz: number): FskInfo {
		const r: FskInfo = { found: false, centreHz: 0, levelDb: 0, snrDb: 0, highHz: 0, lowHz: 0 };
		if (!this.primed) return r;
		const h = Math.round(shiftHz / 2 / BIN_HZ);
		const box = 17;
		const sb = Math.trunc(searchHz / BIN_HZ);
		// prefix sums over -3.5 .. +3.5 kHz
		const lim = Math.trunc(3500 / BIN_HZ);
		const pre = new Float64Array(2 * lim + 2);
		for (let k = -lim; k <= lim; k++) pre[k + lim + 1] = pre[k + lim] + this.avg[wrapBin(k)];
		const boxSum = (x: number) => pre[x + box + lim + 1] - pre[x - box + lim];
		let best = -1;
		let bc = 0;
		for (let c = -sb; c <= sb; c++) {
			const m = boxSum(c - h) + boxSum(c + h);
			if (m > best) {
				best = m;
				bc = c;
			}
		}
		const n0 = this.noisePerBin();
		const perBin = best / (2 * (2 * box + 1));
		r.levelDb = 10 * Math.log10(perBin / n0 + 1e-12);
		r.centreHz = bc * BIN_HZ;
		// signal power: bins from the low box to the high box
		let sum = 0;
		for (let k = bc - h - box; k <= bc + h + box; k++) sum += Math.max(0, this.avg[wrapBin(k)] - n0);
		const psig = sum / N;
		const pn3k = (n0 * 3000) / RATE;
		r.snrDb = 10 * Math.log10(Math.max(1e-9, psig / pn3k));
		r.found = r.levelDb > 5;
		r.highHz = this.peak(bc + h);
		r.lowHz = this.peak(bc - h);
		return r;
	}

	/** Measured tone place: the largest bin within ±40 Hz of the expected one (smoothed over 5 bins), Hz. */
	private peak(centreBin: number): number {
		let bv = -1;
		let bi = centreBin;
		const w = Math.trunc(40 / BIN_HZ);
		for (let k = centreBin - w; k <= centreBin + w; k++) {
			let v = 0;
			for (let j = -2; j <= 2; j++) v += this.avg[wrapBin(k + j)];
			if (v > bv) {
				bv = v;
				bi = k;
			}
		}
		return bi * BIN_HZ;
	}
}
