// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/vdl2/vdl2_rx.cpp (Vdl2Receiver: one channel's mixer, burst
// search, segment, the per-channel state machine and the tuning error tracking), https://github.com/adswill/OnAir; see
// third_party/onair. Changes: one channel, handed over by BrowSDR's channel filter at 84 kHz (8 samples per symbol,
// OnAir's channel rate), so the shared first stage, the moving sums and the decimating FIR (identities at this rate)
// are left out; input is taken in blocks so the rings never overflow; decoded bursts go to a callback.
//
// The channel is mixed to 0 Hz (the tuning error measured from the bursts taken out). A wider filter (+-12 kHz) feeds
// the burst search: the 16 training symbols are looked for with a differential correlation, which does not mind a
// carrier offset of up to +-5 kHz. A found burst is turned by its own carrier offset, filtered to the channel
// (+-8.6 kHz) and demodulated (demod.ts); then descrambling, the header and its FEC, the Reed-Solomon blocks, the
// HDLC frames and their check sequences, the AVLC frames.

import { parseFrame } from './avlc';
import { HEADER_BITS, PREAMBLE_PHASE, PREAMBLE_SYMS, VDL2_SYMBOL_RATE, headerDecode, layout, scramble } from './bits';
import { burstData, fcsOk, hdlcFrames } from './burst';
import { demodulate, lowpass, lround } from './demod';
import type { Vdl2Burst, Vdl2Counters, Vdl2Demod, Vdl2Layout, Vdl2Message } from './types';

/** Channel rate: 8 samples per symbol. */
export const VDL2_RATE = 84000;
const RING = 1 << 16;
const MASK = RING - 1;
/** Input samples taken between two runs of the state machine. */
const BLOCK = 4096;
const DET_THR = 0.56;
const DET_DROP = 0.88;

/** Rotation between neighbouring training symbols, conjugated, for the differential correlation. */
const STEP = PREAMBLE_PHASE.slice(1).map((p, q) => {
	const dp = ((p - PREAMBLE_PHASE[q]) * Math.PI) / 4;
	return [Math.cos(-dp), Math.sin(-dp)];
});

export class Vdl2Receiver {
	private readonly fs1 = VDL2_RATE;
	private readonly T = VDL2_RATE / VDL2_SYMBOL_RATE;
	/** Burst search: pass ~12 kHz, stop ~18 kHz. */
	private readonly h2 = lowpass(Math.ceil((6.6 * VDL2_RATE) / 6e3), 15e3 / VDL2_RATE);
	private readonly gd2 = this.h2.length >> 1;
	/** Channel filter for decoding: pass ~5.8 kHz, stop ~9.2 kHz (cuts some of the roll-off: less noise, a little ISI). */
	private readonly h3 = lowpass(Math.ceil((6.6 * VDL2_RATE) / 4e3), 7.5e3 / VDL2_RATE);
	// mixer
	private rotR = 1;
	private rotI = 0;
	private stepR = 1;
	private stepI = 0;
	private renorm = 0;
	private tuneErr = 0;
	private pendingTune = 0;
	private havePending = false;
	// the channel ring and the burst-search filter output ring
	private readonly x1 = new Float32Array(2 * RING);
	private readonly x2 = new Float32Array(2 * RING);
	private n1 = 0;
	private n2 = 0;
	// burst search
	private floor = 0;
	private blk = 0;
	private blkN = 0;
	private searchAt = 0;
	private peakOn = false;
	private peakM = 0;
	private peakAt = 0;
	private peakEnd = 0;
	private peakD = [0, 0];
	/** The training symbols' samples at the candidate start (interleaved), reused by every correlation. */
	private readonly corrS = new Float64Array(2 * PREAMBLE_SYMS);
	/** Differential correlation sum of the last correlate() call. */
	private readonly corrD = [0, 0];
	// a burst being collected: 0 searching, 1 waiting for the header, 2 waiting for the body
	private state = 0;
	private bAt = 0;
	private bCfo = 0;
	private bNeed = 0;
	private bSyms = 0;
	readonly counters: Vdl2Counters = { bursts: 0, good: 0, bad: 0, frames: 0, fcsBad: 0 };

