// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/aero/aero_demod.cpp (AeroFramer), https://github.com/adswill/OnAir;
// see third_party/onair. Changes: the 64-bit window of hard bits is two 32-bit words; the frame goes to a callback
// without the demodulator's carrier and Eb/N0 (the demodulator adds them).
//
// Soft channel bits to frames: unique-word search, a flywheel from frame to frame (the word may come one bit early or
// late), header, decoding. A 10500 bit/s frame carries the word on both OQPSK arms, each arm with its own inversion.

import { AERO_UW, AeroFrameDecoder, aeroFrameFormat, isOqpsk, totalBits } from './phy';
import type { AeroDecodedFrame, AeroFrameFormat } from './types';

const HIST = 16384;
const SEARCH = 0;
const COLLECT = 1;
const EXPECT = 2;

const popcount = (v: number): number => {
	let x = v - ((v >>> 1) & 0x55555555);
	x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
	return (Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24) & 0xff;
};

/** Bit k (0 = newest) of the 64-bit window hi:lo. */
const bitAt = (hi: number, lo: number, k: number): number => (k >= 32 ? (hi >>> (k - 32)) & 1 : (lo >>> k) & 1);

/** The 32 bits of the arm that holds bit `first` of the window: first = 1 takes 63, 61, .., 1; first = 0 takes 62, .., 0. */
function armWord(hi: number, lo: number, first: number): number {
	let r = 0;
	for (let i = 31; i >= 0; i--) r = ((r << 1) | bitAt(hi, lo, 2 * i + first)) >>> 0;
	return r;
}

export class AeroFramer {
	readonly fmt: AeroFrameFormat;
	private readonly dec: AeroFrameDecoder;
	private readonly hist = new Float32Array(HIST);
	/** Bits pushed so far. */
	private idx = 0;
	/** The last 64 hard bits, newest in bit 0 of `lo`. */
	private hi = 0;
	private lo = 0;
	private st = SEARCH;
	private frameStart = 0;
	private nextUwEnd = 0;
	private fromSearch = false;
	/** Inversion of the bits at even / odd positions (MSK: both the same). */
	private readonly invPar = [0, 0];
	private lastUwErr = 0;
	private misses = 0;
	private badFrames = 0;
	private dcd = 0;
	private readonly coded: Float32Array;
	frames = 0;
	uwMisses = 0;
	uwBitErrors = 0;
	falseSyncs = 0;

	constructor(
		bitRate: number,
		private readonly onFrame: (frame: AeroDecodedFrame, uwErrors: number) => void,
	) {
		const f = aeroFrameFormat(bitRate);
		if (!f) throw new Error(`no Aero frame at ${bitRate} bit/s`);
		this.fmt = f;
		this.dec = new AeroFrameDecoder(bitRate);
		this.coded = new Float32Array(f.codedBits);
	}

	/** A frame start is known. */
	get synced(): boolean {
		return this.st !== SEARCH;
	}

	/** The SU checks have been good lately (JAERO's data carrier detect). */
	get dataLock(): boolean {
		return this.st !== SEARCH && this.dcd > 2;
	}

	private at(i: number): number {
		return this.hist[i % HIST];
	}

	private need(): number {
		return this.fmt.headerBits + this.fmt.skipBits + this.fmt.codedBits;
	}

	/** Unique word errors after the best inversion of the word ending at bit `end` (absolute); sets `inv` for that frame. */
	private uwErrors(end: number, inv: number[]): number {
		let hi = 0,
			lo = 0;
		for (let k = this.fmt.uwBits - 1; k >= 0; k--) {
			hi = ((hi << 1) | (lo >>> 31)) >>> 0;
			lo = ((lo << 1) | Number(this.at(end - k) > 0)) >>> 0;
		}
		return this.uwErrorsWord(hi, lo, end, inv);
	}

	private uwErrorsWord(hi: number, lo: number, end: number, inv: number[]): number {
		if (!isOqpsk(this.fmt)) {
			const e = popcount((lo ^ AERO_UW) >>> 0);
			inv[0] = inv[1] = e > 16 ? 1 : 0;
			return e > 16 ? 32 - e : e;
		}
		// bit 0 of the window is position `end`; bit 1 is end - 1
		const eB = popcount((armWord(hi, lo, 0) ^ AERO_UW) >>> 0),
			eA = popcount((armWord(hi, lo, 1) ^ AERO_UW) >>> 0);
		inv[end % 2] = eB > 16 ? 1 : 0;
		inv[(end + 1) % 2] = eA > 16 ? 1 : 0;
		return Math.max(eA > 16 ? 32 - eA : eA, eB > 16 ? 32 - eB : eB); // the worse arm decides
	}

