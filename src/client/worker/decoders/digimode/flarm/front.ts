// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/flarm/flarm_rx.cpp (FlarmReceiver::Impl::configure and
// processChan: the mixer to each channel and the channel low-pass, lowpassTaps(85 kHz, 140 kHz, 50 dB)),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: the two channels come from one 400 kS/s stream
// (4 samples per chip; OnAir mixes and filters each channel at 800 kS/s, 8 per chip): at this rate the ±100 kHz mixers
// are quarter turns, so "mix, then filter" is done as one pass of the filter turned by a quarter turn per tap, whose
// cosine and sine halves are each zero at every second tap and (anti)symmetric, and both channels share them.

import { lowpassTaps } from '@/worker/decoders/digimode/tones/dsp';

/** Samples per chip. */
export const SPS = 4;
/** Complex rate of the VFO channel: 868.2 and 868.4 MHz are 100 kHz either side of it. */
export const FLARM_RATE = 100000 * SPS;
const TAPS = lowpassTaps(85000, 140000, FLARM_RATE, 50, 9);
const T = TAPS.length;
const MID = T >> 1;

/** The taps on the history window (index j = sample n - (T - 1 - j)), turned by a quarter turn per tap: cos and sin. */
const COS_W = Float64Array.from({ length: T }, (_, j) => TAPS[T - 1 - j] * Math.cos((Math.PI * (T - 1 - j)) / 2));
const SIN_W = Float64Array.from({ length: T }, (_, j) => TAPS[T - 1 - j] * Math.sin((Math.PI * (T - 1 - j)) / 2));
// With an odd centre (T = 4m + 3) the cosine half lives on the even taps and is antisymmetric, the sine half on the odd
// taps and symmetric: each output is 2 x (MID + 1) multiplications for both channels.
if (MID % 2 !== 1) throw new Error('FLARM channel filter: the centre tap must be odd');

/** The two channels, mixed to 0 Hz and low-passed: 868.2 MHz (turned up by 100 kHz) and 868.4 MHz (turned down). */
export class FlarmFront {
	private readonly hr = new Float64Array(2 * T);
	private readonly hi = new Float64Array(2 * T);
	private head = 0;
	private n = 0;
	re0 = new Float64Array(0);
	im0 = new Float64Array(0);
	re1 = new Float64Array(0);
	im1 = new Float64Array(0);

	reset(): void {
		this.hr.fill(0);
		this.hi.fill(0);
		this.head = 0;
	}

	/** Interleaved I/Q at 400 kS/s centred between the channels; returns the samples of each channel. */
	process(iq: Float32Array): number {
		const count = iq.length >> 1;
		if (this.re0.length < count) [this.re0, this.im0, this.re1, this.im1] = [0, 1, 2, 3].map(() => new Float64Array(count));
		const { hr, hi, re0, im0, re1, im1 } = this;
		let head = this.head;
		for (let i = 0; i < count; i++) {
			hr[head] = hr[head + T] = iq[2 * i];
			hi[head] = hi[head + T] = iq[2 * i + 1];
			head = head + 1 === T ? 0 : head + 1;
			// sum over k of h[k] e^{∓jπk/2} x[n-k]: the cosine (c) and sine (s) halves of the real and imaginary parts
			let cr = 0;
			let ci = 0;
			let sr = SIN_W[MID] * hr[head + MID];
			let si = SIN_W[MID] * hi[head + MID];
			for (let j = 0, e = head + T - 1; j < MID; j += 2, e -= 2) {
				cr += COS_W[j] * (hr[head + j] - hr[e]);
				ci += COS_W[j] * (hi[head + j] - hi[e]);
			}
			for (let j = 1, e = head + T - 2; j < MID; j += 2, e -= 2) {
				sr += SIN_W[j] * (hr[head + j] + hr[e]);
				si += SIN_W[j] * (hi[head + j] + hi[e]);
			}
			// channel 0: (cr + si) + j(ci - sr), turned by e^{+jπn/2}; channel 1: (cr - si) + j(ci + sr), by e^{-jπn/2}
			quarter(cr + si, ci - sr, this.n + i, re0, im0, i);
			quarter(cr - si, ci + sr, -(this.n + i), re1, im1, i);
		}
		this.head = head;
		this.n += count;
		return count;
	}
}

/** a + jb turned by q quarter turns, stored at index i. */
function quarter(a: number, b: number, q: number, re: Float64Array, im: Float64Array, i: number): void {
	switch (q & 3) {
		case 0:
			re[i] = a;
			im[i] = b;
			break;
		case 1:
			re[i] = -b;
			im[i] = a;
			break;
		case 2:
			re[i] = -a;
			im[i] = -b;
			break;
		default:
			re[i] = b;
			im[i] = -a;
	}
}
