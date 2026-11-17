// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/aero/aero_demod.cpp (lowpass, Fir, aeroRrc, AeroDemod) and
// core/include/dect2/aero/aero_demod.h, https://github.com/adswill/OnAir; see third_party/onair. Changes: the 8400 bit/s
// C channel (voice) path is left out; the sample counters are rebased now and then so that they stay small.
//
// Inmarsat Aero P channel demodulation, one carrier near 0 Hz (after JAERO's mskdemodulator.cpp and oqpskdemodulator.cpp):
//   600 / 1200 bit/s: MSK seen as offset QPSK with half-sine pulses; the bits are the changes between successive arm
//                     decisions (JAERO: DiffDecode of imag as is, of real negated);
//   10500 bit/s:      offset QPSK, root raised cosine with roll-off 1; the Q arm leads, bits alternate Q, I.
// Carrier: the squared signal has two lines at 2 df +- Rb/2; they give the offset (and confirm the bit rate) before the
// carrier and timing loops start.

import { Fft } from '@/worker/decoders/dab/ofdm/fft';
import { AeroFramer, frameBits } from './framer';
import type { AeroFrameEvent } from './types';

const ACQ_MIN_BLOCKS = 4;
const ACQ_MAX_BLOCKS = 32;
const MF_RING = 32;

/** Windowed-sinc low-pass, cutoff as a fraction of the sample rate, Blackman window, unit DC gain. */
function lowpass(len: number, cutoff: number): Float32Array {
	const h = new Float64Array(len);
	const c = (len - 1) / 2;
	let sum = 0;
	for (let n = 0; n < len; n++) {
		const t = n - c;
		const s = t === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * t) / (Math.PI * t);
		const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / (len - 1)) + 0.08 * Math.cos((4 * Math.PI * n) / (len - 1));
		h[n] = s * w;
		sum += s * w;
	}
	return Float32Array.from(h, (v) => v / sum);
}

/** Root raised cosine pulse, symbol period 1. */
export function aeroRrc(t: number, a: number): number {
	if (Math.abs(t) < 1e-8) return 1 - a + (4 * a) / Math.PI;
	if (a > 0 && Math.abs(Math.abs(t) - 1 / (4 * a)) < 1e-8)
		return (a / Math.SQRT2) * ((1 + 2 / Math.PI) * Math.sin(Math.PI / (4 * a)) + (1 - 2 / Math.PI) * Math.cos(Math.PI / (4 * a)));
	return (Math.sin(Math.PI * t * (1 - a)) + 4 * a * t * Math.cos(Math.PI * t * (1 + a))) / (Math.PI * t * (1 - 16 * a * a * t * t));
}

/** FIR on complex samples with a doubled delay line (no wrap in the inner loop). */
class Fir {
	readonly len: number;
	private readonly re: Float32Array;
	private readonly im: Float32Array;
	private pos = 0;
	constructor(private readonly h: Float32Array) {
		this.len = h.length;
		this.re = new Float32Array(2 * h.length);
		this.im = new Float32Array(2 * h.length);
	}
	clear(): void {
		this.re.fill(0);
		this.im.fill(0);
		this.pos = 0;
	}
	push(re: number, im: number): void {
		this.re[this.pos] = this.re[this.pos + this.len] = re;
		this.im[this.pos] = this.im[this.pos + this.len] = im;
		this.pos = this.pos + 1 === this.len ? 0 : this.pos + 1;
	}
	/** The newest sample meets h[0]. */
	out(): [number, number] {
		const L = this.len,
			h = this.h;
		let re = 0,
			im = 0;
		for (let k = 0, p = this.pos; k < L; k++, p++) {
			re += h[L - 1 - k] * this.re[p];
			im += h[L - 1 - k] * this.im[p];
		}
		return [re, im];
	}
}

