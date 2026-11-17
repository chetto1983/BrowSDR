// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/cw/cw_rx.cpp (CwReceiver::Impl: the window spectrum held with a
// fast attack and a slow release, the carriers 10 dB over its median, the skirt test, signals refined, dropped after
// 30 s of silence and merged; per signal the mixer, the triangular decimator to 1 kHz, the +-50 Hz low-pass, the
// envelope detector with its adaptive threshold and the debounce of the adaptive timing (fistKeyer); the report of
// each signal), https://github.com/adswill/OnAir; see third_party/onair. Changes: no focus, sidetone, whole span, kept
// text of gone signals, PSK Reporter or the 0.2.7 timing; the FFT is BrowSDR's (dab/ofdm/fft.ts) and the spectrum is
// kept in a ring.

import { Fft } from '@/worker/decoders/dab/ofdm/fft';
import { FistDecoder } from './fist';
import type { CwEvents, CwSignalInfo } from './types';

/** 24 kHz complex, the dial at 0 Hz. */
export const CW_BASE = 24000;
const N = 2048;
const HOP = 1024;
const BIN_HZ = CW_BASE / N;
/** The skimmer covers -7 kHz .. +7 kHz around the dial. */
export const CW_WINDOW_HZ = 7000;
const HALF = Math.floor(CW_WINDOW_HZ / BIN_HZ);
const W = 2 * HALF + 1;
const DECIM = 24;
const TRI = 2 * DECIM - 1;
const FIR = 65;
const THR_DB = 10;
export const CW_MAX_SIGNALS = 24;
/** Samples of the band between two spectra; the skimmer is fed in blocks of this many. */
export const CW_BLOCK = HOP;

const WINDOW = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
const TRI_W = Float64Array.from({ length: TRI }, (_, j) => (DECIM - Math.abs(j - (DECIM - 1))) / (DECIM * DECIM));

/** +-50 Hz Blackman-windowed sinc at 1 kHz, unity gain. */
const LOWPASS = (() => {
	const fc = 50 / 1000;
	const h = Float64Array.from({ length: FIR }, (_, i) => {
		const m = i - (FIR - 1) / 2;
		const sinc = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
		const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (FIR - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (FIR - 1));
		return sinc * w;
	});
	const s = h.reduce((a, v) => a + v, 0);
	return h.map((v) => v / s);
})();

/** One CW signal: its own mixer, filter, envelope detector and adaptive timing decoder. */
export class CwChannel {
	f = 0;
	private rotR = 1;
	private rotI = 0;
	private stepR = 1;
	private stepI = 0;
	private rotCount = 0;
	private readonly tri = new Float64Array(4 * TRI);
	private triPos = 0;
	private phase = 0;
	private readonly fir = new Float64Array(4 * FIR);
	private firPos = 0;
	// detector
	private init = false;
	private raw = false;
	key = false;
	hi = 0;
	lo = 0;
	readonly fist = new FistDecoder();
	private fKey = false;
	private fStarted = false;
	private fRun = 0;
	private fCnt = 0;
	lastActive: number;
	lastPeak: number;
	chars = 0;
	bad = 0;

	constructor(
		hz: number,
		private readonly now: () => number,
		private readonly onTokens: (chan: CwChannel) => void,
	) {
		this.setFreq(hz);
		this.lastActive = this.lastPeak = now();
	}

	setFreq(hz: number): void {
		this.f = hz;
		const w = (-2 * Math.PI * hz) / CW_BASE;
		this.stepR = Math.cos(w);
		this.stepI = Math.sin(w);
	}

	info(): CwSignalInfo {
		const s = this.fist.stats();
		return {
			hz: this.f,
			wpm: this.fist.wpm,
			snrDb: this.lo > 0 ? 20 * Math.log10(Math.max(1e-6, this.hi) / this.lo) : 0,
			locked: this.fist.locked,
			farnsworth: s.locked && s.charGapDots > 4.2,
		};
	}

