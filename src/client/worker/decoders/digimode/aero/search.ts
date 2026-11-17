// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/aero/aero_rx.cpp (AeroReceiver: the band search, searchFeed and
// the spectrum part of searchEvaluate), https://github.com/adswill/OnAir; see third_party/onair. Changes: the search
// covers the VFO's channel (OnAir: the whole capture) and stays inside its pass-band (OnAir's search limit for a
// channelised window); the noise floor is the lower quartile of the spectrum, not its median, because two 10500 bit/s
// carriers can fill half of a channel this narrow; the DC spike rule of a radio tuned away from the channels is left out.
//
// A search a second (the first four every quarter second): 16 windowed spectra spread over the period, added to the
// previous period's, smoothed over 3 bins; carriers are the stretches at least 3 dB over the floor.

import { Fft } from '@/worker/decoders/dab/ofdm/fft';
import type { AeroRegion } from './types';

const SLICES = 16;
const FAST_PERIODS = 4;

export class BandSearch {
	readonly nfft: number;
	private readonly fft: Fft;
	private readonly win: Float64Array;
	private readonly re: Float64Array;
	private readonly im: Float64Array;
	private acc: Float64Array;
	private accPrev: Float64Array;
	private fpos = 0;
	private slicesDone = 0;
	private periodLen = 0;
	private periodPos = 0;
	private sliceGap = 0;
	/** Searches so far. */
	period = 0;

	/** `rate`: of the channel; `limitHz`: the search stays within this of 0 Hz. */
	constructor(
		private readonly rate: number,
		private readonly limitHz: number,
	) {
		let n = 1024;
		while (n < 131072 && rate / n > 250) n <<= 1;
		this.nfft = n;
		this.fft = new Fft(n);
		this.win = Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
		this.re = new Float64Array(n);
		this.im = new Float64Array(n);
		this.acc = new Float64Array(n);
		this.accPrev = new Float64Array(n);
		this.reset();
	}

	reset(): void {
		this.acc.fill(0);
		this.accPrev.fill(0);
		this.period = this.periodPos = this.fpos = this.slicesDone = 0;
		this.setPeriod();
	}

	/** A period holds its 16 spectra (at a channel's rate a quarter second would not). */
	private setPeriod(): void {
		this.periodLen = Math.max(this.period < FAST_PERIODS ? Math.floor(this.rate / 4) : this.rate, SLICES * this.nfft);
		this.sliceGap = Math.max(Math.floor(this.periodLen / SLICES), this.nfft);
	}

	/** Samples until the current search period ends. */
	get untilEnd(): number {
		return this.periodLen - this.periodPos;
	}

	/** Takes the samples; the carriers found whenever a search period ends. */
	feed(iq: Float32Array, onRegions: (regions: AeroRegion[]) => void): void {
		const n = iq.length >> 1;
		for (let i = 0; i < n;) {
			const inSlice = this.periodPos % this.sliceGap;
			if (this.slicesDone < SLICES && inSlice < this.nfft) {
				const take = Math.min(this.nfft - inSlice, n - i);
				for (let k = 0; k < take; k++) {
					this.re[this.fpos + k] = iq[2 * (i + k)] * this.win[this.fpos + k];
					this.im[this.fpos + k] = iq[2 * (i + k) + 1] * this.win[this.fpos + k];
				}
				this.fpos += take;
				i += take;
				this.periodPos += take;
				if (this.fpos === this.nfft) this.spectrum();
			} else {
				const toNext = this.slicesDone < SLICES ? this.sliceGap - inSlice : this.periodLen - this.periodPos;
				const skip = Math.min(toNext, n - i);
				i += skip;
				this.periodPos += skip;
			}
			if (this.periodPos >= this.periodLen) {
				if (this.slicesDone === SLICES) onRegions(this.evaluate());
				this.periodPos = this.fpos = this.slicesDone = 0;
				this.setPeriod();
			}
		}
	}

	private spectrum(): void {
		this.fft.forward(this.re, this.im);
		for (let k = 0; k < this.nfft; k++) this.acc[k] += this.re[k] * this.re[k] + this.im[k] * this.im[k];
		this.fpos = 0;
		this.slicesDone++;
	}

	/** In frequency order (index 0 is -rate/2), the last two periods smoothed over 3 bins. */
	private smoothed(): Float64Array {
		const N = this.nfft;
		const p = new Float64Array(N);
		for (let k = 0; k < N; k++) p[k] = this.acc[k] + this.accPrev[k];
		[this.accPrev, this.acc] = [this.acc, this.accPrev];
		this.acc.fill(0);
		const s = new Float64Array(N);
		for (let j = 0; j < N; j++) {
			const k = (j + N / 2) % N;
			s[j] = (p[(k - 1 + N) % N] + p[k] + p[(k + 1) % N]) / 3;
		}
		return s;
	}

	private evaluate(): AeroRegion[] {
		this.period++;
		const N = this.nfft;
		const bin = this.rate / N;
		const s = this.smoothed();
		const fOf = (j: number) => (j - N / 2) * bin;
		const ok = Uint8Array.from({ length: N }, (_, j) => Number(Math.abs(fOf(j)) <= Math.min(0.45 * this.rate, this.limitHz)));
		const use = [...s].filter((_, j) => ok[j]).sort((a, b) => a - b);
		if (use.length < 16) return [];
		const floorP = Math.max(use[use.length >> 2], 1e-30);
		const thr = floorP * 2; // 3 dB over the floor after 32 averaged spectra
		const regions: AeroRegion[] = [];
		for (let j = 0; j < N;) {
			if (!ok[j] || s[j] <= thr) {
				j++;
				continue;
			}
			let b = j;
			for (let k = j + 1, gap = 0; k < N && ok[k] && (s[k] > thr || gap < 2); k++) {
				if (s[k] > thr) {
					b = k;
					gap = 0;
				} else gap++;
			}
			let wsum = 0,
				fsum = 0,
				peak = 0;
			for (let q = j; q <= b; q++) {
				const w = Math.max(0, s[q] - floorP);
				wsum += w;
				fsum += w * fOf(q);
				peak = Math.max(peak, s[q]);
			}
			const width = (b - j + 1) * bin;
			if (wsum > 0 && width < 40000) regions.push({ freq: fsum / wsum, width, peakDb: 10 * Math.log10(peak / floorP) });
			j = b + 1;
		}
		// a wide (10500 bit/s) carrier spreads its power over about 10 kHz: a bonus in the order
		const score = (r: AeroRegion) => r.peakDb + (r.width >= 6000 ? 8 : 0);
		return regions.sort((a, b) => score(b) - score(a));
	}
}
