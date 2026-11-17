// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/psk/psk_rx.cpp (Chan and PskReceiver::Impl::chanSample,
// sample1k, symbol, putChar: the mixer, the triangular decimator to 1 kHz, the matched filter, the symbol clock from
// the envelope with Gardner tracking, the ISI correction, differential and phase-reference BPSK decisions, QPSK with
// the Viterbi decoder, AFC, DCD and squelch, the SNR shown), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: one class per signal; characters go to a callback (the lines and callsigns are kept by the caller); the
// 8PSK branch and the PSK_NO* measuring switches are left out; the user's focus (manual signals) is not ported.

import type { PskMode, PskSignalInfo } from './types';
import { qpskSymbol, VaricodeRx, Viterbi } from './varicode';

/** 24 kHz complex, the dial at 0 Hz. */
export const PSK_BASE = 24000;
/** 24 kHz -> 1 kHz with a triangular (CIC of order 2) filter. */
export const DECIM = 24;
const TRI = 2 * DECIM - 1;
const TRI_W = Float64Array.from({ length: TRI }, (_, j) => (DECIM - Math.abs(j - (DECIM - 1))) / (DECIM * DECIM));
/** BPSK: weight of the newest decision in the carrier phase reference. */
const REF_A = 0.25;
/** Squelch: the symbol power falls under this share of what it was while decoding. */
const SQL_A = 0.4;
const SQL_T = 0.2;

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** The matched filter of a modulation: the raised-cosine pulse of PSK31, two symbols long, at 1 kHz. */
export function matchedFilter(mode: PskMode): { sps: number; h: Float64Array } {
	const sps = Math.round(PSK_BASE / DECIM / mode.baud);
	const n = 2 * sps;
	const h = Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / n));
	const s = h.reduce((a, v) => a + v, 0);
	return { sps, h: h.map((v) => v / s) };
}

/** One PSK signal: its own mixer, matched filter, symbol clock, AFC and decoder. */
export class PskChannel {
	/** Offset from the dial now, and where it was found. */
	f = 0;
	f0 = 0;
	private rotR = 1;
	private rotI = 0;
	private stepR = 1;
	private stepI = 0;
	private rotCount = 0;
	private readonly tri = new Float64Array(4 * TRI);
	private triPos = 0;
	private phase = 0;
	private readonly mf: Float64Array;
	private mfPos = 0;
	// symbol clock
	private readonly bins: Float64Array;
	private ph = 0;
	private idx = 0;
	private since = 0;
	private syms = 0;
	private readonly yh: Float64Array;
	private yhPos = 0;
	private lastR = 0;
	private lastI = 0;
	private s1R = 0;
	private s1I = 0;
	private s2R = 0;
	private s2I = 0;
	private l2R = 0;
	private l2I = 0;
	private pw = 0;
	private gacc = 0;
	private prevR = 0;
	private prevI = 0;
	private havePrev = false;
	private refR = 0;
	private refI = 0;
	private prevSign = 1;
	q = 0.2;
	private errVar = 1;
	private errShown = 1;
	private readonly errHist = new Float64Array(32);
	private errPos = 0;
	dcd = false;
	private fastPw = 0;
	private dcdPw = 0;
	private readonly vit = new Viterbi();
	private readonly vrx = new VaricodeRx();
	lastActive = 0;
	lastPeak = 0;
	chars = 0;
	bad = 0;

	constructor(
		hz: number,
		private readonly mode: PskMode,
		private readonly sps: number,
		private readonly h: Float64Array,
		/** Signal seconds now. */
		private readonly now: () => number,
		/** A character (code 0 .. 127, -2 a code not in the table). */
		private readonly onChar: (ch: number) => void,
		/** The DCD dropped: the line ends. */
		private readonly onDcdLost: () => void,
	) {
		this.setFreq(hz);
		this.f0 = hz;
		this.mf = new Float64Array(8 * sps);
		this.bins = new Float64Array(sps);
		this.yh = new Float64Array(2 * sps);
		this.lastActive = this.lastPeak = now();
	}

	setFreq(hz: number): void {
		this.f = hz;
		const w = (-2 * Math.PI * hz) / PSK_BASE;
		this.stepR = Math.cos(w);
		this.stepI = Math.sin(w);
	}

