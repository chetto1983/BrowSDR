// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/hfdig/hfdig_rtty.cpp (HfdigRtty: feedAudio, the Auto rule of
// autoTick, reset, the telemetry) and core/src/hfdig/hfdig_rx.cpp (the upper sideband audio every HF decoder gets, RTTY
// with Auto on), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the channel is complex baseband at 8 kHz centred 2 kHz above the dial (the USB audio 200 .. 3800 Hz);
// shifting it back and taking the real part gives the audio OnAir's decoder gets, without OnAir's sideband AGC (every
// decision of the decoder is a ratio). The audio goes to the decoder in blocks of 50 ms, so the Auto rule sees the
// same audio whatever the size of the blocks the worker hands over. OnAir runs the Auto analysis on a thread; here it
// is a generator advanced a step at a time after each block, for a share of the block's duration. Instead of OnAir's
// text, records at line ends, at 80 characters and after 2 s without a character; the line being received is in the
// status. The speed, shift and polarity Auto starts from are set by the catalog entry. No one-click autoLock, results
// file or whole span.

import { TextLines } from '@/worker/decoders/digimode/lines';
import type { DigimodeDecoder, DigimodeSink } from '@/worker/decoders/digimode/types';
import { rttyAutoAnalyse } from './auto';
import { RTTY_RATE, RttyDecoder } from './decoder';
import type { RttyAutoHyp, RttyOptions, RttySettings, RttyStatus } from './types';

export { RTTY_RATE };
/** The channel is centred this far above the dial, 3.6 kHz wide (200 .. 3800 Hz audio). */
export const RTTY_OFFSET_HZ = 2000;
export const RTTY_BANDWIDTH = 3600;
const BLOCK = 400;
const HIST = 20 * RTTY_RATE;
/** Seconds of health kept by the Auto rule. */
const AUTO_WIN = 8;
const PAUSE_SEC = 2;
const SLICE_SHARE = 0.4;
const SLICE_MIN_MS = 4;
const SLICE_MAX_MS = 40;
/** The amateur polarity in the upper sideband is reversed (the mark is the higher RF frequency). */
export const RTTY_AMATEUR: RttySettings = { baudIdx: 0, shiftIdx: 0, reverse: true };

const polarity = (reverse: boolean) => (reverse ? 'reversed (mark is the upper tone)' : 'normal (mark is the lower tone)');

/** RTTY on the upper sideband: the pair of tones found in 300 .. 3300 Hz, speed, shift and polarity by Auto. */
export class RttyReceiver implements DigimodeDecoder {
	readonly dec = new RttyDecoder((ch) => this.lines.put(ch, this.dec.pos / RTTY_RATE));
	private readonly lines = new TextLines((line) => this.record(line), PAUSE_SEC);
	private settings: RttySettings;
	private dirty = false;
	private readonly autoOn: boolean;
	private readonly sliceMs: number | undefined;
	private autoKick: boolean;
	private job: Generator<void, RttyAutoHyp[]> | null = null;
	private jobResult: RttyAutoHyp[] | null = null;
	private autoLocked = false;
	private autoLastRun = 0;
	private autoSecAt = 0;
	private autoCharsSeen = 0;
	private autoErrsSeen = 0;
	private autoGrace = 0;
	private readonly winChars = new Int32Array(AUTO_WIN);
	private readonly winErrs = new Int32Array(AUTO_WIN);
	private winPos = 0;
	private readonly hist = new Float32Array(HIST);
	private histPos = 0;
	private histFill = 0;
	/** 0 not run, 1 analysing, 2 found and applied, 3 nothing found. */
	autoState = 0;
	autoHyps: RttyAutoHyp[] = [];
	private audio = new Float32Array(0);
	private n = 0;
	private errorsAtLine = 0;
	private lastStatus = '';

