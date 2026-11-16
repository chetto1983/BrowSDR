// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/hfdig/hfdig_wspr.cpp (wsprFano: Fano sequential decoding of the
// K=32 r=1/2 code, after P. Karn's fano.c as WSJT-X uses it), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the nodes are columns of typed arrays; the parity of a 32-bit word comes from a 16-bit table, and the second
// branch's parities are the first's flipped (both polynomials are odd).

import { POLY1, POLY2 } from './codec';

const BITS = 81;
const DATA = 50;
const DELTA = 16;

const PARITY16 = Uint8Array.from({ length: 1 << 16 }, (_, x) => {
	let p = 0;
	for (let v = x; v; v &= v - 1) p ^= 1;
	return p;
});
const parity = (x: number): number => PARITY16[x & 0xffff] ^ PARITY16[x >>> 16];

const met0 = new Int32Array(162);
const met1 = new Int32Array(162);
const enc = new Int32Array(BITS + 1);
const gamma = new Int32Array(BITS + 1);
const tm0 = new Int32Array(BITS + 1);
const tm1 = new Int32Array(BITS + 1);
const branchIdx = new Uint8Array(BITS + 1);

/** The metric of a coded bit: log2(2 P(bit | y)) - rate, in units of 1/8 bit (C's lround: halves away from zero). */
function metric(l: number, bit: number): number {
	const x = bit ? l : -l;
	const p = 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, x))));
	const v = 8 * (Math.log2(2 * Math.max(1e-6, p)) - 0.5);
	return Math.sign(v) * Math.round(Math.abs(v));
}

/** The two branch metrics of node k, the better first (its bit put in the register's LSB). */
function fill(k: number): void {
	const s0 = enc[k];
	// both polynomials are odd: the register with a 1 shifted in flips both parities
	const p1 = parity(s0 & POLY1);
	const p2 = parity(s0 & POLY2);
	const m0 = (p1 ? met1 : met0)[2 * k] + (p2 ? met1 : met0)[2 * k + 1];
	if (k >= DATA) {
		tm0[k] = m0;
		tm1[k] = 0;
		return;
	}
	const m1 = (p1 ? met0 : met1)[2 * k] + (p2 ? met0 : met1)[2 * k + 1];
	if (m0 >= m1) {
		tm0[k] = m0;
		tm1[k] = m1;
	} else {
		tm0[k] = m1;
		tm1[k] = m0;
		enc[k] = s0 | 1;
	}
}

/** Fano sequential decoding of 162 soft bits (llr > 0 means 1, deinterleaved, in coded order) into 50 data bits. */
export function wsprFano(llr: ArrayLike<number>, d: Uint8Array, maxCycles: number): boolean {
	for (let i = 0; i < 162; i++) {
		met0[i] = metric(llr[i], 0);
		met1[i] = metric(llr[i], 1);
	}
	let t = 0;
	enc[0] = 0;
	gamma[0] = 0;
	branchIdx[0] = 0;
	fill(0);
	let np = 0;
	let done = false;
	for (let cyc = 0; cyc < maxCycles; cyc++) {
		const ng = gamma[np] + (branchIdx[np] ? tm1[np] : tm0[np]);
		if (ng >= t) {
			// first visit: tighten the threshold
			if (gamma[np] < t + DELTA) while (ng >= t + DELTA) t += DELTA;
			gamma[np + 1] = ng;
			enc[np + 1] = enc[np] << 1;
			if (++np === BITS) {
				done = true;
				break;
			}
			fill(np);
			branchIdx[np] = 0;
			continue;
		}
		// look back
		for (;;) {
			if (np === 0 || gamma[np - 1] < t) {
				t -= DELTA;
				if (branchIdx[np] !== 0) {
					branchIdx[np] = 0;
					enc[np] ^= 1;
				}
				break;
			}
			--np;
			if (np < DATA && branchIdx[np] !== 1) {
				branchIdx[np]++;
				enc[np] ^= 1;
				break;
			}
		}
	}
	if (!done) return false;
	d.fill(0, 0, 7);
	for (let k = 0; k < DATA; k++) if (enc[k] & 1) d[k >> 3] |= 0x80 >> (k & 7);
	return true;
}