	info(): PskSignalInfo {
		const snrDb = Math.max(-5, Math.min(40, 10 * Math.log10(1 / Math.max(1e-4, this.errShown))));
		return { hz: this.f, afcHz: this.f - this.f0, snrDb, quality: Math.max(0, this.q), dcd: this.dcd };
	}

	/** One 24 kHz sample: mixed to 0 Hz, the triangular decimator. */
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
		const tri = this.tri;
		const p = 2 * this.triPos;
		tri[p] = tri[p + 2 * TRI] = mr;
		tri[p + 1] = tri[p + 2 * TRI + 1] = mi;
		if (++this.triPos >= TRI) this.triPos = 0;
		if (++this.phase < DECIM) return;
		this.phase = 0;
		let dr = 0;
		let di = 0;
		for (let j = 0, k = 2 * this.triPos; j < TRI; j++, k += 2) {
			dr += tri[k] * TRI_W[j];
			di += tri[k + 1] * TRI_W[j];
		}
		this.sample1k(dr, di);
	}

	/** One 1 kHz sample: matched filter, symbol clock. */
	private sample1k(dr: number, di: number): void {
		const { h, mf, sps } = this;
		const L = h.length;
		const p = 2 * this.mfPos;
		mf[p] = mf[p + 2 * L] = dr;
		mf[p + 1] = mf[p + 2 * L + 1] = di;
		if (++this.mfPos >= L) this.mfPos = 0;
		let yr = 0;
		let yi = 0;
		for (let j = 0, k = 2 * this.mfPos; j < L; j++, k += 2) {
			yr += mf[k] * h[j];
			yi += mf[k + 1] * h[j];
		}
		const e = Math.hypot(yr, yi);
		this.bins[this.ph] += (this.syms < sps ? 0.3 : 0.08) * (e - this.bins[this.ph]);
		this.yh[2 * this.yhPos] = yr;
		this.yh[2 * this.yhPos + 1] = yi;
		this.yhPos = (this.yhPos + 1) % sps;
		this.since++;
		if (this.ph === this.idx && this.since > sps >> 1) this.onSymbol(yr, yi);
		if (++this.ph >= sps) this.ph = 0;
	}

	/** The sampling instant: Gardner timing error, the ISI correction, the symbol, the clock moved. */
	private onSymbol(yr: number, yi: number): void {
		const sps = this.sps;
		this.since = 0;
		const m = (this.yhPos - 1 - (sps >> 1) + 2 * sps) % sps;
		const [midR, midI] = [this.yh[2 * m], this.yh[2 * m + 1]];
		this.pw += 0.05 * (yr * yr + yi * yi - this.pw);
		// Gardner: (previous - this) x the sample between them; > 0 when the samples come too early
		const ge = ((this.lastR - yr) * midR + (this.lastI - yi) * midI) / Math.max(1e-30, this.pw);
		this.lastR = yr;
		this.lastI = yi;
		// the matched filter leaves 1/6 of each neighbour in a symbol (the pulse is two symbols long): it turns QPSK
		// phases, so take it out (one symbol late)
		[this.s2R, this.s2I, this.s1R, this.s1I] = [this.s1R, this.s1I, yr, yi];
		const k = 1 + 2 / 36;
		this.symbol(this.s2R * k - (this.l2R + yr) / 6, this.s2I * k - (this.l2I + yi) / 6);
		[this.l2R, this.l2I] = [this.s2R, this.s2I];
		let best = 0;
		for (let j = 1; j < sps; j++) if (this.bins[j] > this.bins[best]) best = j;
		if (!this.dcd && this.syms < 3 * sps) {
			// acquiring: straight to the peak of the envelope
			this.idx = best;
			this.gacc = 0;
		} else {
			this.gacc += ge;
			if (this.gacc > 2) {
				this.idx = (this.idx + 1) % sps;
				this.gacc = 0;
			} else if (this.gacc < -2) {
				this.idx = (this.idx + sps - 1) % sps;
				this.gacc = 0;
			}
		}
		this.syms++;
	}

	/** One symbol: phase change, quality, DCD, AFC, then the bits. */
	private symbol(yr: number, yi: number): void {
		if (!this.havePrev) {
			[this.prevR, this.prevI, this.havePrev] = [yr, yi, true];
			return;
		}
		const dr = yr * this.prevR + yi * this.prevI;
		const di = yi * this.prevR - yr * this.prevI;
		[this.prevR, this.prevI] = [yr, yi];
		if (Math.hypot(dr, di) < 1e-20) return;
		const a = Math.atan2(di, dr);
		const order = this.mode.qpsk ? 4 : 2;
		const err = wrap(order * a) / order;
		this.track(err, yr * yr + yi * yi);
		// AFC: the remaining phase step per symbol is the frequency error
		const baud = this.mode.baud;
		const gain = (this.dcd ? 0.04 : 0.1) * Math.min(1, 62.5 / baud);
		if (this.q > 0.2) {
			let nf = this.f + (gain * err * baud) / (2 * Math.PI);
			if (Math.abs(nf - this.f0) > 2 * baud) nf = this.f0; // pulled away: start over where it was found
			this.setFreq(nf);
		}
		if (this.mode.qpsk) this.qpskBits(a);
		else this.bpskBit(yr, yi);
	}

	/** Quality, the SNR shown, the DCD and the squelch. */
	private track(err: number, yp: number): void {
		const order = this.mode.qpsk ? 4 : 2;
		const en = err / (Math.PI / order);
		this.q += 0.1 * (1 - 3 * en * en - this.q);
		this.errVar += 0.05 * (err * err - this.errVar);
		const old = this.errHist[this.errPos];
		this.errHist[this.errPos] = this.errVar;
		this.errPos = (this.errPos + 1) & 31;
		// the error of a second ago while text came out: the noise after a signal ends would read ~1 dB
		if (this.chars === 0) this.errShown = this.errVar;
		else if (this.dcd && old > 0) this.errShown = old;
		this.fastPw += SQL_A * (yp - this.fastPw);
		if (this.dcd) this.dcdPw += 0.02 * (yp - this.dcdPw);
		else this.dcdPw = this.fastPw;
		const gone = this.dcd && this.fastPw < SQL_T * this.dcdPw;
		if (!this.dcd && this.q > 0.5) this.dcd = true;
		else if (this.dcd && (this.q < 0.25 || gone)) {
			this.dcd = false;
			this.q = Math.min(this.q, 0.2);
			this.vrx.reset();
			this.onDcdLost();
		}
	}

	/** QPSK: the best correlation with each value of the two code bits, into the Viterbi decoder. */
	private qpskBits(a: number): void {
		const b0 = [-2, -2];
		const b1 = [-2, -2];
		for (let k = 0; k < 4; k++) {
			const c = Math.cos(a - (k * Math.PI) / 2);
			const sym = qpskSymbol(k);
			b0[sym & 1] = Math.max(b0[sym & 1], c);
			b1[(sym >> 1) & 1] = Math.max(b1[(sym >> 1) & 1], c);
		}
		const bit = this.vit.decode(b0[1] - b0[0], b1[1] - b1[0]);
		if (bit >= 0 && this.dcd) this.varicodeBit(bit);
	}

	/**
	 * BPSK: the decision against a phase reference averaged over the last symbols (each turned to phase 0 by its own
	 * decision), about 1 dB better than against the previous symbol alone; a reversal is a change of the decision.
	 */
	private bpskBit(yr: number, yi: number): void {
		if (this.refR * this.refR + this.refI * this.refI <= 0) [this.refR, this.refI] = [yr, yi];
		const sg = yr * this.refR + yi * this.refI >= 0 ? 1 : -1;
		const bit = sg === this.prevSign ? 1 : 0;
		this.prevSign = sg;
		this.refR = (1 - REF_A) * this.refR + REF_A * yr * sg;
		this.refI = (1 - REF_A) * this.refI + REF_A * yi * sg;
		if (this.dcd) this.varicodeBit(bit);
	}

	private varicodeBit(bit: number): void {
		const ch = this.vrx.bit(bit);
		if (ch === -1) return;
		if (ch === -2) {
			this.bad++;
			this.onChar(-2);
			return;
		}
		this.chars++;
		this.lastActive = this.now();
		this.onChar(ch);
	}
}
