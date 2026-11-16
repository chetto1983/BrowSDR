// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/marine/marine_dsp.cpp (ToneSlicer, VhfSlicer),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: complex values as separate re/im numbers.

const TWO_PI = 2 * Math.PI;

const wrap = (phase: number) => (phase > Math.PI ? phase - TWO_PI : phase < -Math.PI ? phase + TWO_PI : phase);

/**
 * Two tones, integrate and dump over one symbol, symbol clock from the energy difference. Input: complex samples at
 * `fs`; tone frequencies relative to 0 Hz; `sps` samples per symbol (an integer).
 */
export class ToneSlicer {
	private readonly w1: number;
	private readonly w2: number;
	private ph1 = 0;
	private ph2 = 0;
	private readonly r1: Float64Array;
	private readonly r2: Float64Array;
	private s1r = 0;
	private s1i = 0;
	private s2r = 0;
	private s2i = 0;
	private idx = 0;
	private n = 0;
	private readonly avg: Float64Array;
	private cntSym = 0;
	private period: number;
	private rateN = 0;
	private rateEmits = 0;
	/** Decisions per second, measured over ten seconds of input. */
	symbolRate = 0;

	constructor(
		private readonly fs: number,
		f1: number,
		f2: number,
		private readonly sps: number,
	) {
		this.w1 = (TWO_PI * f1) / fs;
		this.w2 = (TWO_PI * f2) / fs;
		this.r1 = new Float64Array(sps * 2);
		this.r2 = new Float64Array(sps * 2);
		this.avg = new Float64Array(sps);
		this.period = sps;
	}

	reset(): void {
		this.ph1 = this.ph2 = 0;
		this.r1.fill(0);
		this.r2.fill(0);
		this.s1r = this.s1i = this.s2r = this.s2i = 0;
		this.idx = 0;
		this.n = 0;
		this.avg.fill(0);
		this.cntSym = 0;
		this.period = this.sps;
		this.symbolRate = 0;
		this.rateN = this.rateEmits = 0;
	}

	/** One sample; returns a decision in [-1, 1] (positive: tone 1 stronger) when a symbol ends, else null. */
	push(xr: number, xi: number): number | null {
		const [c1, s1, c2, s2] = [Math.cos(this.ph1), -Math.sin(this.ph1), Math.cos(this.ph2), -Math.sin(this.ph2)];
		this.ph1 = wrap(this.ph1 + this.w1);
		this.ph2 = wrap(this.ph2 + this.w2);
		const [p1r, p1i] = [xr * c1 - xi * s1, xr * s1 + xi * c1];
		const [p2r, p2i] = [xr * c2 - xi * s2, xr * s2 + xi * c2];
		const k = this.idx * 2;
		this.s1r += p1r - this.r1[k];
		this.s1i += p1i - this.r1[k + 1];
		this.s2r += p2r - this.r2[k];
		this.s2i += p2i - this.r2[k + 1];
		this.r1[k] = p1r;
		this.r1[k + 1] = p1i;
		this.r2[k] = p2r;
		this.r2[k + 1] = p2i;
		if (++this.idx >= this.sps) this.idx = 0;
		this.n++;
		if ((this.n & 4095) === 0) this.resum();
		const e1 = this.s1r * this.s1r + this.s1i * this.s1i;
		const e2 = this.s2r * this.s2r + this.s2i * this.s2i;
		const d = (e1 - e2) / (e1 + e2 + 1e-20);
		const q = this.n % this.sps;
		this.avg[q] += 0.01 * (Math.abs(d) - this.avg[q]);
		if (++this.rateN >= 10 * this.fs) {
			this.symbolRate = this.rateEmits / (this.rateN / this.fs);
			this.rateN = this.rateEmits = 0;
		}
		if (++this.cntSym < this.period) return null;
		this.cntSym = 0;
		this.retime(q);
		this.rateEmits++;
		return d;
	}

	/** Exact sums again: the running sum drifts slowly. */
	private resum(): void {
		this.s1r = this.s1i = this.s2r = this.s2i = 0;
		for (let i = 0; i < this.sps; i++) {
			this.s1r += this.r1[2 * i];
			this.s1i += this.r1[2 * i + 1];
			this.s2r += this.r2[2 * i];
			this.s2i += this.r2[2 * i + 1];
		}
	}

