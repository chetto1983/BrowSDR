// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/marine/marine_fax.cpp (FaxDecoder: setup, tone and pulse events,
// phasing lock, the line state machine) and core/include/dect2/marine/marine_fax.h, https://github.com/adswill/OnAir;
// see third_party/onair. Changes: one thread, so no locks and no published copies (status and picture are read
// directly); the picture's change marks replace the image sequence number; diagnostics left out.

import { FAX_BLACK_HZ, FAX_CENTRE_HZ, FAX_WHITE_HZ } from './front';
import { faxImageWidth, newFaxStatus } from './core';
import { FaxFreeRun } from './free';
import { continuesChain, FaxEdges } from './pulses';
import { FaxTones } from './tones';
import type { FaxPulse, FaxStatus } from './types';

/** Line rates the phasing lock accepts. */
export const FAX_LPM_CHOICES = [60, 90, 100, 120, 180, 240];

/**
 * Weather fax (HF radiofax) decoder on USB audio: black 1500 Hz, white 2300 Hz, start tone 300 Hz (IOC 576) or
 * 675 Hz (IOC 288), stop tone 450 Hz, phasing lines (a 5 % white pulse on the line boundary). Any audio rate from
 * 8 kHz (12 kHz recommended).
 */
export class FaxDecoder extends FaxFreeRun {
	private readonly tones = new FaxTones();
	private readonly edges = new FaxEdges();
	private pulses: FaxPulse[] = [];
	private chain: FaxPulse[] = [];

	constructor() {
		super();
		this.configure(12000);
	}

	configure(audioRate: number): void {
		const fs = Math.max(4000, audioRate);
		this.front.configure(fs);
		this.edges.configure(fs);
		this.tones.configure(fs);
		this.resetAll();
	}

	/** 60, 90, 100, 120, 180, 240; 0 = detect. */
	setLpm(lpm: number): void {
		this.lpmSet = lpm;
	}

	/** 576 or 288; 0 = from the start tone. */
	setIoc(ioc: number): void {
		this.iocSet = ioc;
	}

	/** Trim of the line period in ppm (positive = a line lasts longer in audio samples); changes the rows already received too. */
	setSlantPpm(ppm: number): void {
		this.manualPpm = Math.min(2000, Math.max(-2000, ppm));
	}

	/** Estimate the slant from the phasing lines (default on); the manual value is added to it. */
	setAutoSlant(on: boolean): void {
		this.autoSlant = on;
	}

	/** Weak signals: the noise-adaptive row filter (default on). */
	setNoiseFilter(on: boolean): void {
		this.noiseFilter = on;
	}

	/** Image height limit, default 8000; the image stops growing there. */
	setMaxLines(n: number): void {
		this.maxLines = Math.max(1, n);
	}

	get lineLimit(): number {
		return this.maxLines;
	}

	reset(): void {
		this.resetAll();
	}

	status(): FaxStatus {
		return { ...this.st };
	}

	push(audio: Float32Array): void {
		const hop = this.tones.hop;
		let i = 0;
		while (i < audio.length) {
			// Sub-blocks end on the tone detector's hop boundaries, so the result does not depend on the chunk size.
			const toGo = hop - (this.front.nAud % hop);
			const take = Math.min(audio.length - i, toGo);
			this.block(audio, i, i + take);
			i += take;
			if (this.front.nAud % hop === 0 && this.front.nAud >= this.tones.nw) this.toneBlock();
			this.lineStep();
		}
	}

	protected clearPulses(): void {
		this.pulses = [];
		this.chain = [];
	}

	private resetAll(): void {
		this.front.reset();
		this.edges.reset();
		this.tones.reset();
		this.dHat = this.dTone = 0;
		this.toneSeen = false;
		this.clearPulses();
		this.locked = false;
		this.fitI = [];
		this.fitC = [];
		this.phIdx = this.failCount = this.firstFail = this.phasingPass = 0;
		this.levelsSeen = false;
		this.fbAvg = FAX_BLACK_HZ;
		this.fwAvg = FAX_WHITE_HZ;
		this.snrAvg = 0;
		this.rowIdx = this.imgW = 0;
		this.resetFree();
		this.st = newFaxStatus();
		this.st.ioc = this.iocSet > 0 ? this.iocSet : 576;
		this.st.lpm = this.lpmSet > 0 ? this.lpmSet : 120;
		this.curLpm = this.st.lpm;
		this.picture.clear();
	}

	private block(a: Float32Array, from: number, to: number): void {
		const front = this.front;
		for (let k = from; k < to; k++) {
			const xin = Number.isFinite(a[k]) ? a[k] : 0; // one NaN would stay in the running sums for good
			const x = front.dcBlock(xin);
			this.tones.put(x);
			const f = front.step(x);
			const pulse = this.edges.step(f, front.nAud, FAX_CENTRE_HZ + this.dHat);
			if (pulse) this.onPulse(pulse);
		}
		front.trim();
	}

