// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/psk/psk_rx.cpp (PskReceiver::Impl: setupMode, the window
// spectrum held with a fast attack and a slow release, the peak search with its skirt test, new signals and their
// replay of the last 1.5 s, signals dropped after 40 s of silence or merged when they meet, process),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: no focus, no kept text of gone signals (the records
// are the log), no Auto, whole span, Listen or PSK Reporter; the FFT is BrowSDR's (dab/ofdm/fft.ts) and the spectrum
// is kept in a ring.

import { Fft } from '@/worker/decoders/dab/ofdm/fft';
import { matchedFilter, PSK_BASE, PskChannel } from './channel';
import type { PskEvents, PskMode } from './types';

const N = 4096;
const HOP = 2048;
const BIN_HZ = PSK_BASE / N;
/** The audio passband searched: dial + 100 Hz .. dial + 3.9 kHz. */
export const PSK_LO_HZ = 100;
export const PSK_HI_HZ = 3900;
const LO_BIN = Math.floor(PSK_LO_HZ / BIN_HZ) + 1;
const HI_BIN = Math.floor(PSK_HI_HZ / BIN_HZ);
const W = HI_BIN - LO_BIN + 1;
export const PSK_MAX_SIGNALS = 24;
const REPLAY = Math.round(1.5 * PSK_BASE);
/** How far over the noise floor a signal must be to get a decoder (OnAir's default). */
const THR_DB = 5;
/** Samples of the 24 kHz band between two spectra; the receiver is fed in blocks of this many. */
export const PSK_BLOCK = HOP;

const WINDOW = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));

/** Every PSK signal of one modulation between dial + 100 Hz and dial + 3.9 kHz (24 kHz complex, the dial at 0 Hz). */
export class PskReceiver {
	readonly chans: PskChannel[] = [];
	private readonly sps: number;
	private readonly h: Float64Array;
	private nBase = 0;
	private readonly fft = new Fft(N);
	private readonly ring = new Float64Array(2 * N);
	private ringPos = 0;
	private filled = 0;
	private readonly re = new Float64Array(N);
	private readonly im = new Float64Array(N);
	private readonly held = new Float64Array(W);
	private readonly sm = new Float64Array(W);
	private readonly sorted = new Float64Array(W);
	private frames = 0;
	private readonly hist = new Float64Array(2 * REPLAY);
	private histPos = 0;

	constructor(
		readonly mode: PskMode,
		private readonly events: PskEvents<PskChannel>,
	) {
		({ sps: this.sps, h: this.h } = matchedFilter(mode));
	}

