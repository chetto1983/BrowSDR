// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir rust/onair_fec/src/rs.rs and gf.rs (RsCode::<10>, the DAB RS(120,110):
// remainder, syndromes, Berlekamp-Massey, Chien search, Forney, re-check) and core/src/dab/dab_fec.cpp (rsDecode120,
// rsEncode120), https://github.com/adswill/OnAir; see third_party/onair. Changes: only the DAB code (R = 10, n = 120) with
// its keep-input behaviour; the work arrays are allocated once.

const R = 10;
const N = 120;
const K = N - R;

/** GF(2^8), x^8 + x^4 + x^3 + x^2 + 1: exp has the cycle twice so a product of two logs needs no reduction. */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
	let x = 1;
	for (let i = 0; i < 255; i++) {
		EXP[i] = x;
		LOG[x] = i;
		x <<= 1;
		if (x & 0x100) x ^= 0x11d;
	}
	for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

const mul = (a: number, b: number) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
const inv = (a: number) => (a ? EXP[255 - LOG[a]] : 0);

/** ROWS[v * R + j] = v * g_(R-1-j), g(x) = prod_{i<R} (x + alpha^i): the feedback of one byte of the division. */
const ROWS = (() => {
	let p = new Uint8Array(R + 1);
	p[0] = 1;
	for (let i = 0; i < R; i++) {
		const n = new Uint8Array(R + 1);
		for (let j = 0; j <= i; j++) {
			n[j + 1] ^= p[j];
			n[j] ^= mul(p[j], EXP[i]);
		}
		p = n;
	}
	const rows = new Uint8Array(256 * R);
	for (let v = 0; v < 256; v++) for (let j = 0; j < R; j++) rows[v * R + j] = mul(v, p[R - 1 - j]);
	return rows;
})();

const work = new Uint8Array(N + R);
const copy = new Uint8Array(N);
const rem = new Uint8Array(R);
const syn = new Uint8Array(R);
const c = new Uint8Array(R + 1);
const bb = new Uint8Array(R + 1);
const t = new Uint8Array(R + 1);
const om = new Uint8Array(R);
const pos = new Int32Array(R);

/** Remainder of the word (first byte = highest power) modulo g(x), into `rem`. */
function remainder(w: Uint8Array): void {
	work.set(w.subarray(0, N));
	for (let i = 0; i < K; i++) {
		const fb = work[i];
		if (!fb) continue;
		const row = fb * R;
		for (let j = 0; j < R; j++) work[i + 1 + j] ^= ROWS[row + j];
	}
	for (let j = 0; j < R; j++) rem[j] = work[K + j];
}

/** True when the word has a non-zero remainder; `syn` receives S_i = rem(alpha^i). */
function syndromes(w: Uint8Array): boolean {
	remainder(w);
	let any = 0;
	for (let j = 0; j < R; j++) any |= rem[j];
	if (!any) return false;
	for (let i = 0; i < R; i++) {
		let a = 0;
		for (let j = 0; j < R; j++) a = mul(a, EXP[i]) ^ rem[j];
		syn[i] = a;
	}
	return true;
}

/** Berlekamp-Massey over `syn`: the error locator in `c`, its degree returned. */
function berlekampMassey(): number {
	c.fill(0);
	bb.fill(0);
	c[0] = 1;
	bb[0] = 1;
	let l = 0,
		m = 1,
		b = 1;
	for (let i = 0; i < R; i++) {
		let d = syn[i];
		for (let j = 1; j <= l; j++) d ^= mul(c[j], syn[i - j]);
		if (d === 0) {
			m++;
			continue;
		}
		t.set(c);
		const coef = mul(d, inv(b));
		for (let j = 0; j + m <= R; j++) c[j + m] ^= mul(coef, bb[j]);
		if (2 * l <= i) {
			l = i + 1 - l;
			bb.set(t);
			b = d;
			m = 1;
		} else m++;
	}
	return l;
}

/** Chien search: the powers p with C(alpha^-p) = 0 (byte n-1-p) into `pos`; -1 when they are not exactly l. */
function chien(l: number): number {
	let cnt = 0;
	for (let p = 0; p < N; p++) {
		const x = EXP[(255 - p) % 255];
		let v = 0;
		for (let i = l; i >= 0; i--) v = mul(v, x) ^ c[i];
		if (v === 0) {
			if (cnt >= R / 2) return -1;
			pos[cnt++] = p;
		}
	}
	return cnt === l ? cnt : -1;
}

/** Forney: corrects the `cnt` error positions of `w` in place; false when a derivative vanishes. */
function forney(w: Uint8Array, l: number, cnt: number): boolean {
	for (let i = 0; i < R; i++) {
		let a = 0;
		for (let j = 0; j <= Math.min(i, l); j++) a ^= mul(c[j], syn[i - j]);
		om[i] = a;
	}
	for (let k = 0; k < cnt; k++) {
		const p = pos[k];
		const xp = EXP[p % 255];
		const xi = EXP[(255 - p) % 255];
		let num = 0;
		for (let i = R - 1; i >= 0; i--) num = mul(num, xi) ^ om[i];
		let den = 0;
		for (let i = 1; i <= l; i += 2) den ^= mul(c[i], EXP[((255 - p) * (i - 1)) % 255]);
		if (den === 0) return false;
		w[N - 1 - p] ^= mul(mul(num, xp), inv(den));
	}
	return true;
}

/**
 * Reed-Solomon (120,110) of DAB+ (EN 300 401 clause 5.3.3: shortened from RS(255,245), roots alpha^0..alpha^9), in place.
 * Returns the number of corrected bytes (0 for a clean word) or -1 when the word is beyond repair (then left untouched).
 */
export function rsDecode120(word: Uint8Array): number {
	copy.set(word.subarray(0, N));
	if (!syndromes(copy)) return 0;
	const l = berlekampMassey();
	if (l > R / 2) return -1;
	const cnt = chien(l);
	if (cnt < 0 || !forney(copy, l, cnt)) return -1;
	if (syndromes(copy)) return -1;
	word.set(copy);
	return cnt;
}

/** Systematic encoder: `out` (120 bytes) gets the 110 data bytes followed by the 10 parity bytes. */
export function rsEncode120(data: Uint8Array, out: Uint8Array): void {
	work.fill(0);
	work.set(data.subarray(0, K));
	for (let i = 0; i < K; i++) {
		const fb = work[i];
		if (!fb) continue;
		const row = fb * R;
		for (let j = 0; j < R; j++) work[i + 1 + j] ^= ROWS[row + j];
	}
	out.set(data.subarray(0, K));
	out.set(work.subarray(K, N), K);
}