/** The matched filter: a half sine over two bits (MSK) or a root raised cosine over +-4 arm symbols (OQPSK). */
function matchedTaps(msk: boolean, fsD: number, rate: number): Float32Array {
	if (msk) {
		const sps = fsD / rate;
		const L = 2 * Math.floor(sps) + 1;
		return Float32Array.from({ length: L }, (_, n) => {
			const t = (n - (L - 1) / 2) / sps;
			return Math.abs(t) < 1 ? Math.cos((Math.PI * t) / 2) : 0;
		});
	}
	const sps = (2 * fsD) / rate;
	const L = 2 * Math.floor(4 * sps) + 1;
	return Float32Array.from({ length: L }, (_, n) => aeroRrc((n - (L - 1) / 2) / sps, 1));
}

/** The carrier search: power spectrum of the squared samples, averaged block by block. */
class Acquisition {
	readonly n: number;
	private readonly fft: Fft;
	private readonly re: Float64Array;
	private readonly im: Float64Array;
	readonly pow: Float64Array;
	fill = 0;
	done = 0;
	constructor(fsD: number, binWanted: number) {
		let n = 1;
		while (n < 1 << 16 && fsD / n > binWanted) n <<= 1;
		this.n = n;
		this.fft = new Fft(n);
		this.re = new Float64Array(n);
		this.im = new Float64Array(n);
		this.pow = new Float64Array(n);
	}
	clear(): void {
		this.fill = this.done = 0;
		this.pow.fill(0);
	}
	/** One sample; true when a block was added to the average. */
	push(re: number, im: number): boolean {
		this.re[this.fill] = re * re - im * im;
		this.im[this.fill] = 2 * re * im;
		if (++this.fill < this.n) return false;
		this.fft.forward(this.re, this.im);
		for (let i = 0; i < this.n; i++) this.pow[i] += this.re[i] * this.re[i] + this.im[i] * this.im[i];
		this.fill = 0;
		this.done++;
		return true;
	}
	/** Power at bin i (any integer, wrapped). */
	p(i: number): number {
		return this.pow[((i % this.n) + this.n) % this.n];
	}
	/** A line to a fraction of a bin, Hz. */
	refine(x: number, bin: number): number {
		let i0 = Math.floor(x);
		if (this.p(i0 + 1) > this.p(i0)) i0++;
		const a = this.p(i0 - 1),
			b = this.p(i0),
			c = this.p(i0 + 1);
		const d = a - 2 * b + c;
		const off = Math.abs(d) > 1e-30 ? (0.5 * (a - c)) / d : 0;
		return (i0 + Math.max(-0.5, Math.min(0.5, off))) * bin;
	}
}

export class AeroDemod {
	readonly rate: number;
	private readonly msk: boolean;
	private readonly fsIn: number;
	private readonly fsD: number;
	private readonly decim: number;
	private readonly dfir: Fir | null;
	private decPhase = 0;
	private readonly mf: Fir;
	private readonly step: number;
	/** Samples in flight between the mixer and the decision, in bits (for moving the loop frequency into the mixer). */
	private readonly pipeBits: number;
	// mixer
	private mixHz = 0;
	private mixPhase = 0;
	private mixMoved = false;
	// acquisition
	private readonly acqState: Acquisition;
	acquired = false;
	/** Looks after every averaged spectrum from the 4th on (OnAir 4.1's faster acquisition). */
	everyBlock = true;
	acqMetric = 0;
	private bitsSinceAcq = 0;
	// timing
	private readonly ringRe = new Float32Array(MF_RING);
	private readonly ringIm = new Float32Array(MF_RING);
	private mfIdx = -1;
	private tNext = 0;
	private tRate = 0;
	// carrier loop
	private theta = 0;
	private omega = 0;
	private pendOmega = 0;
	private pendBits = 0;
	// decisions
	private r1Re = 0;
	private r1Im = 0;
	private r2Re = 0;
	private r2Im = 0;
	private prevV = 0;
	private k = 0;
	private amp = 0;
	private mu = 0;
	private m2 = 0;
	framer: AeroFramer;