	/** One 24 kHz sample: mixed to 0 Hz, decimated to 1 kHz, filtered, then the detector. */
	sample(vr: number, vi: number): void {
		const mr = vr * this.rotR - vi * this.rotI;
		const mi = vr * this.rotI + vi * this.rotR;
		const rr = this.rotR * this.stepR - this.rotI * this.stepI;
		this.rotI = this.rotR * this.stepI + this.rotI * this.stepR;
		this.rotR = rr;
		if (++this.rotCount >= 4096) {
			const a = Math.hypot(this.rotR, this.rotI);
			this.rotR /= a;
			this.rotI /= a;
			this.rotCount = 0;
		}
		const p = 2 * this.triPos;
		this.tri[p] = this.tri[p + 2 * TRI] = mr;
		this.tri[p + 1] = this.tri[p + 2 * TRI + 1] = mi;
		if (++this.triPos >= TRI) this.triPos = 0;
		if (++this.phase < DECIM) return;
		this.phase = 0;
		let dr = 0;
		let di = 0;
		for (let j = 0, k = 2 * this.triPos; j < TRI; j++, k += 2) {
			dr += this.tri[k] * TRI_W[j];
			di += this.tri[k + 1] * TRI_W[j];
		}
		const q = 2 * this.firPos;
		this.fir[q] = this.fir[q + 2 * FIR] = dr;
		this.fir[q + 1] = this.fir[q + 2 * FIR + 1] = di;
		if (++this.firPos >= FIR) this.firPos = 0;
		let yr = 0;
		let yi = 0;
		for (let j = 0, k = 2 * this.firPos; j < FIR; j++, k += 2) {
			yr += this.fir[k] * LOWPASS[j];
			yi += this.fir[k + 1] * LOWPASS[j];
		}
		this.detect(Math.hypot(yr, yi));
	}

	/** The detector and the timing decoder, once a millisecond: a mark level and a noise level, with hysteresis. */
	private detect(e: number): void {
		if (!this.init) {
			this.init = true;
			this.lo = this.hi = e;
		}
		const span = this.hi - this.lo;
		const open = this.hi > 2.8 * this.lo;
		const k = this.raw ? e > this.lo + 0.35 * span : open && e > this.lo + 0.5 * span;
		if (e > this.hi) this.hi += 0.05 * (e - this.hi);
		if (this.raw) this.hi += 0.01 * (e - this.hi);
		else this.lo += (e < this.lo ? 0.05 : 0.004) * (e - this.lo);
		this.hi -= 0.0005 * (this.hi - this.lo);
		this.raw = k;
		this.keyer(k);
		this.key = this.fKey;
		if (this.key) this.lastActive = this.now();
		if (this.fist.ready) this.onTokens(this);
	}

	/** The debounce: a change counts once it has lasted a third of a dot (6 ms before the lock, 3 .. 25 ms). */
	private keyer(raw: boolean): void {
		const d = this.fist;
		const g = d.locked ? Math.max(3, Math.min(25, Math.round(0.33 * d.dotMs))) : 6;
		this.fCnt = raw !== this.fKey ? this.fCnt + 1 : 0;
		this.fRun++;
		if (this.fCnt >= g) {
			const len = this.fRun - this.fCnt;
			if (this.fKey) d.mark(len);
			else if (this.fStarted) d.space(len);
			this.fStarted = true;
			this.fKey = raw;
			this.fRun = this.fCnt;
			this.fCnt = 0;
		}
		if (!this.fKey && this.fStarted && this.fRun % 10 === 0) d.idle(this.fRun);
	}
}

/** Every CW signal within +-7 kHz of the dial (24 kHz complex, the dial at 0 Hz). */
export class CwSkimmer {
	readonly chans: CwChannel[] = [];
	private nBase = 0;
	private readonly fft = new Fft(N);
	private readonly ring = new Float64Array(2 * N);
	private ringPos = 0;
	private filled = 0;
	private readonly re = new Float64Array(N);
	private readonly im = new Float64Array(N);
	private readonly held = new Float64Array(W);
	private readonly sorted = new Float64Array(W);
	private frames = 0;
	floorLin = 0;

	constructor(private readonly events: CwEvents<CwChannel>) {}

	/** Signal seconds. */
	get now(): number {
		return this.nBase / CW_BASE;
	}

	/** Interleaved I/Q of the 24 kHz band. */
	process(x: Float64Array | Float32Array): void {
		const n = x.length >> 1;
		for (let i = 0; i < n; i++) {
			this.ring[2 * this.ringPos] = x[2 * i];
			this.ring[2 * this.ringPos + 1] = x[2 * i + 1];
			this.ringPos = (this.ringPos + 1) % N;
			if (++this.filled >= N && (this.filled - N) % HOP === 0) this.spectrumFrame();
		}
		for (let i = 0; i < n; i++) {
			this.nBase++;
			for (const c of this.chans) c.sample(x[2 * i], x[2 * i + 1]);
		}
	}

