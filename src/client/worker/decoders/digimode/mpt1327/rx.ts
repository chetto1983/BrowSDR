// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/mpt1327/mpt1327_rx.cpp and
// core/include/dect2/mpt1327/mpt1327_rx.h (Decoder: the linear resampler to 24 kHz, the MSK-style differential FFSK
// demodulator around 1500 Hz, the per-phase sync search with the eye of each phase, codeword framing in the standard
// and tolerant modes), https://github.com/adswill/OnAir; see third_party/onair. Changes: the 64-bit bit histories are
// pairs of 32-bit words; the 1500 Hz oscillator is a table of 16 phases (an exact sixteenth of a turn per sample); an
// event carries the system identity known when it came.

import { decodeAddress, decodeCcsc, field, fromParts, popcount, SYNC, valid, validParts, correct } from './proto';
import type { MptEvent, MptStats, MptSyncMode } from './types';

/** Internal audio rate: 20 samples per bit of 1200 bit/s. */
const FS = 24000;
const SPB = 20;
const TAPS = 31;
/** Seconds a good codeword keeps the lock indicator. */
const LOCK_HOLD = 3;
/** Seconds without an exact sync word before auto mode turns the tolerant framing on. */
const AUTO_WAIT = 8;

/** Hamming-windowed sinc low-pass at 900 Hz, unity gain. */
const LOWPASS = ((): Float64Array => {
	const h = Float64Array.from({ length: TAPS }, (_, i) => {
		const x = i - (TAPS - 1) / 2;
		const s = x === 0 ? (2 * 900) / FS : Math.sin((2 * Math.PI * 900 * x) / FS) / (Math.PI * x);
		return s * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (TAPS - 1)));
	});
	const sum = h.reduce((a, b) => a + b, 0);
	return h.map((v) => v / sum);
})();
/** 1500 Hz at 24 kHz: a sixteenth of a turn per sample. */
const OSC_COS = Float64Array.from({ length: 16 }, (_, n) => Math.cos((2 * Math.PI * n) / 16));
const OSC_SIN = Float64Array.from({ length: 16 }, (_, n) => Math.sin((2 * Math.PI * n) / 16));

const emptyStats = (): MptStats => ({ good: 0, corrected: 0, bad: 0, ccsc: 0, messages: 0, sys: -1, tolerant: false, locked: false, t: 0 });
/** Silence and constant carriers are valid all-zero codewords. */
const plausible = (hi: number, lo: number): boolean => {
	const pc = popcount(hi) + popcount(lo);
	return pc >= 8 && pc <= 56;
};

/** MPT 1327 control channel: FM discriminator audio in, codewords and messages out. */
export class MptReceiver {
	stats = emptyStats();
	private events: MptEvent[] = [];
	mode: MptSyncMode = 'auto';
	private rate = 0;
	private srcPos = 0;
	private prev = 0;
	private havePrev = false;
	/** Mixer input ring (re, im interleaved, doubled so the newest taps are contiguous) and the one-bit delay ring. */
	private readonly zin = new Float64Array(4 * TAPS);
	private zpos = 0;
	private readonly zring = new Float64Array(2 * SPB);
	private zr = 0;
	private dc = 0;
	private sample = 0;
	private readonly histHi = new Int32Array(SPB);
	private readonly histLo = new Int32Array(SPB);
	private readonly eye = new Float64Array(SPB);
	private collecting = false;
	private inverted = false;
	private bitsLeft = 0;
	private nextBit = 0;
	private accHi = 0;
	private accLo = 0;
	private lastGoodT = -1e9;
	private stdSyncs = 0;
	private tolActive = false;
	/** Tolerant framing: codewords seen with bit 1 set in the normal / inverted tone mapping. */
	private readonly tolVote = [0, 0];

	reset(): void {
		this.stats = emptyStats();
		this.events = [];
		this.srcPos = this.prev = 0;
		this.havePrev = false;
		this.zin.fill(0);
		this.zring.fill(0);
		this.zpos = this.zr = this.dc = this.sample = 0;
		this.histHi.fill(0);
		this.histLo.fill(0);
		this.eye.fill(0);
		this.collecting = false;
		this.lastGoodT = -1e9;
		this.stdSyncs = 0;
		this.tolVote[0] = this.tolVote[1] = 0;
		this.tolActive = this.mode === 'tolerant';
	}