	constructor(
		private readonly onBurst: (burst: Vdl2Burst) => void,
		private readonly track = true,
	) {}

	/** A burst is being received. */
	get busy(): boolean {
		return this.state !== 0;
	}

	/** The radio's tuning error the mixer takes out, Hz. */
	get tuneErrorHz(): number {
		return this.tuneErr;
	}

	/** Forgets the signal; the measured tuning error and the counters stay. */
	reset(): void {
		this.x1.fill(0);
		this.x2.fill(0);
		this.n1 = this.n2 = 0;
		this.floor = this.blk = this.blkN = 0;
		this.searchAt = 0;
		this.peakOn = false;
		this.state = 0;
		this.rotR = 1;
		this.rotI = 0;
		this.renorm = 0;
	}

	process(iq: Float32Array): void {
		for (let at = 0; at + 1 < iq.length; at += 2 * BLOCK) {
			if (this.havePending && this.state === 0) {
				this.tuneErr = this.pendingTune;
				this.havePending = false;
				const w = (-2 * Math.PI * this.tuneErr) / this.fs1;
				this.stepR = Math.cos(w);
				this.stepI = Math.sin(w);
			}
			const end = Math.min(iq.length, at + 2 * BLOCK);
			for (let i = at; i + 1 < end; i += 2) this.push(iq[i], iq[i + 1]);
			for (let it = 0; it < 10000; it++) {
				const [searchAt, state] = [this.searchAt, this.state];
				this.run();
				if (this.state === state && this.searchAt === searchAt) break;
			}
		}
	}

	private push(xr: number, xi: number): void {
		if (!Number.isFinite(xr) || !Number.isFinite(xi)) xr = xi = 0;
		const cr = this.rotR;
		const ci = this.rotI;
		const k = 2 * (this.n1 & MASK);
		this.x1[k] = xr * cr - xi * ci;
		this.x1[k + 1] = xr * ci + xi * cr;
		this.rotR = cr * this.stepR - ci * this.stepI;
		this.rotI = cr * this.stepI + ci * this.stepR;
		if (++this.renorm === 4096) {
			this.renorm = 0;
			const a = Math.hypot(this.rotR, this.rotI);
			this.rotR /= a;
			this.rotI /= a;
		}
		this.n1++;
		const h2 = this.h2;
		if (this.n1 < h2.length) return;
		// burst-search filter: x2[i] is centred on x1[i]
		const i = this.n1 - 1 - this.gd2;
		const b0 = this.n1 - h2.length;
		let ar = 0;
		let ai = 0;
		for (let j = 0; j < h2.length; j++) {
			const q = 2 * ((b0 + j) & MASK);
			ar += this.x1[q] * h2[j];
			ai += this.x1[q + 1] * h2[j];
		}
		this.x2[2 * (i & MASK)] = ar;
		this.x2[2 * (i & MASK) + 1] = ai;
		this.n2 = i + 1;
		// noise floor: block means, falling fast, rising slowly
		this.blk += ar * ar + ai * ai;
		if (++this.blkN === 512) {
			const m = this.blk / 512;
			if (this.floor <= 0) this.floor = m;
			else if (m < this.floor) this.floor = 0.7 * this.floor + 0.3 * m;
			else this.floor *= 1.003;
			this.blk = this.blkN = 0;
		}
	}

