// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/tones/tones_rx.cpp (longHop, endLong: the strongest pure tone and
// the two-tone sequential paging detector), https://github.com/adswill/OnAir; see third_party/onair. Changes: the
// audio spectrum display is not ported.

import { FULL, newEvent, RATE, type ToneAudio } from './audio';
import { fft, hann } from './dsp';
import type { ToneEvent, ToneEventSink } from './types';

const LONG_N = 512;
const LONG_HOP = 256;
const HANN_512 = hann(LONG_N);
const HOP_SEC = LONG_HOP / RATE;
const tol = (x: number) => 0.015 * x + 6;

/** A pure tone over 512 samples every 32 ms; a tone of 0.25 - 2 s followed at once by another of 0.8 s and more is a page. */
export class TwoTone {
	/** The strongest pure tone now (0 none). */
	toneHz = 0;
	toneDb = -200;
	private ltF = 0;
	private ltRun = 0;
	private ltStart = 0;
	private ltPendF = 0;
	private ltPendRun = 0;
	private ltGone = 0;
	private ltEmitted = false;
	private ltEv: ToneEvent | null = null;
	/** The tone before: frequency, length, end. */
	private ltLast = { f: 0, dur: 0, end: -1e9 };
	private readonly re = new Float64Array(LONG_N);
	private readonly im = new Float64Array(LONG_N);
	private readonly pw = new Float64Array(LONG_N / 2);
	private readonly win = new Float64Array(LONG_N);

	constructor(
		private readonly audio: ToneAudio,
		private readonly sink: ToneEventSink,
	) {}

	reset(): void {
		this.ltF = this.ltRun = this.ltPendRun = this.ltGone = 0;
		this.ltEmitted = false;
		this.ltEv = null;
		this.ltLast = { f: 0, dur: 0, end: -1e9 };
		this.toneHz = 0;
		this.toneDb = -200;
	}

	/** The event in progress (for a flush before reset()). */
	active(): ToneEvent[] {
		return this.ltEv ? [this.ltEv] : [];
	}

	/** The pure tone of the newest window, Hz; 0 none. */
	private pureTone(): number {
		const { re, im, pw, win } = this;
		this.audio.tail(LONG_N, win);
		let e = 0;
		for (let i = 0; i < LONG_N; i++) {
			re[i] = win[i] * HANN_512[i];
			im[i] = 0;
			e += win[i] * win[i];
		}
		fft(re, im);
		let total = 0;
		for (let k = 0; k < LONG_N / 2; k++) {
			pw[k] = re[k] * re[k] + im[k] * im[k];
			if (k >= 8) total += pw[k];
		}
		const loud = e / LONG_N >= 20.0 * 20.0;
		let pk = 20;
		for (let k = 21; k < 225; k++) if (pw[k] > pw[pk]) pk = k;
		const p3 = pw[pk - 1] + pw[pk] + pw[pk + 1];
		if (!(loud && total > 0 && p3 / total >= 0.5 && this.audio.now() > this.audio.dtmfOtherUntil)) {
			this.toneHz = 0;
			this.toneDb = -200;
			return 0;
		}
		const [l0, l1, l2] = [Math.log(pw[pk - 1] + 1e-30), Math.log(pw[pk] + 1e-30), Math.log(pw[pk + 1] + 1e-30)];
		const den = l0 - 2 * l1 + l2;
		const d = den < -1e-9 ? (0.5 * (l0 - l2)) / den : 0.0;
		this.toneHz = ((pk + Math.max(-0.5, Math.min(0.5, d))) * RATE) / LONG_N;
		this.toneDb = 10 * Math.log10((16 * (p3 / 1.125)) / (LONG_N * LONG_N * FULL * FULL) + 1e-12);
		return this.toneHz;
	}

	hop(): void {
		if (this.audio.n8 < LONG_N) return;
		const f = this.pureTone();
		const tnow = this.audio.now();
		// tracking
		if (f > 0 && this.ltF > 0 && Math.abs(f - this.ltF) <= tol(this.ltF)) {
			this.ltF += (f - this.ltF) / Math.min(this.ltRun + 1, 8);
			this.ltRun++;
			this.ltGone = this.ltPendRun = 0;
		} else if (f > 0) {
			if (this.ltPendRun > 0 && Math.abs(f - this.ltPendF) <= tol(this.ltPendF)) this.ltPendRun++;
			else {
				this.ltPendF = f;
				this.ltPendRun = 1;
			}
			if (this.ltF <= 0 || this.ltPendRun >= 2) {
				if (this.ltF > 0) this.endLong(tnow - HOP_SEC * this.ltPendRun);
				this.ltF = f;
				this.ltRun = this.ltPendRun;
				this.ltStart = tnow - HOP_SEC * this.ltPendRun;
				this.ltPendRun = 0;
				this.ltEmitted = false;
				this.ltGone = 0;
			}
		} else {
			this.ltPendRun = 0;
			if (this.ltF > 0 && ++this.ltGone >= 2) this.endLong(tnow - HOP_SEC * 2);
		}
		// the second tone of a pair is long enough: report it, and keep its length up to date
		if (this.ltF > 0 && this.ltRun >= 3) this.secondTone(tnow - this.ltStart);
	}

	private secondTone(dur: number): void {
		const { ltLast: last, ltF } = this;
		if (
			!this.ltEmitted &&
			dur >= 0.8 &&
			last.f > 0 &&
			this.ltStart - last.end < 0.3 &&
			last.dur >= 0.25 &&
			last.dur <= 2.0 &&
			Math.abs(last.f - ltF) > 0.04 * ltF
		) {
			const text = `${last.f.toFixed(1)} + ${ltF.toFixed(1)} Hz`;
			this.ltEv = newEvent(this.audio, 'twoTone', { system: 'Two-tone', text, label: text, detail: '', levelDb: this.toneDb });
			this.ltEmitted = true;
			this.sink.begin(this.ltEv);
		}
		if (this.ltEmitted && this.ltEv) {
			this.ltEv.durSec = last.dur + dur;
			this.ltEv.detail = `tone A ${last.dur.toFixed(1)} s, tone B ${dur.toFixed(1)} s`;
		}
	}

	private endLong(endSec: number): void {
		if (this.ltF > 0 && this.ltRun >= 3) this.ltLast = { f: this.ltF, dur: Math.max(0, endSec - this.ltStart), end: endSec };
		else if (this.ltF > 0) this.ltLast = { f: 0, dur: 0, end: -1e9 };
		if (this.ltEmitted) {
			if (this.ltEv) {
				this.ltEv.active = false;
				this.sink.end(this.ltEv);
			}
			this.ltLast = { f: 0, dur: 0, end: -1e9 };
		}
		this.ltEv = null;
		this.ltEmitted = false;
		this.ltF = this.ltRun = this.ltGone = 0;
	}
}