	private find(hz: number, tol: number): CwChannel | undefined {
		let best: CwChannel | undefined;
		let bd = tol;
		for (const c of this.chans)
			if (Math.abs(c.f - hz) <= bd) {
				bd = Math.abs(c.f - hz);
				best = c;
			}
		return best;
	}

	private add(hz: number): void {
		const c = new CwChannel(
			hz,
			() => this.now,
			(chan) => {
				const toks = chan.fist.pop();
				if (!toks.length) return;
				for (const t of toks) {
					if (t.text === '*') chan.bad++;
					if (t.text !== ' ') chan.chars++;
				}
				this.events.onText(chan, toks);
			},
		);
		this.chans.push(c);
	}

	/** The keying sidebands of a strong signal: a peak within 500 Hz of one 30 dB stronger is not a signal of its own. */
	private skirt(i: number, v: number): boolean {
		const span = Math.floor(500 / BIN_HZ);
		for (let j = Math.max(0, i - span); j < Math.min(W, i + span + 1); j++) if (this.held[j] > 1000 * v) return true;
		return false;
	}

	/** The held spectrum of the window, and its median (the noise floor). */
	private spectrum(): void {
		const { re, im, held } = this;
		for (let i = 0; i < N; i++) {
			const p = (this.ringPos + i) % N;
			re[i] = this.ring[2 * p] * WINDOW[i];
			im[i] = this.ring[2 * p + 1] * WINDOW[i];
		}
		this.fft.forward(re, im);
		for (let k = -HALF; k <= HALF; k++) {
			const b = (k + N) % N;
			const p = ((re[b] * re[b] + im[b] * im[b]) * 4) / (N * N);
			const h = held[k + HALF];
			held[k + HALF] += (p > h ? 0.6 : 0.04) * (p - h);
		}
		this.sorted.set(held);
		this.sorted.sort();
		this.floorLin = this.sorted[W >> 1];
	}

	/** One row of the window spectrum: carriers found, signals added and refined, dropped and merged. */
	private spectrumFrame(): void {
		this.spectrum();
		if (++this.frames < 12) return; // the first half second: the held spectrum settles
		const thr = this.floorLin * 10 ** (THR_DB / 10);
		const held = this.held;
		const sep = 5; // a peak is the highest within +-58 Hz
		for (let i = sep; i < W - sep; i++) {
			const v = held[i];
			if (v < thr) continue;
			let top = true;
			for (let j = i - sep; j <= i + sep && top; j++) if (j !== i && held[j] > v) top = false;
			if (top) this.peak(i, v);
		}
		this.prune();
	}

	private peak(i: number, v: number): void {
		const held = this.held;
		const a = 10 * Math.log10(held[i - 1] + 1e-20);
		const b = 10 * Math.log10(v + 1e-20);
		const c = 10 * Math.log10(held[i + 1] + 1e-20);
		const den = a - 2 * b + c;
		const d = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
		const hz = (i - HALF + d) * BIN_HZ;
		const ch = this.find(hz, 40);
		if (ch) {
			ch.lastPeak = this.now;
			ch.setFreq(ch.f + 0.05 * (hz - ch.f));
		} else if (!this.find(hz, 60) && this.chans.length < CW_MAX_SIGNALS && !this.skirt(i, v)) this.add(hz);
	}

	/** Signals silent for 30 s are dropped; two that drifted onto each other become one. */
	private prune(): void {
		const now = this.now;
		const chans = this.chans;
		for (let i = 0; i < chans.length;)
			if (now - Math.max(chans[i].lastActive, chans[i].lastPeak) > 30) this.remove(i);
			else i++;
		for (let i = 0; i < chans.length; i++)
			for (let j = i + 1; j < chans.length;)
				if (Math.abs(chans[i].f - chans[j].f) < 25 && chans[j].chars <= chans[i].chars) this.remove(j);
				else j++;
	}

	private remove(i: number): void {
		const [c] = this.chans.splice(i, 1);
		this.events.onRemoved(c);
	}
}
