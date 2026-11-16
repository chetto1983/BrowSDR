// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/marine/marine_dsp.cpp (FaxAudio),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: complex values as separate re/im numbers, sums in
// double precision; the output goes to a caller's buffer.

import { marineLowpass } from '@/worker/decoders/digimode/dsc/slicers';

export const FAX_INPUT_RATE = 24000;
export const FAX_AUDIO_RATE = 12000;
const TAPS = 301;

/**
 * USB audio for the weather fax: 24 kHz complex (centred on the dial) -> real audio at 12 kHz, band 50 .. 3950 Hz of the
 * upper sideband, with a slow AGC.
 */
export class FaxAudio {
	private readonly tapR = new Float64Array(TAPS);
	private readonly tapI = new Float64Array(TAPS);
	private readonly ringR = new Float64Array(TAPS);
	private readonly ringI = new Float64Array(TAPS);
	private pos = 0;
	private phase = 0;
	private env = 0;

	constructor() {
		const lp = marineLowpass(TAPS, 1950 / FAX_INPUT_RATE, 6);
		const w0 = (2 * Math.PI * 2000) / FAX_INPUT_RATE; // band 50 .. 3950 Hz: the 300 Hz start and 450 Hz stop tones pass
		for (let i = 0; i < TAPS; i++) {
			const t = i - Math.floor(TAPS / 2);
			// The ring is read oldest first, which reverses the filter in time: the modulation is conjugated to keep the band
			// at +2000 Hz.
			this.tapR[i] = lp[i] * Math.cos(w0 * t);
			this.tapI[i] = -lp[i] * Math.sin(w0 * t);
		}
	}

	reset(): void {
		this.ringR.fill(0);
		this.ringI.fill(0);
		this.pos = this.phase = 0;
		this.env = 0;
	}

	/** Interleaved complex input; writes the audio to `out` (at least half as long as the input in samples) and returns its length. */
	process(iq: Float32Array, out: Float32Array): number {
		let count = 0;
		for (let n = 0; n + 1 < iq.length; n += 2) {
			this.ringR[this.pos] = iq[n];
			this.ringI[this.pos] = iq[n + 1];
			if (++this.pos >= TAPS) this.pos = 0;
			if (++this.phase < 2) continue;
			this.phase = 0;
			let ar = 0;
			let ai = 0;
			let idx = this.pos;
			for (let k = 0; k < TAPS; k++) {
				const vr = this.ringR[idx];
				const vi = this.ringI[idx];
				const tr = this.tapR[k];
				const ti = this.tapI[k];
				ar += tr * vr - ti * vi;
				ai += tr * vi + ti * vr;
				if (++idx >= TAPS) idx = 0;
			}
			const mag = Math.sqrt(ar * ar + ai * ai);
			this.env += (mag > this.env ? 0.01 : 0.00005) * (mag - this.env); // fast attack, slow release
			out[count++] = ar * (0.5 / (this.env + 1e-9));
		}
		return count;
	}
}
