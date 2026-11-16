// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/tones/tones_rx.cpp (selcalHop), https://github.com/adswill/OnAir;
// see third_party/onair. Changes: FM only, so the ±25 Hz tuning search of OnAir's SSB path is not ported.

import { newEvent, RATE, type ToneAudio } from './audio';
import { goertzel, hann } from './dsp';
import { SELCAL_N, selcalHz, selcalIndex, selcalLetter } from './proto';
import type { ToneEventSink } from './types';

const SEL_N = 800;
const HANN_800 = hann(SEL_N);
/** One hop, s. */
const HOP_SEC = 0.05;

/** Aviation SELCAL: two pairs of the 16-tone plan, each pair about 1 s, read over 100 ms windows every 50 ms. */
export class Selcal {
	private slCur = -1;
	private slRun = 0;
	private slPend = -2;
	private slPendRun = 0;
	private slFirst = '';
	private slFirstEnd = -1e9;
	private readonly win = new Float64Array(SEL_N);
	private readonly f = new Float64Array(SELCAL_N);

	constructor(
		private readonly audio: ToneAudio,
		private readonly sink: ToneEventSink,
	) {}

	reset(): void {
		this.slCur = -1;
		this.slRun = 0;
		this.slPend = -2;
		this.slPendRun = 0;
		this.slFirst = '';
		this.slFirstEnd = -1e9;
	}

	/** The tone pair heard now (low * 16 + high), -1 none. */
	private pair(): number {
		const a = this.audio;
		const { win, f } = this;
		a.tail(SEL_N, win);
		let ew = 0;
		for (let i = 0; i < SEL_N; i++) {
			win[i] *= HANN_800[i];
			ew += win[i] * win[i];
		}
		if (a.now() <= a.dtmfOtherUntil || ew / SEL_N < 12.0 * 12.0) return -1;
		const nf = 3.0 / SEL_N;
		for (let k = 0; k < SELCAL_N; k++) f[k] = (nf * goertzel(win, SEL_N, selcalHz(k), RATE)) / ew;
		let i1 = 0;
		for (let k = 1; k < SELCAL_N; k++) if (f[k] > f[i1]) i1 = k;
		let i2 = i1 === 0 ? 1 : 0;
		for (let k = 0; k < SELCAL_N; k++) if (k !== i1 && f[k] > f[i2]) i2 = k;
		let third = 0;
		for (let k = 0; k < SELCAL_N; k++) if (k !== i1 && k !== i2) third = Math.max(third, f[k]);
		const ok = f[i1] + f[i2] >= 0.65 && f[i2] >= 0.15 && f[i2] >= 0.2 * f[i1] && third <= 0.25 * f[i2];
		return ok ? Math.min(i1, i2) * 16 + Math.max(i1, i2) : -1;
	}

	hop(): void {
		if (this.audio.n8 < SEL_N) return;
		const pair = this.pair();
		if (pair === this.slCur) {
			this.slRun++;
			this.slPend = -2;
			this.slPendRun = 0;
		} else if (pair === this.slPend) {
			if (++this.slPendRun >= 2) {
				if (this.slCur >= 0 && this.slRun >= 11) this.pairEnded(); // at least about 0.55 s
				this.slCur = pair;
				this.slRun = this.slPendRun;
				this.slPend = -2;
				this.slPendRun = 0;
			}
		} else {
			this.slPend = pair;
			this.slPendRun = 1;
		}
		if (this.slFirst && this.audio.now() - this.slFirstEnd > 3.0) this.slFirst = '';
	}

	private pairEnded(): void {
		const p = selcalLetter(this.slCur >> 4) + selcalLetter(this.slCur & 15);
		const end = this.audio.now() - 0.1;
		if (!this.slFirst || end - this.slRun * HOP_SEC - this.slFirstEnd >= 0.8 || p === this.slFirst) {
			this.slFirst = p;
			this.slFirstEnd = end;
			return;
		}
		const code = `${this.slFirst}-${p}`;
		const hz = [...this.slFirst, ...p].map((letter) => selcalHz(selcalIndex(letter)).toFixed(1));
		const event = newEvent(this.audio, 'selcal', {
			system: 'SELCAL',
			text: code,
			label: code,
			detail: `${hz.join(' / ')} Hz`,
			levelDb: this.audio.audioDb,
		});
		event.active = false;
		event.durSec = 2.2;
		this.sink.end(event);
		this.slFirst = '';
	}
}
