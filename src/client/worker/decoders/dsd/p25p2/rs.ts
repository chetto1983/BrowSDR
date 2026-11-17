// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir rust/onair_p25/src/gf.rs (tables, mul, div, pw), rust/onair_p25/src/rs.rs
// (encode, decode) and core/src/p25p2/p25p2_proto.cpp (Gf64, rs63Decode, crc12), https://github.com/adswill/OnAir;
// see third_party/onair.
// Changes: none in the arithmetic; the decoders return the number of corrected symbols (-1: not decodable) instead of a
// flag and an out parameter.

/** GF(64) of x^6 + x + 1: exp doubled to 128 entries, log. */
const EXP = new Uint8Array(128);
const LOG = new Uint8Array(64);
{
	let x = 1;
	for (let i = 0; i < 63; i++) {
		EXP[i] = x;
		LOG[x] = i;
		x <<= 1;
		if (x & 64) x ^= 0x43;
	}
	for (let i = 63; i < 128; i++) EXP[i] = EXP[i - 63];
}

export function gfMul(a: number, b: number): number {
	return a && b ? EXP[LOG[a & 63] + LOG[b & 63]] : 0;
}

function gfDiv(a: number, b: number): number {
	return a ? EXP[(LOG[a & 63] + 63 - LOG[b & 63]) % 63] : 0;
}

function gfInv(a: number): number {
	return EXP[63 - LOG[a & 63]];
}

/** alpha to the power i (any sign, modulo 63). */
function pw(i: number): number {
	return EXP[((i % 63) + 63) % 63];
}

/**
 * Reed-Solomon over GF(64) shortened from (63, ...), as the P25 header, link control and encryption sync use it: sym[0] is
 * the first hexbit sent, the data first, then n - k parity symbols. Fills sym[k..n) with the parity of sym[0..k).
 */
export function rsEncode(sym: Uint8Array, n: number, k: number): void {
	const np = n - k;
	const gp = new Uint8Array(np + 1);
	gp[0] = 1;
	for (let i = 1; i <= np; i++) {
		const a = pw(i);
		for (let j = i; j >= 1; j--) gp[j] ^= gfMul(gp[j - 1], a);
	}
	const r = new Uint8Array(n);
	for (let i = 0; i < k; i++) r[i] = sym[i] & 63;
	for (let i = 0; i < k; i++) {
		const c = r[i];
		if (c) for (let j = 1; j <= np; j++) r[i + j] ^= gfMul(c, gp[j]);
	}
	sym.set(r.subarray(k, n), k);
}

function syndromes(sym: Uint8Array, n: number, np: number): Uint8Array | null {
	const s = new Uint8Array(np);
	let any = false;
	for (let i = 1; i <= np; i++) {
		let v = 0;
		for (let t = 0; t < n; t++) if (sym[t] & 63) v ^= gfMul(sym[t] & 63, pw(i * (n - 1 - t)));
		s[i - 1] = v;
		any = any || v !== 0;
	}
	return any ? s : null;
}

/** Berlekamp-Massey: the error locator and its degree, or null when there are too many errors. */
function locator(s: Uint8Array, np: number): { c: Uint8Array; l: number } | null {
	const c = new Uint8Array(np + 1);
	let b = new Uint8Array(np + 1);
	c[0] = 1;
	b[0] = 1;
	let l = 0;
	let m = 1;
	let bb = 1;
	for (let r = 0; r < np; r++) {
		let d = s[r];
		for (let i = 1; i <= l; i++) d ^= gfMul(c[i], s[r - i]);
		if (d === 0) {
			m++;
			continue;
		}
		const t = c.slice();
		const coef = gfDiv(d, bb);
		for (let i = 0; i + m <= np; i++) c[i + m] ^= gfMul(coef, b[i]);
		if (2 * l <= r) {
			l = r + 1 - l;
			b = t;
			bb = d;
			m = 1;
		} else m++;
	}
	return 2 * l > np ? null : { c, l };
}

/** Decodes and corrects sym[0..n) in place: the number of errors corrected, -1 when it is not a codeword after correction. */
export function rsDecode(sym: Uint8Array, n: number, k: number): number {
	const np = n - k;
	const s = syndromes(sym, n, np);
	if (!s) return 0;
	const loc = locator(s, np);
	if (!loc) return -1;
	const { c, l } = loc;
	// Chien search over the n positions (power j = n - 1 - t)
	const pos: number[] = [];
	for (let j = 0; j < n; j++) {
		let v = 0;
		for (let i = 0; i <= l; i++) v ^= gfMul(c[i], pw(-j * i));
		if (v === 0) pos.push(j);
	}
	if (pos.length !== l) return -1;
	// Forney (first root alpha^1): e = Omega(X^-1) / Lambda'(X^-1)
	const om = new Uint8Array(np);
	for (let i = 0; i < np; i++) for (let j = 0; j <= Math.min(i, l); j++) om[i] ^= gfMul(c[j], s[i - j]);
	for (const j of pos) {
		let o = 0;
		let dl = 0;
		for (let i = 0; i < np; i++) o ^= gfMul(om[i], pw(-j * i));
		for (let i = 1; i <= l; i += 2) dl ^= gfMul(c[i], pw(-j * (i - 1)));
		if (dl === 0) return -1;
		const at = n - 1 - j;
		sym[at] = (sym[at] ^ gfDiv(o, dl)) & 63;
	}
	return syndromes(sym, n, np) ? -1 : l;
}

