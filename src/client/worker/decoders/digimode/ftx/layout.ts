// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/hfdig/hfdig_ftx.cpp (Resampler, the streams, layoutOf, logI0)
// and core/src/hfdig/hfdig_usb.h (lowpass), https://github.com/adswill/OnAir; see third_party/onair. Changes: one
// stream per decoder (the mode it runs); the resampled audio is kept in a growable Float32Array.

import { kaiserLowpass } from '@/worker/decoders/digimode/sstv/phase';
import { FT4_COSTAS, FT8_COSTAS, WSPR_SYNC } from './tables';
import type { FtxLayout, FtxMode } from './types';
import { FT8, FT4, spec } from './wave';

/** The audio every decoder gets (OnAir's kHfdigAudioRate): the upper sideband at 8 kHz. */
export const AUDIO_RATE = 8000;
/** Taps per polyphase branch. */
const KP = 48;

/** 8 kHz -> the mode's rate, polyphase L / M. */
export class Resampler {
	private readonly h: Float32Array;
	private readonly hist = new Float32Array(2 * KP);
	private pos = 0;
	private consumed = 0;
	private made = 0;

	constructor(
		private readonly L: number,
		private readonly M: number,
		cutHz: number,
	) {
		const h = kaiserLowpass(L * KP, cutHz / (L * AUDIO_RATE), 8);
		this.h = Float32Array.from(h, (v) => v * L);
	}

	reset(): void {
		this.hist.fill(0);
		this.pos = this.consumed = this.made = 0;
	}

	/** The input sample (8 kHz, fractional) at the centre of output sample j. */
	inputPos(j: number): number {
		return (j * this.M - (this.L * KP - 1) * 0.5) / this.L;
	}

	outputPos(k: number): number {
		return (k * this.L + (this.L * KP - 1) * 0.5) / this.M;
	}

	process(x: ArrayLike<number>, out: SampleStore): void {
		const { L, M, h, hist } = this;
		for (let i = 0; i < x.length; i++) {
			hist[this.pos] = hist[this.pos + KP] = x[i];
			if (++this.pos >= KP) this.pos = 0;
			this.consumed++;
			// outputs whose newest input is this one
			for (;;) {
				const u = this.made * M;
				const last = Math.floor(u / L);
				if (last > this.consumed - 1) break;
				const ph = u % L;
				const back = this.consumed - 1 - last;
				const w = this.pos + KP - 1 - back;
				let acc = 0;
				for (let k = 0; k < KP - back; k++) acc += h[ph + k * L] * hist[w - k];
				out.push(acc);
				this.made++;
			}
		}
	}
}

/** Audio of a stream: the samples from index `base` on. */
export class SampleStore {
	data = new Float32Array(1 << 16);
	length = 0;
	base = 0;

	push(v: number): void {
		if (this.length === this.data.length) {
			const grown = new Float32Array(this.data.length * 2);
			grown.set(this.data);
			this.data = grown;
		}
		this.data[this.length++] = v;
	}

	/** Forgets the oldest `n` samples. */
	drop(n: number): void {
		const d = Math.min(this.length, Math.max(0, Math.floor(n)));
		if (!d) return;
		this.data.copyWithin(0, d, this.length);
		this.length -= d;
		this.base += d;
	}

	clear(): void {
		this.length = 0;
		this.base = 0;
	}

	/** Sample with absolute index k, 0 outside what is kept. */
	at(k: number): number {
		const i = k - this.base;
		return i >= 0 && i < this.length ? this.data[i] : 0;
	}
}

/** The stream of a mode: FT8 at 6400 Hz, FT4 at 10667 Hz, WSPR at 12000 Hz (L / M of 8 kHz and the low-pass cut). */
export function streamOf(mode: FtxMode): { L: number; M: number; cut: number } {
	if (mode === FT8) return { L: 4, M: 5, cut: 3080 };
	if (mode === FT4) return { L: 4, M: 3, cut: 3900 };
	return { L: 3, M: 2, cut: 3900 };
}

export const streamRate = (mode: FtxMode): number => (AUDIO_RATE * streamOf(mode).L) / streamOf(mode).M;

export function layoutOf(mode: FtxMode): FtxLayout {
	const s = spec(mode);
	const l: FtxLayout = {
		nsps: 8192,
		ndown: 256,
		nt: s.tones,
		nsym: s.nn,
		bits: 1,
		rate: streamRate(mode),
		sp: s.spacing,
		sync: [],
		data: [],
		toneOff: 0,
		dtMax: 2.5,
		maxCand: 40,
		passes: 2,
	};
	if (mode === FT8) {
		Object.assign(l, { nsps: 1024, ndown: 32, bits: 3, maxCand: 150, passes: 3 });
		for (const g of [0, 36, 72]) for (let k = 0; k < 7; k++) l.sync.push([g + k, FT8_COSTAS[k]]);
		for (let k = 7; k < 36; k++) l.data.push(k);
		for (let k = 43; k < 72; k++) l.data.push(k);
	} else if (mode === FT4) {
		Object.assign(l, { nsps: 512, ndown: 32, bits: 2, toneOff: 1, maxCand: 100, passes: 2 });
		[0, 33, 66, 99].forEach((g, a) => {
			for (let k = 0; k < 4; k++) l.sync.push([g + k + 1, FT4_COSTAS[a][k]]);
		});
		for (const [from, to] of [
			[4, 33],
			[37, 66],
			[70, 99],
		])
			for (let k = from; k < to; k++) l.data.push(k + 1);
	} else
		for (let k = 0; k < 162; k++) {
			l.sync.push([k, WSPR_SYNC[k]]);
			l.data.push(k);
		}
	return l;
}

/** log of the modified Bessel function I0 (Abramowitz and Stegun 9.8.1 / 9.8.2). */
export function logI0(x: number): number {
	x = Math.abs(x);
	if (x < 3.75) {
		const t = (x / 3.75) * (x / 3.75);
		return Math.log(1 + t * (3.5156229 + t * (3.0899424 + t * (1.2067492 + t * (0.2659732 + t * (0.0360768 + t * 0.0045813))))));
	}
	const t = 3.75 / x;
	const p =
		0.39894228 +
		t *
			(0.01328592 +
				t *
					(0.00225319 + t * (-0.00157565 + t * (0.00916281 + t * (-0.02057706 + t * (0.02635537 + t * (-0.01647633 + t * 0.00392377)))))));
	return x - 0.5 * Math.log(x) + Math.log(p);
}

/** round() of C: halves away from zero. */
export const roundHalfAway = (x: number): number => Math.sign(x) * Math.round(Math.abs(x));