	/** fsIn: rate of the samples handed to process(); searchHz: how far from 0 Hz the carrier may be. */
	constructor(
		rate: number,
		fsIn: number,
		private readonly searchHz: number,
		private readonly onFrame: (event: AeroFrameEvent) => void,
	) {
		this.rate = rate;
		this.msk = rate !== 10500;
		this.fsIn = fsIn;
		this.decim = this.msk ? Math.max(1, Math.floor(fsIn / (8 * rate))) : 1;
		this.fsD = fsIn / this.decim;
		this.dfir = this.decim > 1 ? new Fir(lowpass(34 * this.decim + 1, 0.42 / this.decim)) : null;
		this.mf = new Fir(matchedTaps(this.msk, this.fsD, rate));
		this.step = this.fsD / rate;
		const dfirDelay = this.dfir ? (this.dfir.len - 1) / 2 : 0;
		this.pipeBits = Math.round((dfirDelay / fsIn + (this.mf.len - 1) / 2 / this.fsD) * rate);
		this.acqState = new Acquisition(this.fsD, this.msk ? 2.5 : 6);
		this.framer = this.newFramer();
	}

	private newFramer(): AeroFramer {
		return new AeroFramer(this.rate, (frame, uwErrors) =>
			this.onFrame({ ...frame, bitRate: this.rate, uwErrors, ebn0Db: this.ebn0Db, freqHz: this.freqHz }),
		);
	}

	/** Current carrier estimate relative to the input centre. */
	get freqHz(): number {
		return this.mixHz + (this.omega * this.rate) / (2 * Math.PI);
	}

	/** Per channel bit, from the decisions; 0 before the loops run. */
	get ebn0Db(): number {
		const v = this.m2 - this.mu * this.mu;
		if (!this.acquired || this.mu <= 0 || v <= 1e-20) return 0;
		return 10 * Math.log10((this.mu * this.mu) / (2 * v));
	}

	get synced(): boolean {
		return this.acquired && this.framer.synced;
	}

	get dataLock(): boolean {
		return this.acquired && this.framer.dataLock;
	}

	reset(): void {
		this.mixHz = this.mixPhase = 0;
		this.dfir?.clear();
		this.mf.clear();
		this.decPhase = 0;
		this.startAcq();
		this.acqMetric = 0;
		this.framer = this.newFramer();
		this.resetLoops();
	}

	/** Search the carrier again around the centre the channel was given. */
	private startAcq(): void {
		this.acquired = false;
		this.mixHz = 0;
		this.mixMoved = true;
		this.acqState.clear();
	}

	private resetLoops(): void {
		this.mfIdx = -1;
		this.tNext = this.tRate = 0;
		this.theta = this.omega = this.pendOmega = this.pendBits = 0;
		this.r1Re = this.r1Im = this.r2Re = this.r2Im = this.prevV = this.k = 0;
		this.amp = this.mu = this.m2 = 0;
		this.bitsSinceAcq = 0;
		this.ringRe.fill(0);
		this.ringIm.fill(0);
	}

	/** The squared signal: lines at 2 df +- Rb/2. */
	private acqEvaluate(): void {
		const a = this.acqState;
		const N = a.n;
		const bin = this.fsD / N;
		const sorted = Float64Array.from(a.pow).sort();
		const med = Math.max(sorted[N >> 1], 1e-30);
		const L = this.rate / 2 / bin;
		const cmax = Math.min(Math.trunc((2 * this.searchHz) / bin), Math.trunc(N / 2 - L - 2));
		const line = (x: number) => Math.max(a.p(Math.floor(x)), a.p(Math.ceil(x)));
		let best = 0,
			bc = 0;
		for (let c = -cmax; c <= cmax; c++) {
			const m = line(c + L) + line(c - L);
			if (m > best) {
				best = m;
				bc = c;
			}
		}
		this.acqMetric = best / (2 * med);
		// the noise ratio spreads less the more blocks are averaged, so the threshold falls with them (4 blocks: 12, 32 blocks: 5.5)
		const thr = 2.2 + 9.8 * Math.sqrt(ACQ_MIN_BLOCKS / Math.max(1, a.done));
		if (this.acqMetric < thr) {
			if (a.done >= ACQ_MAX_BLOCKS) this.startAcq();
			return;
		}
		const df = (a.refine(bc + L, bin) + a.refine(bc - L, bin)) / 4; // the lines sit at 2 df
		this.mixHz += df;
		this.mixMoved = true;
		this.dfir?.clear();
		this.mf.clear();
		this.decPhase = 0;
		this.resetLoops();
		this.acquired = true;
	}