	/** One channel bit, positive = 1. */
	push(s: number): void {
		this.hist[this.idx % HIST] = s;
		this.hi = ((this.hi << 1) | (this.lo >>> 31)) >>> 0;
		this.lo = ((this.lo << 1) | Number(s > 0)) >>> 0;
		const cur = this.idx++;
		if (this.st === SEARCH) {
			if (this.trySync(cur)) this.dec.reset();
			return;
		}
		if (this.st === EXPECT) {
			if (cur < this.nextUwEnd + 1) return;
			if (!this.expect()) return;
			// the frame may already have started: on to collecting with the bits already here
		}
		// a frame taken on timing alone: the word may turn up elsewhere (samples were lost), so keep looking for it
		if (this.lastUwErr < 0 && cur + 1 > this.frameStart && this.trySync(cur)) return;
		if (cur + 1 < this.frameStart + this.need()) return;
		this.frame();
	}

	/** The word at the expected place, one bit early or late (a timing slip); false when sync is given up. */
	private expect(): boolean {
		let best = 99;
		let bestEnd = this.nextUwEnd;
		const bi = [0, 0];
		const inv = [0, 0];
		for (let d = -1; d <= 1; d++) {
			const end = this.nextUwEnd + d;
			const e = this.uwErrors(end, inv);
			if (e < best || (e === best && d === 0)) {
				best = e;
				bestEnd = end;
				bi[0] = inv[0];
				bi[1] = inv[1];
			}
		}
		if (best <= 7) {
			this.invPar[0] = bi[0];
			this.invPar[1] = bi[1];
			this.lastUwErr = best;
			this.uwBitErrors += best;
			this.frameStart = bestEnd + 1;
			this.misses = 0;
		} else {
			this.lastUwErr = -1;
			this.uwMisses++;
			this.frameStart = this.nextUwEnd + 1;
			if (++this.misses > 3) {
				this.st = SEARCH;
				return false;
			}
		}
		this.fromSearch = false;
		this.st = COLLECT;
		return true;
	}

	/** The word ending at bit `cur`, strictly (searching): a frame starts after it. */
	private trySync(cur: number): boolean {
		if (cur + 1 < this.fmt.uwBits) return false;
		const inv = [0, 0];
		const e = this.uwErrorsWord(isOqpsk(this.fmt) ? this.hi : 0, this.lo, cur, inv);
		if (e > 3) return false;
		this.invPar[0] = inv[0];
		this.invPar[1] = inv[1];
		this.lastUwErr = e;
		this.frameStart = cur + 1;
		this.fromSearch = true;
		this.misses = 0;
		this.st = COLLECT;
		return true;
	}

	private bitAt(i: number): number {
		const v = this.at(i);
		return this.invPar[i % 2] ? -v : v;
	}

	private frame(): void {
		const f = this.fmt;
		let header = 0;
		let p = this.frameStart;
		for (let k = 0; k < f.headerBits; k++, p++) header = (header << 1) | Number(this.bitAt(p) > 0);
		p += f.skipBits;
		for (let k = 0; k < f.codedBits; k++, p++) this.coded[k] = this.bitAt(p);
		const df = this.dec.decode(this.coded, header);
		if (this.fromSearch && header >> 12 !== 1 && df.susOk === 0) {
			// a chance match of the word: look again
			this.falseSyncs++;
			this.st = SEARCH;
			return;
		}
		this.dcd = df.susOk ? Math.min(this.dcd + 2 * df.susOk, 12) : this.dcd;
		this.dcd = Math.max(this.dcd - 3 * df.susBad, 0);
		this.badFrames = df.susOk ? 0 : this.badFrames + 1;
		this.frames++;
		this.onFrame(df, this.lastUwErr);
		this.nextUwEnd = this.frameStart + this.need() - 1 + f.uwBits;
		this.st = this.badFrames >= 4 ? SEARCH : EXPECT;
	}
}

/** Bits of one frame, for the demodulator's give-up time. */
export const frameBits = (bitRate: number): number => {
	const f = aeroFrameFormat(bitRate);
	return f ? totalBits(f) : 4200;
};
