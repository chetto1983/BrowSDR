// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/marine/marine_fax.cpp (FaxDecoder::State: settings, line fit,
// picture rows, row filter, slant and end-of-picture trims; faxImageWidth), https://github.com/adswill/OnAir; see
// third_party/onair. Changes: the decoder state is split over a small class hierarchy (this file, free.ts,
// decoder.ts) instead of one struct; settings are plain fields (one thread); diagnostics left out.

import { FAX_BLACK_HZ, FAX_WHITE_HZ, FaxFront } from './front';
import { FaxPicture } from './picture';
import type { FaxStatus } from './types';

/** Above this the picture comes through the wide filter (sharper); below, the narrow one (less noise). */
const WIDE_SNR_DB = 22;

/** Image width for an index of cooperation: IOC x pi, cut to a whole number as fldigi does (576 -> 1809, 288 -> 904). */
export const faxImageWidth = (ioc: number): number => (ioc > 0 ? Math.trunc(ioc * Math.PI) : 0);

export function newFaxStatus(): FaxStatus {
	return { state: 0, ioc: 576, lpm: 120, lines: 0, slantPpm: 0, toneHz: 0, snrDb: 0, blackHz: 1500, phasingLines: 0, width: 0 };
}

/** The decoder's state and the picture side of it. */
export abstract class FaxCore {
	// Settings: 0 = detect for lpm and IOC.
	protected lpmSet = 0;
	protected iocSet = 0;
	protected maxLines = 8000;
	protected manualPpm = 0;
	protected autoSlant = true;
	protected noiseFilter = true;

	readonly front = new FaxFront();
	readonly picture = new FaxPicture();
	/** Working copy of the status. */
	st: FaxStatus = newFaxStatus();

	// Line lock and image.
	protected locked = false;
	protected curLpm = 120;
	protected fitI: number[] = [];
	protected fitC: number[] = [];
	protected fitA = 0;
	protected fitP = 0;
	protected phIdx = 0;
	protected failCount = 0;
	protected firstFail = 0;
	protected phasingPass = 0;
	protected fbAvg = FAX_BLACK_HZ;
	protected fwAvg = FAX_WHITE_HZ;
	protected levelsSeen = false;
	protected snrAvg = 0;
	protected imgW = 0;
	protected imgStart = 0;
	protected Pnom = 0;
	protected Puse = 0;
	protected estPpm = 0;
	protected appliedManual = 0;
	protected fbUse = FAX_BLACK_HZ;
	protected fwUse = FAX_WHITE_HZ;
	protected rowIdx = 0;
	/** Mistuning estimate in Hz (black level - 1500). */
	protected dHat = 0;
	/** Mistuning measured on the start tone. */
	protected dTone = 0;
	protected toneSeen = false;
	protected freeRun = false;
	protected periodDirty = false;

	// A row's tones, filtered, second differences (row filter); the filter's noise (Hz^2) averaged over rows.
	private fr = new Float64Array(0);
	private ff = new Float64Array(0);
	private dd = new Float64Array(0);
	private nvAvg = -1;
	private row = new Uint8Array(0);

	/** Free-running picture: follow the line period from the row just decoded. */
	protected abstract refineRow(s: number): void;

	/** Least squares line c = a + i * P through the phasing pulses; P stays at the nominal value when the fit is not credible. */
	protected refit(): void {
		const n = this.fitI.length;
		let [sI, sC, sII, sIC] = [0, 0, 0, 0];
		for (let i = 0; i < n; i++) {
			sI += this.fitI[i];
			sC += this.fitC[i];
			sII += this.fitI[i] * this.fitI[i];
			sIC += this.fitI[i] * this.fitC[i];
		}
		let P = this.Pnom;
		if (n >= 3) {
			const den = n * sII - sI * sI;
			if (den > 0) P = (n * sIC - sI * sC) / den;
			if (Math.abs(P / this.Pnom - 1) > 0.01) P = this.Pnom;
		}
		this.fitP = P;
		this.fitA = (sC - P * sI) / n;
		this.estPpm = (P / this.Pnom - 1) * 1e6;
		this.st.slantPpm = this.estPpm + this.manualPpm;
	}

	/**
	 * A tone (300, 450 or 675 Hz) lies far below the black level, so the discriminator sits at its lower limit for the
	 * whole tone. Rows of the last few that spend a good part of their length there are the tone, not the picture.
	 */
	protected truncateRows(): void {
		let keep = this.rowIdx;
		const from = Math.max(0, this.rowIdx - 6);
		for (let r = from; r < this.rowIdx; r++) {
			const s = this.imgStart + r * this.Puse;
			let low = 0;
			for (let k = 0; k < 20; k++) {
				const a = s + (k * this.Puse) / 20;
				if (this.front.meanF(a, a + this.Puse / 20) < this.fbUse - 150) low++;
			}
			if (low >= 3) {
				keep = r;
				break;
			}
		}
		if (keep < this.rowIdx) {
			this.picture.truncate(keep);
			this.rowIdx = keep;
		}
		this.st.lines = this.rowIdx;
	}