	process(iq: Float32Array): void {
		let inc = (-2 * Math.PI * this.mixHz) / this.fsIn;
		const n = iq.length >> 1;
		for (let i = 0; i < n; i++) {
			const c = Math.cos(this.mixPhase),
				s = Math.sin(this.mixPhase);
			this.mixPhase += inc;
			if (this.mixPhase > Math.PI) this.mixPhase -= 2 * Math.PI;
			else if (this.mixPhase < -Math.PI) this.mixPhase += 2 * Math.PI;
			const xr = iq[2 * i],
				xi = iq[2 * i + 1];
			const yr = xr * c - xi * s,
				yi = xr * s + xi * c;
			if (this.dfir) {
				this.dfir.push(yr, yi);
				if (++this.decPhase < this.decim) continue;
				this.decPhase = 0;
				const [dr, di] = this.dfir.out();
				this.sampleD(dr, di);
			} else this.sampleD(yr, yi);
			if (this.mixMoved) {
				this.mixMoved = false;
				inc = (-2 * Math.PI * this.mixHz) / this.fsIn;
			}
		}
	}

	private sampleD(re: number, im: number): void {
		if (!this.acquired) {
			const a = this.acqState;
			if (a.push(re, im) && a.done >= ACQ_MIN_BLOCKS && (this.everyBlock || (a.done & (a.done - 1)) === 0)) this.acqEvaluate();
			return;
		}
		this.mf.push(re, im);
		const [mr, mi] = this.mf.out();
		this.mfIdx++;
		this.ringRe[this.mfIdx & (MF_RING - 1)] = mr;
		this.ringIm[this.mfIdx & (MF_RING - 1)] = mi;
		if (this.mfIdx < this.mf.len) {
			this.tNext = this.mfIdx + 1; // filter still filling
			return;
		}
		while (this.tNext + 2 <= this.mfIdx) {
			const [yr, yi] = this.interp(this.tNext);
			this.tNext += this.bit(yr, yi);
			if (this.tNext < this.mfIdx - (MF_RING - 8)) this.tNext = this.mfIdx - (MF_RING - 8);
		}
		if (this.mfIdx >= 1 << 24) {
			this.mfIdx -= 1 << 23;
			this.tNext -= 1 << 23;
		}
	}

	/** Cubic interpolation of the matched filter output at `t`. */
	private interp(t: number): [number, number] {
		const i0 = Math.floor(t);
		const u = t - i0;
		const R = this.ringRe,
			I = this.ringIm;
		const a = (i0 - 1) & (MF_RING - 1),
			b = i0 & (MF_RING - 1),
			c = (i0 + 1) & (MF_RING - 1),
			d = (i0 + 2) & (MF_RING - 1);
		const cubic = (p0: number, p1: number, p2: number, p3: number) => {
			const c1 = -p0 / 3 - p1 / 2 + p2 - p3 / 6;
			const c2 = p0 / 2 - p1 + p2 / 2;
			const c3 = -p0 / 6 + p1 / 2 - p2 / 2 + p3 / 6;
			return ((c3 * u + c2) * u + c1) * u + p1;
		};
		return [cubic(R[a], R[b], R[c], R[d]), cubic(I[a], I[b], I[c], I[d])];
	}