	private plausibleSpacing(sp: number): boolean {
		const fs = this.front.fs;
		if (this.lpmSet > 0) {
			const pn = (fs * 60) / this.lpmSet;
			return Math.abs(sp - pn) < 0.03 * pn;
		}
		return sp > (fs * 60) / 260 && sp < (fs * 60) / 55;
	}

	private onPulse(p: FaxPulse): void {
		if (this.st.state === 2) return;
		this.pulses.push(p);
		while (this.pulses.length > 64) this.pulses.shift();
		if (this.locked) return;
		// Chain of equally spaced pulses with the right width.
		if (continuesChain(this.chain, p, (sp) => this.plausibleSpacing(sp))) this.chain.push(p);
		else this.chain = [p];
		if (this.chain.length >= 6) this.tryLock();
	}

	private tryLock(): void {
		const chain = this.chain;
		const fs = this.front.fs;
		const sp = (chain[chain.length - 1].c - chain[0].c) / (chain.length - 1);
		let lpm = this.lpmSet;
		if (lpm <= 0) {
			const est = (60 * fs) / sp;
			lpm = 0;
			for (const cand of FAX_LPM_CHOICES) if (Math.abs(est / cand - 1) < 0.03) lpm = cand;
			if (lpm === 0) {
				this.chain = []; // no standard line rate: the search restarts
				return;
			}
		}
		this.curLpm = this.st.lpm = lpm;
		this.Pnom = (fs * 60) / lpm;
		this.fitI = [];
		this.fitC = [];
		// The first pulse after a start tone is only the second half of a pulse: leave out pulses that are too narrow.
		const ws = chain.map((p) => p.w).sort((x, y) => x - y);
		const wMed = ws[ws.length >> 1];
		chain.forEach((p, i) => {
			if (p.w > 0.8 * wMed) {
				this.fitI.push(i);
				this.fitC.push(p.c);
			}
		});
		this.phIdx = chain.length;
		this.failCount = 0;
		this.phasingPass = chain.length;
		this.levelsSeen = false;
		this.chain = [];
		this.refit();
		this.locked = true;
		if (this.st.state !== 1) {
			this.st.state = 1;
			if (this.iocSet > 0) this.st.ioc = this.iocSet;
		}
	}

	private toneBlock(): void {
		const event = this.tones.block(this.front.nAud, this.st);
		if (!event) return;
		if (event.kind === 3) this.onStopTone();
		else this.onStartTone(event.kind, event.offsetHz);
	}

	private onStartTone(kind: 1 | 2, dMeasured: number): void {
		if (this.st.state === 2) this.truncateRows();
		this.st.state = 1;
		this.locked = false;
		this.freeFrom = this.front.nAud;
		this.clearPulses();
		this.fitI = [];
		this.fitC = [];
		this.phIdx = this.failCount = this.phasingPass = 0;
		this.levelsSeen = false;
		this.fbAvg = FAX_BLACK_HZ;
		this.fwAvg = FAX_WHITE_HZ;
		this.dTone = Math.min(80, Math.max(-80, dMeasured));
		this.toneSeen = true;
		this.dHat = this.dTone;
		this.freeRun = false;
		this.st.ioc = this.iocSet > 0 ? this.iocSet : kind === 1 ? 576 : 288;
		this.st.lpm = this.lpmSet > 0 ? this.lpmSet : 120;
		this.st.phasingLines = 0;
		this.freeHits = 0;
	}

	private onStopTone(): void {
		if (this.st.state === 2) this.truncateRows();
		this.st.state = 3;
		this.locked = false;
		this.clearPulses();
		this.freeRun = false;
		this.freeHits = 0;
		this.freeFrom = this.front.nAud; // the picture before the stop tone is not the next one
	}

	private lineStep(): void {
		const st = this.st;
		if (st.state === 2) this.imageLines();
		else if (st.state === 1 && this.locked) this.phasingLines();
		if (st.state === 3 && this.rowIdx > 0 && this.imgW > 0) this.applyManual(); // the slant setting also straightens a finished picture
		if ((st.state === 0 || st.state === 3) && !this.locked && this.front.nAud >= this.freeNext) this.freeSearch(this.chain.length);
		st.width = this.imgW;
		st.blackHz = this.fbAvg;
	}

	private phasingLines(): void {
		for (;;) {
			const P = this.fitP;
			const b = this.fitA + this.phIdx * P;
			if (this.front.nAud < b + 0.94 * P + 4) break;
			if (this.phasingLine(b, P)) this.fitPulse(b, P);
			else {
				if (this.failCount === 0) this.firstFail = this.phIdx;
				this.failCount++;
			}
			this.phIdx++;
			while (this.pulses.length && this.pulses[0].c < b - 0.02 * P) this.pulses.shift();
			if (this.failCount >= 3) {
				this.startImage(this.firstFail); // three in a row: a fade of a line or two does not end the phasing
				return;
			}
		}
	}

