// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/dab/dab_rx.cpp (SubDec: the time de-interleaver over 16 CIFs with
// erasures, the early start, depuncturing, Viterbi and energy dispersal of one sub-channel), https://github.com/adswill/OnAir;
// see third_party/onair. Changes: the 16 CIFs sit in one Int8Array ring; the depuncturing table of the profile is cached.

import { descramble } from '@/worker/decoders/dab/fec/crc';
import { depuncture, subchannelProfile } from '@/worker/decoders/dab/fec/puncture';
import type { SubchannelProfile } from '@/worker/decoders/dab/fec/types';
import { Viterbi } from '@/worker/decoders/dab/fec/viterbi';
import type { Subchannel } from '@/worker/decoders/dab/fic/types';
import type { FrameSink } from './types';

/** EN 300 401 table 21: the delay (in CIFs) of bit i is 15 - MAP[i mod 16]. */
const MAP = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15];

/**
 * The time de-interleaver and decoding of one sub-channel. CIFs lost on the way go in as erasures (soft value 0), so
 * the logical frames around them still decode: every one is spread over 16 CIFs and the code copes with a quarter of
 * them missing.
 */
export class SubchannelDecoder {
	private profile: SubchannelProfile | null = null;
	private hist = new Int8Array(0);
	private count = 0;
	/** CIFs in before the first logical frame is decoded (10 for DAB+ audio: Reed-Solomon and the CRCs catch a failed one). */
	early = 16;
	private one = new Int8Array(0);
	private mother = new Int8Array(0);
	private dec = new Uint8Array(0);
	private bytes = new Uint8Array(0);
	private readonly viterbi = new Viterbi();

	/** Decodes this sub-channel from now on; false when its protection matches no profile of EN 300 401. */
	configure(sub: Subchannel): boolean {
		this.profile = subchannelProfile(sub.eep, sub.size, sub.option, sub.level, sub.uepIndex);
		this.count = 0;
		const p = this.profile;
		if (!p) return false;
		this.hist = new Int8Array(16 * p.bits);
		this.one = new Int8Array(p.bits);
		this.mother = new Int8Array(4 * (p.infoBits + 6));
		this.dec = new Uint8Array(p.infoBits);
		this.bytes = new Uint8Array(p.infoBits / 8);
		return true;
	}

	reset(): void {
		this.count = 0;
	}

	/**
	 * One CIF of the sub-channel: src[from .. from + size * 64), or null when it was lost. `out` gets every logical frame
	 * decoded, erased when most of its soft bits were.
	 */
	cif(src: Int8Array | null, from: number, out: FrameSink): void {
		const p = this.profile;
		if (!p) return;
		const bits = p.bits;
		const slot = (this.count % 16) * bits;
		if (src) this.hist.set(src.subarray(from, from + bits), slot);
		else this.hist.fill(0, slot, slot + bits);
		this.count++;
		// The first logical frames are decoded before all of their 16 CIFs are in: the ones from before the start are
		// erased. That starts the audio about 140 ms sooner after a lock or a service switch.
		if (this.count < this.early) return;
		const zeros = this.gather(bits);
		if (this.count < 16 && zeros * 8 > bits * 3) return; // more than 3/8 missing at the start: not worth trying
		depuncture(p, this.one, this.mother);
		this.viterbi.decode(this.mother, p.infoBits, this.dec);
		descramble(this.dec, p.infoBits);
		const dec = this.dec,
			bytes = this.bytes;
		for (let i = 0; i < bytes.length; i++) {
			let v = 0;
			for (let b = 0; b < 8; b++) v = (v << 1) | dec[i * 8 + b];
			bytes[i] = v;
		}
		out(bytes, zeros * 4 > bits * 3);
	}

	/** The bits of the oldest complete logical frame from the 16 CIFs; returns how many are erased. */
	private gather(bits: number): number {
		const one = this.one,
			hist = this.hist,
			count = this.count;
		let zeros = 0;
		for (let phase = 0; phase < 16; phase++) {
			const back = 15 - MAP[phase];
			if (back >= count) {
				// a CIF from before the start
				for (let i = phase; i < bits; i += 16) one[i] = 0;
				zeros += Math.ceil((bits - phase) / 16);
				continue;
			}
			const base = ((count - 1 - back) % 16) * bits;
			for (let i = phase; i < bits; i += 16) {
				const v = hist[base + i];
				one[i] = v;
				if (v === 0) zeros++;
			}
		}
		return zeros;
	}
}
