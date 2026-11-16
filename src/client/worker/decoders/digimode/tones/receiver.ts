// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/tones/tones_rx.cpp (TonesReceiver::Impl: process8, the hop
// schedule of every detector, resetState), https://github.com/adswill/OnAir; see third_party/onair. Changes: the audio
// level is updated every 2000 samples inside the loop (not at the end of a call), the telemetry, gate and listening
// output are not ported, and reset() hands the events in progress to the sink before it forgets them.

import { FULL, ToneAudio } from './audio';
import { Biquad } from './dsp';
import { Selcal } from './selcal';
import { SubAudible } from './subaudible';
import { TwoTone } from './twotone';
import type { ToneEvent, ToneEventSink } from './types';
import { VoiceBand } from './voice';

const DTMF_HOP = 80;
const SEQ_HOP = 64;
const SEL_HOP = 400;
const LONG_HOP = 256;
const CTCSS_HOP = 100;
const DCS_HOP = 64;
const LEVEL_BLOCK = 2000;

/**
 * Tone decoders on 8 kHz audio in Hz of deviation: CTCSS (50 tones), DCS (23 bit Golay word, both polarities), DTMF,
 * five-tone sequential calling (ZVEI1 / ZVEI2, CCIR, EEA, EIA, DZVEI), SELCAL, and a generic two-tone sequential paging
 * detector. CTCSS and DCS use a 300 Hz low-pass at 1 kHz; the voice band decoders work on Goertzel filters over short
 * windows.
 */
export class TonesReceiver {
	readonly audio = new ToneAudio();
	readonly sub: SubAudible;
	readonly voice: VoiceBand;
	readonly selcal: Selcal;
	readonly twoTone: TwoTone;
	// 4th order Butterworth
	private readonly lp1 = new Biquad().lowpass(300, 8000, 0.5412);
	private readonly lp2 = new Biquad().lowpass(300, 8000, 1.3066);
	private decimCnt = 0;
	private sumsq = 0;
	private cntsq = 0;

	constructor(private readonly sink: ToneEventSink) {
		this.sub = new SubAudible(this.audio, sink);
		this.voice = new VoiceBand(this.audio, sink);
		this.selcal = new Selcal(this.audio, sink);
		this.twoTone = new TwoTone(this.audio, sink);
	}

	/** Signal seconds. */
	now(): number {
		return this.audio.now();
	}

	process(a: Float32Array): void {
		const au = this.audio;
		for (let i = 0; i < a.length; i++) {
			const x = a[i];
			this.sumsq += x * x;
			if (++this.cntsq >= LEVEL_BLOCK) {
				au.audioDb = 10 * Math.log10(this.sumsq / this.cntsq / (FULL * FULL) + 1e-12);
				this.sumsq = this.cntsq = 0;
			}
			au.ring[au.n8 & (au.ring.length - 1)] = x;
			au.n8++;
			const y = this.lp2.step(this.lp1.step(x));
			if (++this.decimCnt === 8) {
				this.decimCnt = 0;
				au.ring1k[au.n1k & (au.ring1k.length - 1)] = y;
				au.n1k++;
				if (au.n1k % DCS_HOP === 0) this.sub.dcsHop();
				if (au.n1k % CTCSS_HOP === 0) this.sub.ctcssHop();
			}
			if (au.n8 % DTMF_HOP === 0) this.voice.dtmfHop();
			if (au.n8 % SEQ_HOP === 0) this.voice.seqHop();
			if (au.n8 % SEL_HOP === 0) this.selcal.hop();
			if (au.n8 % LONG_HOP === 0) this.twoTone.hop();
		}
	}

	/** The signal only: the events in progress end now. */
	reset(): void {
		const now = this.audio.now();
		for (const event of [...this.sub.active(), ...this.voice.active(), ...this.twoTone.active()]) this.close(event, now);
		this.audio.reset();
		this.lp1.reset();
		this.lp2.reset();
		this.decimCnt = 0;
		this.sumsq = this.cntsq = 0;
		this.sub.reset();
		this.voice.reset();
		this.selcal.reset();
		this.twoTone.reset();
	}

	private close(event: ToneEvent, now: number): void {
		event.active = false;
		if (event.kind === 'ctcss' || event.kind === 'dcs') event.durSec = Math.max(0, now - event.timeSec);
		this.sink.end(event);
	}
}
