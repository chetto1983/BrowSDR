// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir rust/onair_vdl2/src/rs.rs (Reed-Solomon (255,249) with erasures),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: the decoder is split into its steps.
//
// Reed-Solomon (255,249) over GF(2^8) as VDL Mode 2 uses it: field polynomial 0x187, first root alpha^120, six roots.
// A burst's last block is shorter and carries fewer parity octets (the others are erasures for the decoder).
// ICAO Annex 10 Vol III Part I section 6.3.2, Doc 9776.

import { RS_K, RS_N } from './bits';

const FCR = 120;
const ROOTS = 6;

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
	EXP[i] = x;
	LOG[x] = i;
	x <<= 1;
	if (x & 0x100) x ^= 0x187;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];

const mul = (a: number, b: number): number => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
const div = (a: number, b: number): number => (a ? EXP[(LOG[a] + 255 - LOG[b]) % 255] : 0);

/** alpha^e (e may be negative). */
function pw(e: number): number {
	let r = e % 255;
	if (r < 0) r += 255;
	return EXP[r];
}

/** The generator polynomial, highest power first (g[0] = 1). */
function genPoly(): Uint8Array {
	let p = new Uint8Array(ROOTS + 1);
	p[0] = 1;
	for (let deg = 0; deg < ROOTS; deg++) {
		const r = pw(FCR + deg);
		const q = new Uint8Array(ROOTS + 1);
		for (let k = 0; k <= deg; k++) {
			q[k] ^= p[k];
			q[k + 1] ^= mul(p[k], r);
		}
		p = q;
	}
	return p;
}
const GEN = genPoly();

/** The six parity octets of 249 data octets. */
export function rsEncode(data: Uint8Array): Uint8Array {
	const r = new Uint8Array(ROOTS);
	for (let i = 0; i < RS_K; i++) {
		const fb = data[i] ^ r[0];
		for (let k = 0; k < ROOTS - 1; k++) r[k] = r[k + 1] ^ mul(fb, GEN[k + 1]);
		r[ROOTS - 1] = mul(fb, GEN[ROOTS]);
	}
	return r;
}

/** Syndromes S_i = c(a^(fcr+i)), c[0] the highest power. */
function syndromes(cw: Uint8Array): Uint8Array {
	const s = new Uint8Array(ROOTS);
	for (let i = 0; i < ROOTS; i++) {
		const a = pw(FCR + i);
		let v = 0;
		for (let j = 0; j < RS_N; j++) v = mul(v, a) ^ cw[j];
		s[i] = v;
	}
	return s;
}

/** Error and erasure locator by Berlekamp-Massey, started from the erasures (positions RS_K + nParity .. N - 1). */
function locator(s: Uint8Array, nParity: number): Uint8Array {
	const nEr = ROOTS - nParity;
	let lam = new Uint8Array(ROOTS + 1);
	lam[0] = 1;
	for (let e = 0; e < nEr; e++) {
		const x = pw(RS_N - 1 - (RS_K + nParity + e));
		for (let k = ROOTS; k >= 1; k--) lam[k] ^= mul(x, lam[k - 1]);
	}
	let b = lam.slice();
	let l = nEr;
	for (let r = nEr + 1; r <= ROOTS; r++) {
		let d = 0;
		for (let i = 0; i < r; i++) d ^= mul(lam[i], s[r - 1 - i]);
		const xb = new Uint8Array(ROOTS + 1);
		for (let k = ROOTS; k >= 1; k--) xb[k] = b[k - 1];
		if (d === 0) {
			b = xb;
			continue;
		}
		const t = lam.map((value, k) => value ^ mul(d, xb[k]));
		if (2 * l < r + nEr) {
			l = r + nEr - l;
			b = lam.map((value) => div(value, d));
		} else {
			b = xb;
		}
		lam = t;
	}
	return lam;
}

/** Chien search over the 255 positions: the positions where the locator has a root, or undefined when they do not match its degree. */
function roots(lam: Uint8Array, deg: number): number[] | undefined {
	const pos: number[] = [];
	for (let j = 0; j < RS_N; j++) {
		const e = RS_N - 1 - j; // locator exponent of position j
		let v = 0;
		for (let k = 0; k <= deg; k++) v ^= mul(lam[k], pw(-e * k));
		if (v === 0) {
			if (pos.length === ROOTS) return undefined;
			pos.push(j);
		}
	}
	return pos.length === deg ? pos : undefined;
}

/**
 * Decodes a codeword in place; `nParity` (0..6, clamped) parity octets are present, the rest are erased. Returns the
 * octets corrected (erasures not counted) or -1 when the block cannot be corrected.
 */
export function rsDecode(cw: Uint8Array, nParityIn: number): number {
	const nParity = Math.max(0, Math.min(ROOTS, nParityIn));
	const s = syndromes(cw);
	const zero = s.every((v) => v === 0);
	const nEr = ROOTS - nParity;
	if (zero && nEr === 0) return 0;
	const lam = locator(s, nParity);
	let deg = 0;
	lam.forEach((v, k) => {
		if (v) deg = k;
	});
	if (deg === 0) return zero ? 0 : -1;
	const pos = roots(lam, deg);
	if (!pos) return -1;
	// evaluator omega = S(x) lambda(x) mod x^roots
	const om = new Uint8Array(ROOTS);
	for (let i = 0; i < ROOTS; i++) for (let k = 0; k <= Math.min(i, deg); k++) om[i] ^= mul(lam[k], s[i - k]);
	let fixed = 0;
	for (const j of pos) {
		const e = RS_N - 1 - j;
		const xinv = pw(-e);
		let o = 0;
		let xp = 1;
		for (const omi of om) {
			o ^= mul(omi, xp);
			xp = mul(xp, xinv);
		}
		let dl = 0;
		for (let k = 1; k <= deg; k += 2) dl ^= mul(lam[k], pw(-e * (k - 1)));
		if (dl === 0) return -1;
		const val = mul(div(o, dl), pw(e * (1 - FCR)));
		if (val !== 0 && j < RS_K + nParity) fixed++;
		cw[j] ^= val;
	}
	return 2 * fixed + nEr > ROOTS ? -1 : fixed;
}