	/** The manual slant (or the free-running period) changed: move the rows already received (row r by r * dP / samples-per-pixel). */
	protected applyManual(): void {
		const m = this.manualPpm;
		if (Math.abs(m - this.appliedManual) < 1e-9 && !this.periodDirty) return;
		this.appliedManual = m;
		this.periodDirty = false;
		const ppm = (this.autoSlant ? this.estPpm : 0) + m;
		const newP = this.Pnom * (1 + ppm * 1e-6);
		const dP = newP - this.Puse;
		const spp = this.Puse / this.imgW;
		this.Puse = newP;
		this.st.slantPpm = ppm;
		if (this.rowIdx < 2 || this.imgW <= 0) return;
		this.picture.shiftRows(this.rowIdx, dP / spp);
	}

	/** Every whole line that has come in becomes a picture row. */
	protected imageLines(): void {
		this.applyManual();
		const W = this.imgW;
		if (this.row.length !== W) this.row = new Uint8Array(W);
		let any = false;
		while (this.front.nAud >= this.imgStart + (this.rowIdx + 1) * this.Puse + 4) {
			if (this.rowIdx >= this.maxLines) {
				this.st.state = 3; // the image stops growing at the line limit
				break;
			}
			const s = this.imgStart + this.rowIdx * this.Puse;
			if (this.rowIdx === 0) this.nvAvg = -1;
			// The picture: through the narrow filter while the signal is weak (or not measured), the wide one when it is strong.
			const wide = this.snrAvg >= WIDE_SNR_DB;
			this.rowTones(s, this.Puse / W, wide);
			if (this.noiseFilter && !wide && W >= 16) this.rowFilter(W);
			const span = this.fwUse - this.fbUse;
			for (let j = 0; j < W; j++) {
				const v = (this.fr[j] - this.fbUse) / span;
				this.row[j] = Math.round(255 * Math.min(1, Math.max(0, v)));
			}
			this.picture.append(this.row);
			this.rowIdx++;
			any = true;
			if (this.freeRun) this.refineRow(s);
		}
		if (any) this.st.lines = this.rowIdx;
	}

	/** The mean frequency of each pixel of the row starting at `s`. */
	private rowTones(s: number, spp: number, wide: boolean): void {
		const W = this.imgW;
		if (this.fr.length !== W) this.fr = new Float64Array(W);
		let prev = this.front.integ(s, wide);
		for (let j = 0; j < W; j++) {
			const nxt = this.front.integ(s + (j + 1) * spp, wide);
			this.fr[j] = (nxt - prev) / spp;
			prev = nxt;
		}
	}

	/**
	 * Row filter (weak signals only, the narrow path): the noise of one pixel from the row itself (1.4826 x the median
	 * |second difference| / sqrt 6, which edges hardly move), then a local Wiener filter over 7 pixels with it: flat
	 * stretches are averaged, the edges of the chart's lines and letters kept.
	 */
	private rowFilter(W: number): void {
		const fr = this.fr;
		if (this.dd.length !== W - 2) this.dd = new Float64Array(W - 2);
		if (this.ff.length !== W) this.ff = new Float64Array(W);
		for (let j = 1; j + 1 < W; j++) this.dd[j - 1] = Math.abs(fr[j - 1] - 2 * fr[j] + fr[j + 1]);
		const sorted = this.dd.slice().sort();
		const sg = (1.4826 * sorted[sorted.length >> 1]) / Math.sqrt(6);
		this.nvAvg = this.nvAvg < 0 ? sg * sg : this.nvAvg + 0.1 * (sg * sg - this.nvAvg);
		for (let j = 0; j < W; j++) {
			let a1 = 0;
			let a2 = 0;
			for (let d = -3; d <= 3; d++) {
				const v = fr[Math.min(W - 1, Math.max(0, j + d))];
				a1 += v;
				a2 += v * v;
			}
			const mu = a1 / 7;
			const lv = Math.max(0, a2 / 7 - mu * mu);
			const g = lv > 1e-12 ? Math.max(0, lv - this.nvAvg) / lv : 0;
			this.ff[j] = mu + g * (fr[j] - mu);
		}
		[this.fr, this.ff] = [this.ff, this.fr];
	}
}