	setSyncMode(mode: MptSyncMode): void {
		this.mode = mode;
		this.tolActive = mode === 'tolerant';
	}

	/** Messages decoded since the last call. */
	takeEvents(): MptEvent[] {
		const e = this.events;
		this.events = [];
		return e;
	}

	/** FM discriminator audio at fs Hz (any rate above about 6 kHz), resampled linearly to 24 kHz. */
	process(a: ArrayLike<number>, fs: number): void {
		if (fs !== this.rate) {
			this.rate = fs;
			this.srcPos = 0;
			this.havePrev = false;
		}
		if (fs === FS) {
			for (let i = 0; i < a.length; i++) this.audioSample(a[i]);
			return;
		}
		const step = fs / FS; // input samples per output sample
		for (let i = 0; i < a.length; i++) {
			if (!this.havePrev) {
				this.prev = a[i];
				this.havePrev = true;
				this.srcPos = 0;
				continue;
			}
			// outputs that fall between the previous input and a[i]
			for (; this.srcPos < 1; this.srcPos += step) this.audioSample(this.prev + (a[i] - this.prev) * this.srcPos);
			this.srcPos -= 1;
			this.prev = a[i];
		}
	}

	/** One sample at 24 kHz: mixed down by 1500 Hz, low-passed, compared with the sample one bit earlier. */
	private audioSample(a: number): void {
		this.dc += (a - this.dc) * (1 / (FS * 2));
		const x = a - this.dc;
		const ph = this.sample & 15;
		const zin = this.zin;
		const p = this.zpos;
		zin[2 * p] = zin[2 * (p + TAPS)] = x * OSC_COS[ph];
		zin[2 * p + 1] = zin[2 * (p + TAPS) + 1] = -x * OSC_SIN[ph];
		let zre = 0;
		let zim = 0;
		for (let k = 0; k < TAPS; k++) {
			const j = 2 * (p + TAPS - k);
			zre += zin[j] * LOWPASS[k];
			zim += zin[j + 1] * LOWPASS[k];
		}
		this.zpos = (p + 1) % TAPS;
		const r = 2 * this.zr;
		const ore = this.zring[r];
		const oim = this.zring[r + 1];
		this.zring[r] = zre;
		this.zring[r + 1] = zim;
		this.zr = (this.zr + 1) % SPB;
		// the phase step over one bit: +90 degrees for the higher tone, -90 for the lower
		this.onBit(zim * ore - zre * oim);
		this.sample++;
		this.stats.t = this.sample / FS;
		this.stats.locked = this.stats.t - this.lastGoodT < LOCK_HOLD;
	}

	/** The phase whose eye is widest, as an offset from phase ph (-SPB/2 .. SPB/2). */
	private bestOffset(ph: number): number {
		let best = ph;
		for (let q = 0; q < SPB; q++) if (this.eye[q] > this.eye[best] * 1.0001) best = q;
		let d = best - ph;
		if (d > SPB / 2) d -= SPB;
		if (d <= -SPB / 2) d += SPB;
		return d;
	}

	/** m: soft value of the bit that ends at this sample (positive: the higher tone). */
	private onBit(m: number): void {
		const ph = this.sample % SPB;
		const bit = m > 0 ? 1 : 0;
		const hi = (this.histHi[ph] << 1) | (this.histLo[ph] >>> 31);
		const lo = (this.histLo[ph] << 1) | bit;
		this.histHi[ph] = hi;
		this.histLo[ph] = lo;
		this.eye[ph] += (Math.abs(m) - this.eye[ph]) / 32;
		if (this.collecting) {
			if (this.sample === this.nextBit) {
				this.accHi = (this.accHi << 1) | (this.accLo >>> 31);
				this.accLo = (this.accLo << 1) | bit;
				this.nextBit += SPB;
				if (--this.bitsLeft === 0)
					this.handleCodeword(this.inverted ? fromParts(~this.accHi, ~this.accLo) : fromParts(this.accHi, this.accLo));
			}
			return;
		}
		const lo16 = lo & 0xffff;
		const inv = lo16 === (~SYNC & 0xffff);
		const exact = lo16 === SYNC || inv;
		if (exact) this.stdSyncs++;
		else if (this.mode === 'auto' && !this.tolActive && this.stdSyncs === 0 && this.sample / FS > AUTO_WAIT) this.tolActive = true;
		this.stats.tolerant = this.tolActive;
		if (exact) this.onSync(ph, hi, lo, inv);
		else if (this.tolActive) this.onTolerant(ph, hi, lo);
	}