	constructor(
		private readonly sink: DigimodeSink,
		options: RttyOptions = { start: RTTY_AMATEUR },
	) {
		this.settings = { ...options.start };
		this.dec.configure(this.settings);
		this.autoOn = options.auto ?? true;
		this.autoKick = this.autoOn;
		this.sliceMs = options.sliceMs;
	}

	process(iq: Float32Array): void {
		const count = iq.length >> 1;
		if (this.audio.length < count) this.audio = new Float32Array(count);
		// the dial back to 0 Hz: times exp(j pi n / 2), the real part
		for (let i = 0; i < count; i++) {
			const [re, im] = [iq[2 * i], iq[2 * i + 1]];
			const k = this.n++ & 3;
			this.audio[i] = k === 0 ? re : k === 1 ? -im : k === 2 ? -re : im;
		}
		const budget = this.sliceMs ?? Math.min(SLICE_MAX_MS, Math.max(SLICE_MIN_MS, (SLICE_SHARE * count * 1000) / RTTY_RATE));
		const deadline = performance.now() + budget;
		for (let off = 0; off < count; off += BLOCK) {
			this.feedAudio(this.audio.subarray(off, Math.min(count, off + BLOCK)));
			this.work(deadline);
		}
		this.updateStatus();
	}

	/** A gap in the audio (OnAir's resetAll): the decoder and Auto start again. */
	reset(): void {
		this.lines.flush();
		this.dec.reset();
		this.n = 0;
		this.histPos = this.histFill = 0;
		this.job = null;
		this.jobResult = null;
		this.autoLocked = false;
		this.autoLastRun = this.autoSecAt = 0;
		this.autoState = 0;
		this.autoHyps = [];
		this.autoCharsSeen = this.dec.chars;
		this.autoErrsSeen = this.dec.framingErrors;
		this.lastStatus = '';
	}

	/** Speed, shift and polarity in use. */
	get current(): RttySettings {
		return { ...this.settings };
	}

	private feedAudio(x: Float32Array): void {
		if (this.dirty) {
			this.dirty = false;
			this.dec.configure(this.settings);
		}
		for (let i = 0; i < x.length; i++) {
			this.hist[this.histPos] = x[i];
			if (++this.histPos >= HIST) this.histPos = 0;
		}
		this.histFill = Math.min(HIST, this.histFill + x.length);
		this.dec.run(x);
		this.autoTick();
		this.lines.tick(this.dec.pos / RTTY_RATE);
	}

	/** Advances the Auto analysis until the deadline (at least one step). */
	private work(deadline: number): void {
		if (!this.job) return;
		do {
			const r = this.job.next();
			if (r.done) {
				this.jobResult = r.value;
				this.job = null;
				return;
			}
		} while (performance.now() < deadline);
	}

	/**
	 * The Auto rule. Lock lost means: the window has no text, or mostly framing errors. A signal that goes away or
	 * changes speed lands here, and the analysis runs every few seconds until it finds one; a good lock is never
	 * second-guessed, so a working decode is left alone.
	 */
	private autoTick(): void {
		const dec = this.dec;
		if (this.autoKick) {
			this.autoKick = false;
			this.autoLocked = false;
			this.autoLastRun = 0;
			this.autoSecAt = dec.pos;
			this.autoCharsSeen = dec.chars;
			this.autoErrsSeen = dec.framingErrors;
			this.winChars.fill(0);
			this.winErrs.fill(0);
		}
		if (!this.autoOn || this.job) return;
		if (this.jobResult) {
			this.applyResult(this.jobResult);
			this.jobResult = null;
			return;
		}
		this.healthBuckets();
		if (this.autoLocked || this.histFill < 6 * RTTY_RATE || dec.pos - this.autoLastRun < 4 * RTTY_RATE) return;
		this.autoLastRun = dec.pos;
		const take = Math.min(this.histFill, 8 * RTTY_RATE);
		const a = new Float32Array(take);
		const start = (this.histPos + HIST - take) % HIST;
		for (let i = 0; i < take; i++) a[i] = this.hist[(start + i) % HIST];
		if (this.autoState !== 2) this.autoState = 1;
		this.job = rttyAutoAnalyse(a, 3);
	}

