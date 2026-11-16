// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/packet/packet_demod.cpp (FmFront: the discriminator in Hz of
// deviation) and core/src/tones/tones_rx.cpp (the audio filter down to 8 kHz), https://github.com/adswill/OnAir;
// see third_party/onair. Changes: the channel comes from BrowSDR's DDC at 16 kHz, so one decimating filter by two makes
// the 8 kHz audio (OnAir: 96 -> 48 -> 8 kHz); its stop band starts at 4 kHz (OnAir's second stage, lowpassTaps(3200,
// 800, 48000), puts the cut at 2 kHz and takes out the 2.1 - 2.6 kHz sequential tones); the carrier offset is taken out
// as the slow mean of the discriminator (OnAir mixes out only offsets above 1.5 kHz and lets the decoders bear the
// rest).

import { lowpassTaps } from './dsp';

/** Complex channel rate of the tone decoders. */
export const TONES_RATE = 16000;
/** Audio rate of the decoders. */
export const AUDIO_RATE = 8000;
const DECIMATION = TONES_RATE / AUDIO_RATE;
const TAPS = lowpassTaps(3200, 4000, TONES_RATE, 50, 9);
const HZ_PER_RADIAN = TONES_RATE / (2 * Math.PI);
/** About 0.25 s: well below the lowest CTCSS tone, fast enough to follow a carrier that starts off tune. */
const OFFSET_ALPHA = 1 / 4000;

/** FM discriminator: complex channel at 16 kHz in, audio at 8 kHz out, in Hz of deviation. */
export class FmFront {
	private prevR = 1;
	private prevI = 0;
	/** Carrier offset, Hz (the mean of the discriminator). */
	offsetHz = 0;
	/** Filter history, doubled so the newest taps are contiguous. */
	private readonly history = new Float64Array(TAPS.length * 2);
	private head = 0;
	private phase = 0;
	private out = new Float32Array(0);

	reset(): void {
		this.prevR = 1;
		this.prevI = 0;
		this.offsetHz = 0;
		this.history.fill(0);
		this.head = this.phase = 0;
	}

	/** The audio of these samples; valid until the next call. */
	process(iq: Float32Array): Float32Array {
		const count = iq.length >> 1;
		const need = Math.ceil(count / DECIMATION) + 1;
		if (this.out.length < need) this.out = new Float32Array(need);
		const taps = TAPS.length;
		let produced = 0;
		for (let n = 0; n < count; n++) {
			const [xr, xi] = [iq[2 * n], iq[2 * n + 1]];
			const zr = xr * this.prevR + xi * this.prevI;
			const zi = xi * this.prevR - xr * this.prevI;
			this.prevR = xr;
			this.prevI = xi;
			const hz = zr === 0 && zi === 0 ? 0 : Math.atan2(zi, zr) * HZ_PER_RADIAN;
			this.offsetHz += (hz - this.offsetHz) * OFFSET_ALPHA;
			this.history[this.head] = this.history[this.head + taps] = hz - this.offsetHz;
			this.head = (this.head + 1) % taps;
			if (++this.phase < DECIMATION) continue;
			this.phase = 0;
			let y = 0;
			for (let k = 0; k < taps; k++) y += TAPS[k] * this.history[this.head + k];
			this.out[produced++] = y;
		}
		return this.out.subarray(0, produced);
	}
}