	/** Signal seconds. */
	get now(): number {
		return this.nBase / PSK_BASE;
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
			const [vr, vi] = [x[2 * i], x[2 * i + 1]];
			this.nBase++;
			for (const c of this.chans) c.sample(vr, vi);
			this.hist[2 * this.histPos] = vr;
			this.hist[2 * this.histPos + 1] = vi;
			if (++this.histPos >= REPLAY) this.histPos = 0;
		}
	}

	private find(hz: number, tol: number): PskChannel | undefined {
		let best: PskChannel | undefined;
		let bd = tol;
		for (const c of this.chans)
			if (Math.abs(c.f - hz) <= bd) {
				bd = Math.abs(c.f - hz);
				best = c;
			}
		return best;
	}

	private add(hz: number): PskChannel {
		const c: PskChannel = new PskChannel(
			hz,
			this.mode,
			this.sps,
			this.h,
			() => this.now,
			(ch) => this.events.onChar(c, ch),
			() => this.events.onDcdLost(c),
		);
		this.chans.push(c);
		return c;
	}

	/**
	 * A signal found in the spectrum: the last seconds of the band go through its new receiver first, so that it locks
	 * during the idle reversals before the text instead of losing the first words.
	 */
	private replay(c: PskChannel): void {
		for (let k = 0; k < REPLAY; k++) {
			const p = (this.histPos + k) % REPLAY;
			c.sample(this.hist[2 * p], this.hist[2 * p + 1]);
		}
	}

	/** The held spectrum of the passband, and its median (the noise floor). */
	private spectrum(): number {
		const { re, im, held } = this;
		for (let i = 0; i < N; i++) {
			const p = (this.ringPos + i) % N;
			re[i] = this.ring[2 * p] * WINDOW[i];
			im[i] = this.ring[2 * p + 1] * WINDOW[i];
		}
		this.fft.forward(re, im);
		for (let i = 0; i < W; i++) {
			const k = LO_BIN + i;
			const p = ((re[k] * re[k] + im[k] * im[k]) * 4) / (N * N);
			held[i] += (p > held[i] ? 0.5 : 0.05) * (p - held[i]);
		}
		this.sorted.set(held);
		this.sorted.sort();
		return this.sorted[W >> 1];
	}

	/** One row of the window spectrum: signals found, added and refined, dropped and merged. */
	private spectrumFrame(): void {
		const floor = this.spectrum();
		if (++this.frames < 3) return;
		const baud = this.mode.baud;
		const w = Math.max(1, Math.round((0.6 * baud) / BIN_HZ));
		for (let i = 0; i < W; i++) {
			let s = 0;
			let n = 0;
			for (let j = Math.max(0, i - w); j <= Math.min(W - 1, i + w); j++, n++) s += this.held[j];
			this.sm[i] = n ? s / n : 0;
		}
		const thr = floor * 10 ** (THR_DB / 10);
		const sep = Math.max(2, Math.round((1.5 * baud) / BIN_HZ));
		for (let i = 1; i < W - 1; i++) if (this.sm[i] >= thr && this.isTop(i, sep)) this.peak(i);
		this.prune();
	}

	private isTop(i: number, sep: number): boolean {
		const v = this.sm[i];
		for (let j = Math.max(0, i - sep); j <= Math.min(W - 1, i + sep); j++)
			if (j !== i && (this.sm[j] > v || (this.sm[j] === v && j < i))) return false;
		return true;
	}

	/** A peak of the smoothed spectrum: refines its signal, or starts a new one. */
	private peak(i: number): void {
		const sm = this.sm;
		const baud = this.mode.baud;
		const [a, b, c] = [sm[i - 1], sm[i], sm[i + 1]];
		const den = a - 2 * b + c;
		const d = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
		const hz = (LO_BIN + i + d) * BIN_HZ;
		// the IMD products and keying sidebands of a much stronger signal are not signals of their own
		let skirt = false;
		const span = Math.floor((3 * baud) / BIN_HZ);
		for (let j = Math.max(0, i - span); j <= Math.min(W - 1, i + span); j++) if (sm[j] > 300 * b) skirt = true;
		const ch = this.find(hz, 0.8 * baud);
		if (ch) {
			ch.lastPeak = this.now;
			if (!ch.dcd) {
				ch.setFreq(ch.f + 0.1 * (hz - ch.f));
				ch.f0 = ch.f;
			}
		} else if (!skirt && !this.find(hz, 1.4 * baud) && this.chans.length < PSK_MAX_SIGNALS) this.replay(this.add(hz));
	}

	/** Signals silent for 40 s are dropped; two that drifted onto each other become one. */
	private prune(): void {
		const now = this.now;
		const baud = this.mode.baud;
		const chans = this.chans;
		for (let i = 0; i < chans.length;)
			if (now - Math.max(chans[i].lastActive, chans[i].lastPeak) > 40) this.remove(i);
			else i++;
		for (let i = 0; i < chans.length; i++)
			for (let j = i + 1; j < chans.length;) {
				const near = Math.abs(chans[i].f - chans[j].f) < 0.5 * baud;
				if (near && chans[j].chars <= chans[i].chars) this.remove(j);
				else if (near && chans[i].chars < chans[j].chars) {
					this.remove(i);
					j = i + 1;
				} else j++;
			}
	}

	private remove(i: number): void {
		const [c] = this.chans.splice(i, 1);
		this.events.onRemoved(c);
	}
}