	/** Sync word not checked: a position is the end of a codeword when the 64 bits up to it have good check bits. */
	private onTolerant(ph: number, hi: number, lo: number): void {
		// the code contains the all-ones word, so a codeword and its complement are both valid
		if (!plausible(hi, lo) || !validParts(hi, lo)) return;
		const d = this.bestOffset(ph);
		// the polarity is voted from bit 1 (address codewords, which dominate a control channel, have it set)
		this.tolVote[hi >>> 31 ? 0 : 1]++;
		this.inverted = this.tolVote[1] > this.tolVote[0];
		this.nextBit = this.sample + d + SPB; // the codeword that just ended is taken now, the next one follows on the grid
		this.handleCodeword(this.inverted ? fromParts(~hi, ~lo) : fromParts(hi, lo));
	}

	/** SYNC (or its complement): the last 64 bits are a control channel system codeword when this is a real sync. */
	private onSync(ph: number, hi: number, lo: number, inv: boolean): void {
		const [h, l] = inv ? [~hi, ~lo] : [hi, lo];
		const sys = validParts(h, l) ? decodeCcsc(fromParts(h, l)) : undefined;
		const now = this.sample / FS;
		// a bare sync (the start-up sequence has no system codeword before its first address codeword) is taken once the
		// 16 bits before it are the preamble of bit reversals (at most two bits wrong), or once the channel is locked
		if (sys === undefined && now - this.lastGoodT >= LOCK_HOLD && popcount(((l >>> 16) & 0xffff) ^ 0xaaaa) > 2) return;
		if (sys !== undefined) {
			this.stats.ccsc++;
			this.stats.good++;
			this.stats.sys = sys;
			this.lastGoodT = now;
		}
		// all sample phases carry the same bit stream: take the following 64 bits at the phase with the widest eye
		const d = this.bestOffset(ph);
		this.inverted = inv;
		this.collecting = true;
		this.bitsLeft = 64;
		this.accHi = this.accLo = 0;
		this.nextBit = this.sample + d + SPB; // the first bit after the sync, at the chosen phase
	}

	private handleCodeword(word: bigint): void {
		this.collecting = false;
		const t = this.sample / FS;
		let cw = word;
		if (!this.tolActive && !valid(cw)) {
			// one wrong bit is repaired (Appendix 2); the tolerant framing never guesses
			const fixed = correct(cw);
			if (fixed !== undefined) {
				cw = fixed;
				this.stats.corrected++;
			}
		}
		const hi = Number(cw >> 32n);
		const lo = Number(cw & 0xffffffffn);
		if (!valid(cw) || (this.tolActive && !plausible(hi, lo))) {
			this.stats.bad++;
			return;
		}
		this.stats.good++;
		this.lastGoodT = t;
		if (this.tolActive) this.nextOnGrid(cw);
		const m = decodeAddress(cw);
		if (m) {
			this.stats.messages++;
			this.events.push({ t, msg: m, sys: this.stats.sys });
		}
	}

	/** Tolerant framing: codewords follow each other on the 64-bit grid, without a sync word. */
	private nextOnGrid(cw: bigint): void {
		if (field(cw, 1, 1) === 0) {
			const sys = decodeCcsc(cw);
			if (sys !== undefined || popcount(Number(cw & 0xffffn) ^ SYNC) <= 4) {
				this.stats.ccsc++;
				this.stats.sys = sys ?? field(cw, 2, 15);
			}
		}
		this.collecting = true;
		this.bitsLeft = 64;
		this.accHi = this.accLo = 0;
	}
}