	/**
	 * One phasing line at boundary `b`: contrast, not absolute levels (noise pulls the black level up long before the
	 * pulse stops standing out). The pulse is 5 % wide: just outside it (3.5 .. 6 % either side of the boundary) the line
	 * is black again. A line that passes updates the levels, the mistuning and the SNR.
	 */
	private phasingLine(b: number, P: number): boolean {
		const front = this.front;
		const mid = FAX_CENTRE_HZ + this.dHat;
		const wMean = front.meanF(b - 0.015 * P, b + 0.015 * P);
		const bMean = front.meanF(b + 0.06 * P, b + 0.94 * P);
		const halfLevel = 0.5 * (wMean + bMean);
		const narrow = front.meanF(b - 0.06 * P, b - 0.035 * P) < halfLevel && front.meanF(b + 0.035 * P, b + 0.06 * P) < halfLevel;
		if (!(wMean - bMean > 300 && bMean < mid && narrow)) return false;
		this.failCount = 0;
		this.st.phasingLines = ++this.phasingPass;
		if (!this.levelsSeen) {
			this.fbAvg = bMean;
			this.fwAvg = wMean;
			this.levelsSeen = true;
		} else {
			this.fbAvg += 0.15 * (bMean - this.fbAvg);
			this.fwAvg += 0.15 * (wMean - this.fwAvg);
		}
		this.dHat = Math.min(100, Math.max(-100, this.fbAvg - FAX_BLACK_HZ));
		const m2 = front.meanF2(b + 0.06 * P, b + 0.94 * P);
		const sigma = Math.sqrt(Math.max(1e-6, m2 - bMean * bMean));
		const snr = Math.min(60, 20 * Math.log10(400 / sigma));
		this.snrAvg = this.snrAvg === 0 ? snr : this.snrAvg + 0.1 * (snr - this.snrAvg);
		this.st.snrDb = this.snrAvg;
		return true;
	}

	/** The measured pulse for this line, if the detector saw it near the expected place, joins the line fit. */
	private fitPulse(b: number, P: number): void {
		const p = this.pulses.find((q) => Math.abs(q.c - b) < 0.02 * P && q.w / P > 0.03 && q.w / P < 0.08);
		if (!p) return;
		this.fitI.push(this.phIdx);
		this.fitC.push(p.c);
		this.refit();
	}

	private startImage(kImg: number): void {
		this.imgW = faxImageWidth(this.st.ioc) || faxImageWidth(576);
		const m = this.manualPpm;
		if (this.autoSlant) {
			this.Puse = this.fitP * (1 + m * 1e-6);
			this.estPpm = (this.fitP / this.Pnom - 1) * 1e6;
			this.imgStart = this.fitA + kImg * this.fitP;
		} else {
			this.Puse = this.Pnom * (1 + m * 1e-6);
			let s = 0;
			for (let i = 0; i < this.fitI.length; i++) s += this.fitC[i] - this.fitI[i] * this.Puse;
			this.estPpm = 0;
			this.imgStart = s / this.fitI.length + kImg * this.Puse;
		}
		this.appliedManual = m;
		this.setLevels();
		this.rowIdx = 0;
		this.freeRun = false;
		this.st.state = 2;
		this.st.lines = 0;
		this.st.slantPpm = (this.Puse / this.Pnom - 1) * 1e6;
		this.picture.start(this.imgW);
		this.pulses = [];
		this.imageLines();
	}

	/** Black and white for the picture from the phasing; nominal ones (moved by the mistuning) when the signal is noisy. */
	private setLevels(): void {
		const span = this.fwAvg - this.fbAvg;
		this.fbUse = this.fbAvg;
		this.fwUse = span > 700 && span < 900 ? this.fwAvg : this.fbAvg + (FAX_WHITE_HZ - FAX_BLACK_HZ);
		if (this.snrAvg < 16) {
			// Noise pulls the measured levels towards each other and the black level up: trust the nominal ones, moved by the
			// mistuning measured on the start tone when there was one. Without a start tone the black of the phasing lines
			// still tells the mistuning (its mean over 88 % of each line is pulled up only a few Hz at 15 dB).
			const fromPhasing = this.levelsSeen && Math.abs(this.fbAvg - FAX_BLACK_HZ) <= 130 ? this.fbAvg - FAX_BLACK_HZ : 0;
			this.fbUse = FAX_BLACK_HZ + (this.toneSeen ? this.dTone : fromPhasing);
			this.fwUse = this.fbUse + (FAX_WHITE_HZ - FAX_BLACK_HZ);
		}
	}
}