	/**
	 * The symbol clock is a counter: a decision every `period` samples. The period is sps, plus or minus one sample
	 * towards the phase where the averaged |d| peaks (only when that peak is clear), so a wrong estimate can neither
	 * double nor drop a symbol.
	 */
	private retime(q: number): void {
		const sps = this.sps;
		let best = -1;
		let bestIndex = 0;
		for (let i = 0; i < sps; i++) {
			const v = this.avg[(i + sps - 1) % sps] + 2 * this.avg[i] + this.avg[(i + 1) % sps];
			if (v > best) {
				best = v;
				bestIndex = i;
			}
		}
		this.period = sps;
		if (best > 4 * 0.55) {
			let diff = bestIndex - q;
			if (diff > sps / 2) diff -= sps;
			else if (diff < -sps / 2) diff += sps;
			this.period = sps + Math.sign(diff);
		}
	}
}

/** 2 pole Butterworth low-pass at 4.5 kHz for a 24 kHz stream (bilinear transform). */
const [B0, B1, B2, A1, A2] = [0.186694, 0.373389, 0.186694, -0.462938, 0.209715];

/**
 * FM discriminator and 1300 / 2100 Hz AFSK at 1200 baud (VHF channel 70), for complex input at 24 kHz. A 4.5 kHz
 * channel filter (two biquads) sits before the discriminator, with a follow-up of the carrier offset (the mean of
 * the discriminator) in front of it. Positive decisions are the lower tone (Y = 1).
 */
export class VhfSlicer {
	static readonly RATE = 24000;
	private prevR = 0;
	private prevI = 0;
	private lp1 = 0;
	private lp2 = 0;
	private readonly zi = new Float64Array(4);
	private readonly zq = new Float64Array(4);
	private afcHz = 0;
	private afcPh = 0;
	private afcMean = 0;
	private readonly slicer = new ToneSlicer(VhfSlicer.RATE, 1300, 2100, 20);

	get symbolRate(): number {
		return this.slicer.symbolRate;
	}

	/** Carrier offset followed by the AFC, Hz. */
	get offsetHz(): number {
		return this.afcHz;
	}

	reset(): void {
		this.prevR = this.prevI = 0;
		this.lp1 = this.lp2 = 0;
		this.zi.fill(0);
		this.zq.fill(0);
		this.afcHz = this.afcPh = this.afcMean = 0;
		this.slicer.reset();
	}

	process(iq: Float32Array, onBit: (soft: number) => void): void {
		for (let i = 0; i + 1 < iq.length; i += 2) {
			const audio = this.disc(iq[i], iq[i + 1]);
			const soft = this.slicer.push(audio, 0);
			if (soft !== null) onBit(soft);
		}
	}

	private biquads(x: number, z: Float64Array): number {
		for (let k = 0; k < 2; k++) {
			const y = B0 * x + z[2 * k];
			z[2 * k] = B1 * x - A1 * y + z[2 * k + 1];
			z[2 * k + 1] = B2 * x - A2 * y;
			x = y;
		}
		return x;
	}

	private disc(inR: number, inI: number): number {
		this.afcPh = wrap(this.afcPh + (TWO_PI * this.afcHz) / VhfSlicer.RATE);
		const [c, s] = [Math.cos(this.afcPh), -Math.sin(this.afcPh)];
		const xr = this.biquads(inR * c - inI * s, this.zi);
		const xi = this.biquads(inR * s + inI * c, this.zq);
		const dr = xr * this.prevR + xi * this.prevI;
		const di = xi * this.prevR - xr * this.prevI;
		this.prevR = xr;
		this.prevI = xi;
		const hz = Math.atan2(di, dr) * (VhfSlicer.RATE / TWO_PI);
		// The mean of the discriminator is the carrier error (mark and space are equally often on the air): 50 ms
		// average, followed by a slow integrator.
		this.afcMean += (hz - this.afcMean) * (1 / 1200);
		this.afcHz = Math.max(-4000, Math.min(4000, this.afcHz + this.afcMean * (1 / 12000)));
		this.lp1 += 0.5 * (hz - this.lp1);
		this.lp2 += 0.5 * (this.lp1 - this.lp2);
		return this.lp2 * 0.0003; // about ±1 for a deviation of ±3 kHz
	}
}