	/** Differential correlation of the training sequence starting at x2 index t: its strength (0 without enough energy); the sum goes to corrD. */
	private correlate(t: number): number {
		const s = this.corrS;
		let e = 0;
		for (let q = 0; q < PREAMBLE_SYMS; q++) {
			const k = 2 * ((t + lround(q * this.T)) & MASK);
			s[2 * q] = this.x2[k];
			s[2 * q + 1] = this.x2[k + 1];
			e += s[2 * q] ** 2 + s[2 * q + 1] ** 2;
		}
		e /= PREAMBLE_SYMS;
		let eh = 0;
		let et = 0; // the energy must fill the whole training sequence, not only its start or end
		for (let q = 0; q < 4; q++) {
			const r = 2 * (PREAMBLE_SYMS - 1 - q);
			eh += s[2 * q] ** 2 + s[2 * q + 1] ** 2;
			et += s[r] ** 2 + s[r + 1] ** 2;
		}
		if (!(this.floor > 0 && e > 3.0 * this.floor && Math.min(eh, et) > 4 * 0.3 * e)) return 0;
		let dr = 0;
		let di = 0;
		for (let q = 0; q + 1 < PREAMBLE_SYMS; q++) {
			// s[q+1] conj(s[q]) e^(-j dp)
			const [ar, ai, br, bi] = [s[2 * q + 2], s[2 * q + 3], s[2 * q], s[2 * q + 1]];
			const [pr, pi] = [ar * br + ai * bi, ai * br - ar * bi];
			dr += pr * STEP[q][0] - pi * STEP[q][1];
			di += pr * STEP[q][1] + pi * STEP[q][0];
		}
		this.corrD[0] = dr;
		this.corrD[1] = di;
		return Math.hypot(dr, di) / (e * (PREAMBLE_SYMS - 1));
	}

	private search(): void {
		const T = this.T;
		const span = Math.ceil(15 * T) + 1;
		while (this.state === 0 && this.searchAt + span < this.n2) {
			const t = this.searchAt;
			if (t < 10 * T + this.h3.length) {
				this.searchAt++;
				continue;
			}
			if (this.n2 - t > RING - 4096) {
				// fell behind
				this.searchAt = this.n2 - 1024;
				this.peakOn = false;
				continue;
			}
			const M = this.correlate(t);
			if (M >= DET_THR && (!this.peakOn || M >= this.peakM)) {
				if (!this.peakOn) this.peakEnd = t + Math.ceil((PREAMBLE_SYMS + 2) * T);
				this.peakOn = true;
				this.peakM = M;
				this.peakAt = t;
				this.peakD = [this.corrD[0], this.corrD[1]];
			}
			if (this.peakOn && (t + 1 >= this.peakEnd || (M < this.peakM * DET_DROP && M < DET_THR))) {
				this.peakOn = false;
				if (this.peakM >= DET_THR) this.beginBurst();
			}
			this.searchAt++;
		}
	}

	private beginBurst(): void {
		this.state = 1;
		this.bAt = this.peakAt;
		this.bCfo = (Math.atan2(this.peakD[1], this.peakD[0]) * VDL2_SYMBOL_RATE) / (2 * Math.PI);
		this.bNeed = this.bAt + Math.ceil((PREAMBLE_SYMS + 10) * this.T) + this.h3.length + 8;
		this.counters.bursts++;
	}

	/** The channel-filtered, carrier-corrected samples from x1 index a over n samples (interleaved). */
	private segment(a: number, n: number, cfo: number): Float64Array {
		const h3 = this.h3;
		const L = h3.length;
		const m = L >> 1;
		const z = new Float64Array(2 * (n + L));
		const w = (-2 * Math.PI * cfo) / this.fs1;
		for (let i = 0; i < n + L; i++) {
			const k = 2 * ((a + i - m) & MASK);
			const [c, s] = [Math.cos(w * (i - m)), Math.sin(w * (i - m))];
			z[2 * i] = this.x1[k] * c - this.x1[k + 1] * s;
			z[2 * i + 1] = this.x1[k] * s + this.x1[k + 1] * c;
		}
		const y = new Float64Array(2 * n);
		for (let i = 0; i < n; i++) {
			let re = 0;
			let im = 0;
			for (let j = 0; j < L; j++) {
				re += z[2 * (i + j)] * h3[j];
				im += z[2 * (i + j) + 1] * h3[j];
			}
			y[2 * i] = re;
			y[2 * i + 1] = im;
		}
		return y;
	}

