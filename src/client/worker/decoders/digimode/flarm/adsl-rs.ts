// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/adsl/adsl_proto.cpp (Gf, rsGenerator, rsEncode, rsDecode),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: the field tables are module constants.

/** Reed-Solomon parity bytes of ADS-L. */
export const RS_PARITY = 32;

/** GF(256) with the polynomial 0x11D; primitive element 11, first root 121 (adsl_proto.h). */
const EXP = new Uint8Array(512);
const LOG = new Int16Array(256);
{
	let x = 1;
	for (let i = 0; i < 255; i++) {
		EXP[i] = x;
		LOG[x] = i;
		x <<= 1;
		if (x & 0x100) x ^= 0x11d;
	}
	for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
	LOG[0] = -1;
}
const mul = (a: number, b: number): number => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
const div = (a: number, b: number): number => (a ? EXP[LOG[a] + 255 - LOG[b]] : 0);
const root = (i: number): number => EXP[(11 * (121 + i)) % 255];

/** Highest degree first, the leading 1 implied: g[0] is the x^31 coefficient. */
const GENERATOR = ((): Uint8Array => {
	const p = new Uint8Array(RS_PARITY + 1);
	p[0] = 1;
	for (let i = 0; i < RS_PARITY; i++) {
		const r = root(i);
		for (let j = i + 1; j > 0; j--) p[j] = p[j - 1] ^ mul(p[j], r);
		p[0] = mul(p[0], r);
	}
	return Uint8Array.from({ length: RS_PARITY }, (_, i) => p[RS_PARITY - 1 - i]);
})();

/** Parity of a block; a short block counts as padded with leading zeros to 223 bytes. */
export function rsEncode(data: ArrayLike<number>, n = data.length): Uint8Array {
	const parity = new Uint8Array(RS_PARITY);
	for (let i = 0; i < n; i++) {
		const fb = data[i] ^ parity[0];
		parity.copyWithin(0, 1);
		parity[RS_PARITY - 1] = 0;
		if (fb) for (let j = 0; j < RS_PARITY; j++) parity[j] ^= mul(fb, GENERATOR[j]);
	}
	return parity;
}

function syndromes(block: Uint8Array, n: number): Uint8Array {
	const s = new Uint8Array(RS_PARITY);
	for (let i = 0; i < RS_PARITY; i++) {
		const r = root(i);
		let v = 0;
		for (let j = 0; j < n; j++) v = mul(v, r) ^ block[j];
		s[i] = v;
	}
	return s;
}

/** Berlekamp-Massey: the error locator (lowest degree first) and its degree. */
function locator(s: Uint8Array): { lam: Uint8Array; L: number } {
	const lam = new Uint8Array(RS_PARITY + 2);
	let b = new Uint8Array(RS_PARITY + 2);
	lam[0] = b[0] = 1;
	let L = 0;
	let m = 1;
	let bb = 1;
	for (let k = 0; k < RS_PARITY; k++) {
		let d = s[k];
		for (let i = 1; i <= L; i++) d ^= mul(lam[i], s[k - i]);
		if (!d) {
			m++;
			continue;
		}
		const t = lam.slice();
		const c = div(d, bb);
		for (let i = 0; i + m < RS_PARITY + 2; i++) lam[i + m] ^= mul(c, b[i]);
		if (2 * L <= k) {
			L = k + 1 - L;
			b = t;
			bb = d;
			m = 1;
		} else m++;
	}
	return { lam, L };
}

/** Corrects a block of data and 32 parity bytes in place; the bytes fixed, or -1. */
export function rsDecode(block: Uint8Array, n = block.length): number {
	if (n < RS_PARITY + 1 || n > 255) return -1;
	const s = syndromes(block, n);
	if (s.every((v) => !v)) return 0;
	const { lam, L } = locator(s);
	if (L > RS_PARITY / 2) return -1;
	// the evaluator Omega = S * Lambda mod x^32; a position j from the end has the locator X = alpha^(11 j)
	const om = new Uint8Array(RS_PARITY);
	for (let i = 0; i < RS_PARITY; i++) for (let j = 0; j <= Math.min(i, L); j++) om[i] ^= mul(lam[j], s[i - j]);
	let found = 0;
	for (let p = 0; p < n; p++) {
		const xLog = (11 * (n - 1 - p)) % 255;
		const xInv = EXP[(255 - xLog) % 255];
		let v = 0;
		let pw = 1;
		let dv = 0;
		for (let i = 0; i <= L; i++) {
			v ^= mul(lam[i], pw);
			if (i & 1) dv ^= mul(lam[i], pw);
			pw = mul(pw, xInv);
		}
		if (v) continue;
		let ov = 0;
		pw = 1;
		for (let i = 0; i < RS_PARITY; i++) {
			ov ^= mul(om[i], pw);
			pw = mul(pw, xInv);
		}
		if (!dv) return -1;
		// Forney with first root 121: e = X^(-121) Omega(X^-1) / (X^-1 Lambda'(X^-1))
		block[p] ^= mul(EXP[((255 - xLog) * 121) % 255], div(ov, dv));
		found++;
	}
	if (found !== L) return -1;
	return syndromes(block, n).every((v) => !v) ? found : -1;
}
