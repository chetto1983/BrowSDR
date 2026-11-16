// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/hfdig/hfdig_sstv.cpp (front end, phase access) and
// core/src/hfdig/hfdig_usb.h (lowpass), https://github.com/adswill/OnAir; see third_party/onair.
//
// The 8 kHz audio is mixed down by 1900 Hz, low-passed and turned into an unwrapped phase, one value per sample, kept
// in a ring. Any mean frequency over any stretch of time (fractional sample positions) is then one subtraction: the
// phase difference over the stretch. That is what a pixel is, what a sync pulse search is and what a VIS bit is.

export const SSTV_AUDIO_RATE = 8000;
/** Samples per millisecond. */
export const MS = SSTV_AUDIO_RATE / 1000;
export const CENTER_HZ = 1900;
const TAPS = 63;
/** Passes 950 .. 2850 Hz, so a VIS bit (1100 Hz) with a dial error of -100 Hz still gets through. */
const LOWPASS_HZ = 950;
/** Samples of phase kept (16 s). */
const RING = 1 << 17;
/** The mean frequency used by the VIS and pulse search: 4 ms. */
export const BOX = 32;

function besselI0(x: number): number {
	let sum = 1;
	let term = 1;
	for (let k = 1; k < 40; k++) {
		term *= (x / (2 * k)) ** 2;
		sum += term;
		if (term < 1e-12 * sum) break;
	}
	return sum;
}

/** Kaiser-windowed sinc low-pass, unity gain at DC; cutoff in cycles per sample. */
export function kaiserLowpass(n: number, fc: number, beta: number): Float64Array {
	const h = new Float64Array(n);
	const c = (n - 1) / 2;
	let sum = 0;
	for (let k = 0; k < n; k++) {
		const t = k - c;
		const sinc = t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t);
		const r = c > 0 ? t / c : 0;
		h[k] = (sinc * besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r)))) / besselI0(beta);
		sum += h[k];
	}
	return h.map((v) => v / sum);
}

const TAPS_LP = kaiserLowpass(TAPS, LOWPASS_HZ / SSTV_AUDIO_RATE, 6);
const OSC = Array.from({ length: 80 }, (_, i) => {
	const a = (-2 * Math.PI * CENTER_HZ * i) / SSTV_AUDIO_RATE;
	return [Math.cos(a), Math.sin(a)] as const;
});

export class PhaseFront {
	private readonly hr = new Float64Array(2 * TAPS);
	private readonly hi = new Float64Array(2 * TAPS);
	private hpos = 0;
	private zr = 0;
	private zi = 0;
	private phase = 0;
	private readonly ph = new Float64Array(RING);
	/** Samples fed; phase of sample i is valid for i < n. */
	n = 0;

	reset(): void {
		this.hr.fill(0);
		this.hi.fill(0);
		this.hpos = 0;
		this.zr = this.zi = 0;
		this.phase = 0;
		this.ph.fill(0);
		this.n = 0;
	}

	push(x: number): void {
		const [c, s] = OSC[this.n % 80];
		const hpos = this.hpos;
		this.hr[hpos] = this.hr[hpos + TAPS] = x * c;
		this.hi[hpos] = this.hi[hpos + TAPS] = x * s;
		this.hpos = hpos + 1 >= TAPS ? 0 : hpos + 1;
		let sr = 0;
		let si = 0;
		for (let k = 0; k < TAPS; k++) {
			sr += TAPS_LP[k] * this.hr[this.hpos + k];
			si += TAPS_LP[k] * this.hi[this.hpos + k];
		}
		if (this.n > 0) this.phase += Math.atan2(si * this.zr - sr * this.zi, sr * this.zr + si * this.zi);
		this.zr = sr;
		this.zi = si;
		this.ph[this.n & (RING - 1)] = this.phase;
		this.n++;
	}

	phaseAt(t: number): number {
		const fl = Math.floor(t);
		const a = this.ph[fl & (RING - 1)];
		const b = this.ph[(fl + 1) & (RING - 1)];
		return a + (b - a) * (t - fl);
	}

	/** Mean tone (Hz) over [t0, t1] in samples. */
	meanF(t0: number, t1: number): number {
		return CENTER_HZ + ((this.phaseAt(t1) - this.phaseAt(t0)) * SSTV_AUDIO_RATE) / (2 * Math.PI * (t1 - t0));
	}

	/** Mean tone over the 4 ms ending at sample i. */
	boxF(i: number): number {
		return CENTER_HZ + ((this.ph[i & (RING - 1)] - this.ph[(i - BOX) & (RING - 1)]) * SSTV_AUDIO_RATE) / (2 * Math.PI * BOX);
	}
}