/** Number of roots of the MAC PDU code (alpha^1 .. alpha^28). */
const ROOTS = 28;

/** r(alpha^(j+1)) for j < ROOTS, r[0] the highest power. */
function syndromes63(r: Uint8Array): { s: Uint8Array; any: boolean } {
	const s = new Uint8Array(ROOTS);
	let any = false;
	for (let j = 0; j < ROOTS; j++) {
		let acc = 0;
		const a = EXP[j + 1];
		for (let i = 0; i < 63; i++) acc = gfMul(acc, a) ^ r[i];
		s[j] = acc;
		any = any || acc !== 0;
	}
	return { s, any };
}

/** Error and erasure locator (Berlekamp-Massey started from the erasure locator): lambda and its degree, or null. */
function locator63(s: Uint8Array, erasures: readonly number[]): { lam: Uint8Array; deg: number } | null {
	const ne = erasures.length;
	let lam = new Uint8Array(ROOTS + 2);
	let b = new Uint8Array(ROOTS + 2);
	lam[0] = 1;
	for (const e of erasures) {
		const x = EXP[62 - e];
		for (let i = ROOTS; i >= 1; i--) lam[i] ^= gfMul(lam[i - 1], x);
	}
	b.set(lam);
	let el = ne;
	const shiftB = () => {
		b.copyWithin(1, 0, ROOTS);
		b[0] = 0;
	};
	for (let rr = ne + 1; rr <= ROOTS; rr++) {
		let d = 0;
		for (let i = 0; i < rr; i++) d ^= gfMul(lam[i], s[rr - i - 1]);
		if (!d) {
			shiftB();
			continue;
		}
		const t = new Uint8Array(ROOTS + 2);
		t[0] = lam[0];
		for (let i = 0; i < ROOTS + 1; i++) t[i + 1] = lam[i + 1] ^ gfMul(d, b[i]);
		if (2 * el <= rr + ne - 1) {
			el = rr + ne - el;
			const di = gfInv(d);
			const nb = new Uint8Array(ROOTS + 2);
			for (let i = 0; i <= ROOTS; i++) nb[i] = gfMul(lam[i], di);
			nb[ROOTS + 1] = b[ROOTS + 1];
			b = nb;
		} else shiftB();
		lam = t;
	}
	let deg = 0;
	for (let i = 0; i <= ROOTS; i++) if (lam[i]) deg = i;
	return deg !== el || deg > ROOTS ? null : { lam, deg };
}

/**
 * Reed-Solomon (63,35) decode with erasures (the MAC PDU code): sym[0] is the highest power; the erased positions are
 * given (their contents are ignored). Returns the symbols corrected that were not erased, -1 when it cannot be decoded.
 */
export function rs63Decode(sym: Uint8Array, erasures: readonly number[]): number {
	const r = new Uint8Array(63);
	for (let i = 0; i < 63; i++) r[i] = sym[i] & 63;
	for (const e of erasures) r[e] = 0;
	const { s, any } = syndromes63(r);
	if (!any) {
		sym.set(r);
		return 0;
	}
	if (erasures.length > ROOTS) return -1;
	const loc = locator63(s, erasures);
	if (!loc) return -1;
	const { lam, deg } = loc;
	// evaluator omega = S * lambda mod x^ROOTS
	const om = new Uint8Array(ROOTS);
	for (let i = 0; i < ROOTS; i++) for (let j = 0; j <= i && j <= deg; j++) om[i] ^= gfMul(lam[j], s[i - j]);
	let found = 0;
	let corrected = 0;
	for (let pos = 0; pos < 63; pos++) {
		const xi = EXP[(pos + 1) % 63]; // X^-1 for X = alpha^(62 - pos)
		let v = 0;
		let xp = 1;
		for (let i = 0; i <= deg; i++) {
			v ^= gfMul(lam[i], xp);
			xp = gfMul(xp, xi);
		}
		if (v) continue;
		found++;
		let num = 0;
		let p1 = 1;
		for (let i = 0; i < ROOTS; i++) {
			num ^= gfMul(om[i], p1);
			p1 = gfMul(p1, xi);
		}
		let den = 0;
		let p2 = 1;
		const xi2 = gfMul(xi, xi);
		for (let i = 1; i <= deg; i += 2) {
			den ^= gfMul(lam[i], p2);
			p2 = gfMul(p2, xi2);
		}
		if (!den) return -1;
		r[pos] ^= gfMul(num, gfInv(den));
		if (!erasures.includes(pos)) corrected++;
	}
	if (found !== deg || syndromes63(r).any) return -1;
	sym.set(r);
	return corrected;
}

const CRC12_POLY = [1, 1, 0, 0, 0, 1, 0, 0, 1, 0, 1, 1, 1];

/** CRC-12 x^12 + x^11 + x^7 + x^4 + x^2 + x + 1: remainder of the bits followed by 12 zeros, complemented. */
export function crc12(bits: ArrayLike<number>, n: number): number {
	const buf = new Uint8Array(n + 13);
	for (let i = 0; i < n; i++) buf[i] = bits[i] & 1;
	for (let i = 0; i < n; i++) if (buf[i]) for (let j = 0; j < 13; j++) buf[i + j] ^= CRC12_POLY[j];
	let crc = 0;
	for (let i = 0; i < 12; i++) crc = (crc << 1) | buf[n + i];
	return crc ^ 0xfff;
}