	/** One bit sample: loops, soft decision; returns the advance to the next bit in samples. */
	private bit(yr: number, yi: number): number {
		const c = Math.cos(this.theta),
			s = Math.sin(this.theta);
		const rr = yr * c + yi * s,
			ri = yi * c - yr * s;
		const q = this.k % 2 === 0; // even bits on the Q arm, odd on I
		const v = q ? ri : rr;
		const av = Math.abs(v);
		if (this.k === 0) this.amp = av > 0 ? av : 1e-6;
		this.amp += 0.01 * (av - this.amp);
		const ampF = Math.max(this.amp, 1e-12);
		this.loops(rr, ri, q, ampF);
		const adv = this.timing(v, q, ampF);
		this.r2Re = this.r1Re;
		this.r2Im = this.r1Im;
		this.r1Re = rr;
		this.r1Im = ri;
		const qa = Math.max(0.002, 1 / (this.k + 1));
		this.mu += qa * (av - this.mu);
		this.m2 += qa * (av * av - this.m2);
		let soft = v;
		if (this.msk) {
			// physical MSK: the phase step is +-90 degrees, so the arm products carry (-1)^k: even bits are "signs differ",
			// odd bits "signs equal" (JAERO: DiffDecode of imag as is, of real negated)
			soft = this.k === 0 ? 0 : (this.prevV * v < 0 === q ? 1 : -1) * Math.min(av, Math.abs(this.prevV));
			this.prevV = v;
		}
		this.k++;
		this.bitsSinceAcq++;
		this.framer.push(soft / ampF);
		this.moveToMixer();
		// no frame after a few frame lengths: search the carrier again
		if (!this.framer.synced && this.bitsSinceAcq > 4 * frameBits(this.rate)) this.startAcq();
		return adv;
	}

	/** Carrier loop: the other component at this arm's peak, signed by this arm's decision. */
	private loops(rr: number, ri: number, q: boolean, ampF: number): void {
		let eps = q ? -rr * (ri >= 0 ? 1 : -1) : ri * (rr >= 0 ? 1 : -1);
		eps = Math.max(-1, Math.min(1, eps / ampF));
		const bn = this.bitsSinceAcq < 400 ? 0.03 : 0.012;
		const zeta = 0.707,
			th = bn / (zeta + 0.25 / zeta);
		const den = 1 + 2 * zeta * th + th * th;
		this.theta += this.omega + ((4 * zeta * th) / den) * eps;
		this.omega += ((4 * th * th) / den) * eps;
		if (this.theta > Math.PI) this.theta -= 2 * Math.PI;
		else if (this.theta < -Math.PI) this.theta += 2 * Math.PI;
	}

	/** Timing: Gardner on this arm (the previous sample is the arm's midpoint); the advance to the next bit. */
	private timing(a0: number, q: boolean, ampF: number): number {
		if (this.k < 2) return this.step;
		const m = q ? this.r1Im : this.r1Re;
		const pv = q ? this.r2Im : this.r2Re;
		const e = Math.max(-1, Math.min(1, (m * (pv - a0)) / (ampF * ampF)));
		const g1 = this.bitsSinceAcq < 400 ? 0.04 : 0.015,
			g2 = (g1 * g1) / 8;
		this.tRate = Math.max(-0.002, Math.min(0.002, this.tRate + g2 * e));
		return this.step * (1 + this.tRate) + (g1 * e * this.step) / 4;
	}

	/** Moves a large loop frequency into the mixer; the loop gives it up when the moved samples arrive. */
	private moveToMixer(): void {
		if (this.pendBits > 0) {
			if (--this.pendBits === 0) {
				this.omega -= this.pendOmega;
				this.pendOmega = 0;
			}
		} else if (Math.abs(this.omega) > 2 * Math.PI * 0.004) {
			this.pendOmega = this.omega;
			this.pendBits = Math.max(1, this.pipeBits);
			this.mixHz += (this.omega * this.rate) / (2 * Math.PI);
			this.mixMoved = true;
		}
	}
}