	/** Demodulates nSym symbols after the training sequence (6 symbols are kept before it). */
	private demod(nSym: number): Vdl2Demod | undefined {
		const pre = 6;
		const a = this.bAt - Math.ceil(pre * this.T);
		const n = Math.ceil((pre + PREAMBLE_SYMS + nSym + 3) * this.T);
		return demodulate(this.segment(a, n, this.bCfo), this.bAt - a, this.T, nSym, this.bCfo);
	}

	/** The descrambled bits' header: length and layout. */
	private static header(bits: Uint8Array): { len: number; corrected: boolean; l?: Vdl2Layout } {
		scramble(bits, 0);
		let w = 0;
		for (let i = 0; i < HEADER_BITS; i++) w = (w << 1) | bits[i];
		const h = headerDecode(w);
		return { len: h.len, corrected: h.corrected, l: h.ok ? layout(h.len) : undefined };
	}

	private run(): void {
		this.search();
		if (this.state === 1 && this.n1 >= this.bNeed) this.headerStep();
		if (this.state === 2 && this.n1 >= this.bNeed) this.bodyStep();
	}

	private headerStep(): void {
		const o = this.demod(9);
		const l = o ? Vdl2Receiver.header(o.bits.slice(0, HEADER_BITS)).l : undefined;
		if (!l) return this.fail(false);
		const bits = HEADER_BITS + 8 * (l.dataOct + l.fecOct);
		this.bSyms = Math.floor((bits + 2) / 3);
		this.bNeed = this.bAt + Math.ceil((PREAMBLE_SYMS + this.bSyms + 4) * this.T) + this.h3.length + 8;
		if (this.bNeed - this.bAt > RING - 8192) return this.fail(false);
		this.state = 2;
	}

	private bodyStep(): void {
		const o = this.demod(this.bSyms);
		if (!o) return this.fail(true);
		const b = o.bits;
		const { len, corrected, l } = Vdl2Receiver.header(b);
		if (!l || b.length < HEADER_BITS + 8 * (l.dataOct + l.fecOct)) return this.fail(true);
		const data = burstData(b.subarray(HEADER_BITS), l, len);
		if (!data.bits) return this.fail(true);
		const messages: Vdl2Message[] = [];
		let bad = 0;
		for (const f of hdlcFrames(data.bits)) {
			const m = f.length >= 11 && fcsOk(f) ? parseFrame(f.subarray(0, f.length - 2)) : undefined;
			if (m) messages.push(m);
			else bad++;
		}
		this.counters.fcsBad += bad;
		if (!messages.length) return this.fail(true);
		this.counters.good++;
		this.counters.frames += messages.length;
		this.onBurst({
			messages,
			timeSec: this.bAt / this.fs1,
			levelDb: o.levelDb,
			snrDb: o.snrDb,
			cfoHz: o.cfoHz + this.tuneErr,
			rsFixed: data.fixed,
			headerFixed: corrected,
			bad,
		});
		if (this.track) {
			this.pendingTune = this.tuneErr + 0.3 * Math.max(-6000, Math.min(6000, o.cfoHz));
			this.havePending = true;
		}
		this.state = 0;
		this.searchAt = this.bAt + Math.floor((PREAMBLE_SYMS + this.bSyms) * this.T);
		this.peakOn = false;
	}

	private fail(counted: boolean): void {
		if (counted) this.counters.bad++;
		this.state = 0;
		this.searchAt = Math.max(this.searchAt, this.bAt + Math.ceil((PREAMBLE_SYMS + 4) * this.T));
		this.peakOn = false;
	}
}
