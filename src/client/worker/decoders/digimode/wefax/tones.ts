// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/marine/marine_fax.cpp (FaxDecoder tone detector: start tones
// 300 / 675 Hz, stop tone 450 Hz), https://github.com/adswill/OnAir; see third_party/onair. Changes: the detector is a
// class of its own that returns the tone event instead of calling the state machine; sums in double precision.

import type { FaxStatus, FaxToneEvent, FaxToneReading } from './types';

/** 200 .. 800 Hz in 10 Hz steps. */
const BINS = 61;

/** Tones far below the picture band: a 0.1 s Hann window every 50 ms, the strongest of 61 bins, interpolated. */
export class FaxTones {
	/** Window and hop, samples. */
	nw = 1200;
	hop = 600;
	private ring = new Float32Array(1200);
	private pos = 0;
	private hann = new Float32Array(1200);
	private hannSum = 0;
	private ctab = new Float32Array(0);
	private stab = new Float32Array(0);
	private xw = new Float32Array(1200);
	private readonly mag = new Float64Array(BINS);
	private toneKind = 0;
	private toneRun = 0;
	private toneMiss = 0;
	private toneFired = 0;
	private toneNone = 0;
	private toneOnset = 0;
	private toneFSum = 0;
	private toneRefF = 0;

	configure(fs: number): void {
		const nw = Math.max(64, Math.round(0.1 * fs)) & ~1;
		this.nw = nw;
		this.hop = nw / 2;
		this.ring = new Float32Array(nw);
		this.hann = new Float32Array(nw);
		this.hannSum = 0;
		for (let i = 0; i < nw; i++) {
			this.hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / nw);
			this.hannSum += this.hann[i];
		}
		this.ctab = new Float32Array(BINS * nw);
		this.stab = new Float32Array(BINS * nw);
		for (let b = 0; b < BINS; b++) {
			const w = (2 * Math.PI * (200 + 10 * b)) / fs;
			for (let i = 0; i < nw; i++) {
				this.ctab[b * nw + i] = Math.cos(w * i);
				this.stab[b * nw + i] = Math.sin(w * i);
			}
		}
		this.xw = new Float32Array(nw);
	}

	reset(): void {
		this.ring.fill(0);
		this.pos = 0;
		this.toneKind = this.toneRun = this.toneMiss = this.toneFired = this.toneNone = 0;
	}

	put(x: number): void {
		this.ring[this.pos] = x;
		if (++this.pos === this.nw) this.pos = 0;
	}

	/** One analysis window ending at sample `nAud`; returns a start or stop tone that has lasted long enough. */
	block(nAud: number, st: FaxStatus): FaxToneEvent | null {
		const { kind, fTone, r } = this.measure();
		if (kind) {
			st.toneHz = fTone;
			st.snrDb = 10 * Math.log10(r / (1.001 - r));
		}
		this.track(kind, fTone, nAud - this.nw);
		if (this.toneKind === 0 || this.toneFired === this.toneKind) return null;
		const need = this.toneKind === 3 ? 8 : 14;
		if (this.toneRun < need) return null;
		this.toneFired = this.toneKind;
		const fMean = this.toneFSum / this.toneRun;
		const kindNow = this.toneKind as 1 | 2 | 3;
		const nominal = kindNow === 1 ? 300 : kindNow === 2 ? 675 : 450;
		return { kind: kindNow, onset: this.toneOnset, offsetHz: fMean - nominal };
	}

	/** Linearise the ring (oldest first), remove the mean, window; the strongest bin and its share of the power. */
	private measure(): FaxToneReading {
		const nw = this.nw;
		let mean = 0;
		for (let i = 0; i < nw; i++) {
			const v = this.ring[(this.pos + i) % nw];
			this.xw[i] = v;
			mean += v;
		}
		mean /= nw;
		let pwr = 0;
		for (let i = 0; i < nw; i++) {
			const v = Math.fround(this.xw[i] - Math.fround(mean));
			pwr += v * v;
			this.xw[i] = v * this.hann[i];
		}
		pwr /= nw;
		const mag = this.mag;
		let bp = 0;
		for (let b = 0; b < BINS; b++) {
			let re = 0;
			let im = 0;
			for (let i = 0, o = b * nw; i < nw; i++, o++) {
				re += this.xw[i] * this.ctab[o];
				im += this.xw[i] * this.stab[o];
			}
			mag[b] = Math.sqrt(re * re + im * im);
			if (mag[b] > mag[bp]) bp = b;
		}
		if (!(pwr > 1e-12 && mag[bp] > 0)) return { kind: 0, fTone: 0, r: 0 };
		let delta = 0;
		if (bp > 0 && bp < BINS - 1 && mag[bp - 1] > 0 && mag[bp + 1] > 0) {
			const [l, c0, rr] = [Math.log(mag[bp - 1]), Math.log(mag[bp]), Math.log(mag[bp + 1])];
			const den = l - 2 * c0 + rr;
			if (den < 0) delta = Math.min(0.5, Math.max(-0.5, (0.5 * (l - rr)) / den));
		}
		const fTone = 200 + 10 * (bp + delta);
		// Hann window scalloping at a fractional bin offset: sinc(d) / (1 - d^2).
		const dd = Math.abs(delta);
		const g = dd < 1e-9 ? 1 : Math.sin(Math.PI * dd) / (Math.PI * dd) / (1 - dd * dd);
		const amp = (2 * mag[bp]) / (this.hannSum * g);
		const r = Math.min(0.999, (0.5 * amp * amp) / pwr);
		let kind: FaxToneReading['kind'] = 0;
		if (r >= 0.35) {
			if (Math.abs(fTone - 300) <= 55) kind = 1;
			else if (Math.abs(fTone - 675) <= 55) kind = 2;
			else if (Math.abs(fTone - 450) <= 55) kind = 3;
		}
		return { kind, fTone, r };
	}

	/** Runs of the same tone; one window without it is forgiven. */
	private track(kind: number, fTone: number, winStart: number): void {
		if (kind !== 0 && kind === this.toneKind && Math.abs(fTone - this.toneRefF) < 8) {
			this.toneRun++;
			this.toneMiss = 0;
			this.toneFSum += fTone;
		} else if (kind !== 0) {
			this.toneKind = kind;
			this.toneRun = 1;
			this.toneMiss = 0;
			this.toneOnset = winStart;
			this.toneFSum = fTone;
			this.toneRefF = fTone;
			this.toneNone = 0;
		} else if (this.toneRun > 0 && this.toneMiss < 1) {
			this.toneMiss++;
		} else {
			this.toneRun = 0;
			this.toneKind = 0;
			this.toneMiss = 0;
			this.toneNone++;
			if (this.toneNone >= 3) this.toneFired = 0;
		}
	}
}