	/** One bucket of characters and framing errors per second; the lock is given up when the window goes bad. */
	private healthBuckets(): void {
		const dec = this.dec;
		while (dec.pos - this.autoSecAt >= RTTY_RATE) {
			this.autoSecAt += RTTY_RATE;
			this.winPos = (this.winPos + 1) % AUTO_WIN;
			this.winChars[this.winPos] = dec.chars - this.autoCharsSeen;
			this.winErrs[this.winPos] = dec.framingErrors - this.autoErrsSeen;
			this.autoCharsSeen = dec.chars;
			this.autoErrsSeen = dec.framingErrors;
			if (this.autoGrace > 0) {
				this.autoGrace--;
				continue;
			}
			if (this.autoLocked) {
				const c = this.winChars.reduce((s, v) => s + v, 0);
				const e = this.winErrs.reduce((s, v) => s + v, 0);
				if (c === 0 || (c + e >= 12 && e > c)) {
					this.autoLocked = false;
					this.autoLastRun = 0;
					this.autoState = 0;
				}
			}
		}
	}

	/** The analysis' answer: its best guess replaces the settings (nothing is rebuilt when they are the same). */
	private applyResult(hyps: RttyAutoHyp[]): void {
		if (!hyps.length) {
			this.autoState = 3;
			return;
		}
		this.autoHyps = hyps;
		const h = hyps[0];
		const s = this.settings;
		if (s.baudIdx !== h.baudIdx || s.shiftIdx !== h.shiftIdx || s.reverse !== h.reverse) {
			this.settings = { ...s, baudIdx: h.baudIdx, shiftIdx: h.shiftIdx, reverse: h.reverse };
			this.dec.fixedLo = 0;
			this.dirty = true;
		}
		this.autoState = 2;
		this.autoLocked = true;
		this.autoCharsSeen = this.dec.chars;
		this.autoErrsSeen = this.dec.framingErrors;
		this.winChars.fill(0);
		this.winErrs.fill(0);
		this.autoSecAt = this.dec.pos;
		this.autoGrace = 4;
	}

	private record(line: string): void {
		const st = this.dec.status();
		const errors = st.framingErrors - this.errorsAtLine;
		this.errorsAtLine = st.framingErrors;
		const fields: Array<[string, string]> = [
			['Mode', 'RTTY'],
			['Speed', `${st.baud} Bd`],
			['Shift', `${st.shiftHz} Hz`],
		];
		if (st.markHz > 0) fields.push(['Mark', `${Math.round(st.markHz)} Hz`], ['Space', `${Math.round(st.spaceHz)} Hz`]);
		fields.push(
			['Polarity', polarity(st.reverse)],
			['Quality', `${Math.round(100 * st.quality)} %`],
			['Framing errors', String(errors)],
			['Settings', this.autoState === 2 ? 'found by Auto' : 'as chosen'],
		);
		this.sink.record({ text: line, fields });
	}

	private statusText(st: RttyStatus): string {
		const mode = `${st.baud} Bd ${st.shiftHz} Hz ${st.reverse ? 'reversed' : 'normal'}`;
		const auto = this.autoState === 1 ? ', Auto is looking at the signal' : '';
		if (st.state === 0) return `Looking for RTTY tones (${mode}) between 300 and 3300 Hz${auto}`;
		const tones = `mark ${Math.round(st.markHz)} Hz, space ${Math.round(st.spaceHz)} Hz`;
		const live = this.lines.line ? `: ${this.lines.tail(80)}` : '';
		return `RTTY ${mode}, ${tones}, quality ${10 * Math.round(10 * st.quality)} %${auto}${live}`;
	}

	private updateStatus(): void {
		const st = this.dec.status();
		const message = this.statusText(st);
		if (message === this.lastStatus) return;
		this.lastStatus = message;
		this.sink.status(message, st.state > 0);
	}
}
