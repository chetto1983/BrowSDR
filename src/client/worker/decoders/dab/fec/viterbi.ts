// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/dab/dab_fec.cpp (Trellis, vitForwardBody, viterbiDecode, convEncode),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: the branch metric of a next state is looked up from the 16
// sums of the four soft values (the same sums the sign table of OnAir forms), one metric array is kept instead of the even /
// odd halves, the add-compare-select is branchless and the decisions are packed into two 32-bit words per step; the
// buffers are reused between calls.

const GENS = [0o133, 0o171, 0o145, 0o133];

function parity(x: number): number {
	let p = 0;
	for (; x; x &= x - 1) p ^= 1;
	return p;
}

/** OUT[2 * s + b]: the 4 code bits (bit k = generator k) leaving state s with input bit b. */
const OUT = (() => {
	const t = new Uint8Array(128);
	for (let s = 0; s < 64; s++)
		for (let b = 0; b < 2; b++) {
			const reg = (b << 6) | s;
			let pat = 0;
			for (let k = 0; k < 4; k++) pat |= parity(GENS[k] & reg) << k;
			t[2 * s + b] = pat;
		}
	return t;
})();

/** The code bits of the two branches into next state ns: from (ns & 31) << 1 (PAT0) and from that + 1 (PAT1). */
const PAT0 = new Uint8Array(64);
const PAT1 = new Uint8Array(64);
for (let ns = 0; ns < 64; ns++) {
	const b = ns >> 5,
		ps0 = (ns & 31) << 1;
	PAT0[ns] = OUT[2 * ps0 + b];
	PAT1[ns] = OUT[2 * (ps0 | 1) + b];
}

/**
 * Soft-decision Viterbi decoder of the rate 1/4, K = 7 convolutional code (generators 133 171 145 133 octal).
 * `mother` holds 4 * (nbits + 6) soft values (positive = bit 1, 0 = punctured); the result is nbits bits, one per byte.
 */
export class Viterbi {
	private dec = new Uint32Array(0);
	private readonly bm = new Int32Array(16);
	private cur = new Int32Array(64);
	private next = new Int32Array(64);

	decode(mother: Int8Array, nbits: number, bits: Uint8Array): void {
		const steps = nbits + 6;
		if (this.dec.length < 2 * steps) this.dec = new Uint32Array(2 * steps);
		this.forward(mother, steps);
		const dec = this.dec;
		let state = 0; // the tail forces the encoder back to state 0
		for (let t = steps - 1; t >= 0; t--) {
			if (t < nbits) bits[t] = state >> 5;
			const d = (dec[2 * t + (state >> 5)] >>> (state & 31)) & 1;
			state = ((state & 31) << 1) | d;
		}
	}

	private forward(mother: Int8Array, steps: number): void {
		const bm = this.bm,
			dec = this.dec;
		let cur = this.cur,
			next = this.next;
		cur.fill(-8000);
		cur[0] = 0; // the encoder starts in state 0
		for (let t = 0; t < steps; t++) {
			const s0 = mother[4 * t],
				s1 = mother[4 * t + 1],
				s2 = mother[4 * t + 2],
				s3 = mother[4 * t + 3];
			for (let p = 0; p < 16; p++) bm[p] = (p & 1 ? s0 : -s0) + (p & 2 ? s1 : -s1) + (p & 4 ? s2 : -s2) + (p & 8 ? s3 : -s3);
			// the two next states of predecessors 2j and 2j + 1, without branches (the decisions are random)
			let w0 = 0,
				w1 = 0;
			for (let j = 0; j < 32; j++) {
				const m0 = cur[j << 1],
					m1 = cur[(j << 1) | 1];
				const a = m0 + bm[PAT0[j]],
					b = m1 + bm[PAT1[j]];
				const da = (a - b) >> 31; // -1 when b > a
				next[j] = a + ((b - a) & da);
				w0 |= (da & 1) << j;
				const c = m0 + bm[PAT0[j + 32]],
					d = m1 + bm[PAT1[j + 32]];
				const dc = (c - d) >> 31;
				next[j + 32] = c + ((d - c) & dc);
				w1 |= (dc & 1) << j;
			}
			dec[2 * t] = w0;
			dec[2 * t + 1] = w1;
			const tmp = cur;
			cur = next;
			next = tmp;
			if ((t & 15) === 15) {
				const r = cur[0];
				for (let s = 0; s < 64; s++) cur[s] -= r;
			}
		}
		this.cur = cur;
		this.next = next;
	}
}

/** The mother code word of nbits bits with the 6 tail bits: 4 * (nbits + 6) bits, one per byte. */
export function convEncode(bits: Uint8Array, nbits: number, mother: Uint8Array): void {
	let s = 0;
	for (let t = 0; t < nbits + 6; t++) {
		const b = t < nbits ? bits[t] & 1 : 0;
		const pat = OUT[2 * s + b];
		for (let k = 0; k < 4; k++) mother[4 * t + k] = (pat >> k) & 1;
		s = (((b << 6) | s) >> 1) & 63;
	}
}
