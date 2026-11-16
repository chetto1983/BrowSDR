// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/mesh/mesh_crypto_ed25519.cpp (Ed25519 per RFC 8032 5.1: field
// elements of 16 limbs of 16 bits, the curve constants derived at start, point decoding, scalar multiplication, signing
// and verification), mesh_crypto.cpp (SHA-512 per FIPS 180-4) and mesh_crypto_tables.cpp (SHA-512 constants),
// https://github.com/adswill/OnAir; see third_party/onair. As credited there: the Ed25519 reference algorithms (RFC 8032,
// S. Josefsson, I. Liusvaara) and the TweetNaCl-style field arithmetic (D. J. Bernstein, T. Lange, P. Schwabe and others),
// public domain. Changes: limbs in Float64Arrays (exact below 2^53) with floor division for the carries; SHA-512 on BigInt.
// Variable-time: only for public data (MeshCore advert signatures) and test keys.

import type { Fe, EdConsts as Consts, EdPoint as Point } from './types';

const M64 = (1n << 64n) - 1n;
const SHA512_K = (
	'428a2f98d728ae22 7137449123ef65cd b5c0fbcfec4d3b2f e9b5dba58189dbbc 3956c25bf348b538 59f111f1b605d019 923f82a4af194f9b ' +
	'ab1c5ed5da6d8118 d807aa98a3030242 12835b0145706fbe 243185be4ee4b28c 550c7dc3d5ffb4e2 72be5d74f27b896f 80deb1fe3b1696b1 ' +
	'9bdc06a725c71235 c19bf174cf692694 e49b69c19ef14ad2 efbe4786384f25e3 0fc19dc68b8cd5b5 240ca1cc77ac9c65 2de92c6f592b0275 ' +
	'4a7484aa6ea6e483 5cb0a9dcbd41fbd4 76f988da831153b5 983e5152ee66dfab a831c66d2db43210 b00327c898fb213f bf597fc7beef0ee4 ' +
	'c6e00bf33da88fc2 d5a79147930aa725 06ca6351e003826f 142929670a0e6e70 27b70a8546d22ffc 2e1b21385c26c926 4d2c6dfc5ac42aed ' +
	'53380d139d95b3df 650a73548baf63de 766a0abb3c77b2a8 81c2c92e47edaee6 92722c851482353b a2bfe8a14cf10364 a81a664bbc423001 ' +
	'c24b8b70d0f89791 c76c51a30654be30 d192e819d6ef5218 d69906245565a910 f40e35855771202a 106aa07032bbd1b8 19a4c116b8d2d0c8 ' +
	'1e376c085141ab53 2748774cdf8eeb99 34b0bcb5e19b48a8 391c0cb3c5c95a63 4ed8aa4ae3418acb 5b9cca4f7763e373 682e6ff3d6b2b8a3 ' +
	'748f82ee5defb2fc 78a5636f43172f60 84c87814a1f0ab72 8cc702081a6439ec 90befffa23631e28 a4506cebde82bde9 bef9a3f7b2c67915 ' +
	'c67178f2e372532b ca273eceea26619c d186b8c721c0c207 eada7dd6cde0eb1e f57d4f7fee6ed178 06f067aa72176fba 0a637dc5a2c898a6 ' +
	'113f9804bef90dae 1b710b35131c471b 28db77f523047d84 32caab7b40c72493 3c9ebe0a15c9bebc 431d67c49c100d4c 4cc5d4becb3e42b6 ' +
	'597f299cfc657e2a 5fcb6fab3ad6faec 6c44198c4a475817'
)
	.split(' ')
	.map((h) => BigInt('0x' + h));
const SHA512_H0 =
	'6a09e667f3bcc908 bb67ae8584caa73b 3c6ef372fe94f82b a54ff53a5f1d36f1 510e527fade682d1 9b05688c2b3e6c1f 1f83d9abfb41bd6b 5be0cd19137e2179'
		.split(' ')
		.map((h) => BigInt('0x' + h));

const rotr = (x: bigint, s: bigint): bigint => ((x >> s) | (x << (64n - s))) & M64;

/** SHA-512 (FIPS 180-4 6.4), one shot. */
export function sha512(p: Uint8Array): Uint8Array {
	const len = Math.ceil((p.length + 17) / 128) * 128;
	const m = new Uint8Array(len);
	m.set(p);
	m[p.length] = 0x80;
	const bits = BigInt(p.length) * 8n;
	for (let i = 0; i < 8; i++) m[len - 1 - i] = Number((bits >> BigInt(8 * i)) & 0xffn);
	const h = SHA512_H0.slice();
	const w: bigint[] = new Array<bigint>(80);
	for (let o = 0; o < len; o += 128) {
		for (let i = 0; i < 16; i++) {
			let v = 0n;
			for (let k = 0; k < 8; k++) v = (v << 8n) | BigInt(m[o + 8 * i + k]);
			w[i] = v;
		}
		for (let i = 16; i < 80; i++) {
			const s0 = rotr(w[i - 15], 1n) ^ rotr(w[i - 15], 8n) ^ (w[i - 15] >> 7n);
			const s1 = rotr(w[i - 2], 19n) ^ rotr(w[i - 2], 61n) ^ (w[i - 2] >> 6n);
			w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & M64;
		}
		let [a, b, c, d, e, f, g, hh] = h;
		for (let i = 0; i < 80; i++) {
			const S1 = rotr(e, 14n) ^ rotr(e, 18n) ^ rotr(e, 41n);
			const ch = (e & f) ^ (~e & M64 & g);
			const t1 = (hh + S1 + ch + SHA512_K[i] + w[i]) & M64;
			const S0 = rotr(a, 28n) ^ rotr(a, 34n) ^ rotr(a, 39n);
			const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) & M64;
			hh = g;
			g = f;
			f = e;
			e = (d + t1) & M64;
			d = c;
			c = b;
			b = a;
			a = (t1 + t2) & M64;
		}
		[a, b, c, d, e, f, g, hh].forEach((v, i) => (h[i] = (h[i] + v) & M64));
	}
	const out = new Uint8Array(64);
	for (let i = 0; i < 8; i++) for (let k = 0; k < 8; k++) out[8 * i + k] = Number((h[i] >> BigInt(56 - 8 * k)) & 0xffn);
	return out;
}

const fe = (v = 0): Fe => {
	const o = new Float64Array(16);
	o[0] = v;
	return o;
};

/** Carry: 2^256 = 38 (mod 2^255 - 19). */
function fcar(o: Fe): void {
	for (let i = 0; i < 16; i++) {
		const c = Math.floor(o[i] / 65536);
		o[i] -= c * 65536;
		if (i < 15) o[i + 1] += c;
		else o[0] += 38 * c;
	}
}
function fadd(o: Fe, a: Fe, b: Fe): void {
	for (let i = 0; i < 16; i++) o[i] = a[i] + b[i];
}
function fsub(o: Fe, a: Fe, b: Fe): void {
	for (let i = 0; i < 16; i++) o[i] = a[i] - b[i];
}
const ft = new Float64Array(31);
function fmul(o: Fe, a: Fe, b: Fe): void {
	ft.fill(0);
	for (let i = 0; i < 16; i++) for (let j = 0; j < 16; j++) ft[i + j] += a[i] * b[j];
	for (let i = 0; i < 15; i++) ft[i] += 38 * ft[i + 16];
	for (let i = 0; i < 16; i++) o[i] = ft[i];
	fcar(o);
	fcar(o);
}
const fsq = (o: Fe, a: Fe): void => fmul(o, a, a);

function fpack(out: Uint8Array, a: Fe): void {
	const t = Float64Array.from(a),
		m = fe();
	fcar(t);
	fcar(t);
	fcar(t);
	for (let pass = 0; pass < 2; pass++) {
		// subtract p = 2^255 - 19 while the value is >= p
		m[0] = t[0] - 0xffed;
		for (let i = 1; i < 15; i++) {
			m[i] = t[i] - 0xffff - ((m[i - 1] >> 16) & 1);
			m[i - 1] &= 0xffff;
		}
		m[15] = t[15] - 0x7fff - ((m[14] >> 16) & 1);
		const borrow = (m[15] >> 16) & 1;
		m[14] &= 0xffff;
		m[15] &= 0xffff;
		if (!borrow) t.set(m);
	}
	for (let i = 0; i < 16; i++) {
		out[2 * i] = t[i] & 0xff;
		out[2 * i + 1] = t[i] >> 8;
	}
}
function funpack(o: Fe, b: Uint8Array): void {
	for (let i = 0; i < 16; i++) o[i] = b[2 * i] + (b[2 * i + 1] << 8);
	o[15] = o[15] & 0x7fff;
}
function fequal(a: Fe, b: Fe): boolean {
	const x = new Uint8Array(32),
		y = new Uint8Array(32);
	fpack(x, a);
	fpack(y, b);
	return x.every((v, i) => v === y[i]);
}
function fparity(a: Fe): number {
	const x = new Uint8Array(32);
	fpack(x, a);
	return x[0] & 1;
}
/** a^(p-2) */
function finv(o: Fe, a: Fe): void {
	const c = Float64Array.from(a);
	for (let i = 253; i >= 0; i--) {
		fsq(c, c);
		if (i !== 2 && i !== 4) fmul(c, c, a);
	}
	o.set(c);
}
/** a^((p-5)/8) */
function fpow2523(o: Fe, a: Fe): void {
	const c = Float64Array.from(a);
	for (let i = 250; i >= 0; i--) {
		fsq(c, c);
		if (i !== 1) fmul(c, c, a);
	}
	o.set(c);
}

const point = (): Point => ({ x: fe(), y: fe(1), z: fe(1), t: fe() });

const scratch = Array.from({ length: 10 }, () => fe());
/** r = p + q (r must not be p or q). */
function padd(r: Point, p: Point, q: Point, d2: Fe): void {
	const [a, b, c, d, e, f, g, h, t1, t2] = scratch;
	fsub(t1, p.y, p.x);
	fsub(t2, q.y, q.x);
	fmul(a, t1, t2);
	fadd(t1, p.y, p.x);
	fadd(t2, q.y, q.x);
	fmul(b, t1, t2);
	fmul(t1, p.t, q.t);
	fmul(c, t1, d2);
	fmul(t1, p.z, q.z);
	fadd(d, t1, t1);
	fsub(e, b, a);
	fsub(f, d, c);
	fadd(g, d, c);
	fadd(h, b, a);
	fmul(r.x, e, f);
	fmul(r.y, h, g);
	fmul(r.z, g, f);
	fmul(r.t, e, h);
}

function pencode(out: Uint8Array, p: Point): void {
	const zi = fe(),
		x = fe(),
		y = fe();
	finv(zi, p.z);
	fmul(x, p.x, zi);
	fmul(y, p.y, zi);
	fpack(out, y);
	out[31] ^= fparity(x) << 7;
}

/** False: not a point on the curve. */
function pdecode(r: Point, input: Uint8Array, k: Omit<Consts, 'base'>): boolean {
	const [y, u, v, v3, x, t, chk] = Array.from({ length: 7 }, () => fe());
	const one = fe(1);
	const buf = Uint8Array.from(input);
	const sign = buf[31] >> 7;
	buf[31] &= 0x7f;
	funpack(y, buf);
	fsq(u, y);
	fmul(v, u, k.dd);
	fadd(v, v, one); // d y^2 + 1
	fsub(u, u, one); // y^2 - 1
	fsq(v3, v);
	fmul(v3, v3, v);
	fsq(t, v3);
	fmul(t, t, v);
	fmul(t, t, u);
	fpow2523(t, t);
	fmul(x, t, v3);
	fmul(x, x, u); // x = u v^3 (u v^7)^((p-5)/8)
	fsq(chk, x);
	fmul(chk, chk, v);
	if (!fequal(chk, u)) {
		fmul(x, x, k.sqrtm1);
		fsq(chk, x);
		fmul(chk, chk, v);
		if (!fequal(chk, u)) return false;
	}
	if (fparity(x) !== sign) fsub(x, fe(), x);
	r.x.set(x);
	r.y.set(y);
	r.z.set(fe(1));
	fmul(r.t, x, y);
	// x = 0 with the sign bit set is not a valid encoding
	return !(fequal(x, fe()) && sign);
}

let constants: Consts | undefined;
function consts(): Consts {
	if (constants) return constants;
	const a = fe(121665),
		b = fe(121666),
		t = fe();
	finv(b, b);
	fmul(t, a, b);
	const dd = fe();
	fsub(dd, fe(), t); // d = -121665/121666
	const d2 = fe();
	fadd(d2, dd, dd);
	const sqrtm1 = fe();
	fpow2523(t, fe(2));
	fsq(t, t);
	fmul(sqrtm1, t, fe(2)); // 2^((p-1)/4)
	// base point: y = 4/5, x even (RFC 8032 5.1)
	const enc = new Uint8Array(32).fill(0x66);
	enc[0] = 0x58;
	const base = point();
	pdecode(base, enc, { d2, sqrtm1, dd });
	constants = { d2, sqrtm1, dd, base };
	return constants;
}

/** r = s p, s little-endian bits. */
function pmul(r: Point, p: Point, s: Uint8Array, d2: Fe): void {
	let acc: Point = { x: fe(), y: fe(1), z: fe(1), t: fe() };
	let tmp = point();
	for (let i = 255; i >= 0; i--) {
		padd(tmp, acc, acc, d2);
		[acc, tmp] = [tmp, acc];
		if ((s[i >> 3] >> (i & 7)) & 1) {
			padd(tmp, acc, p, d2);
			[acc, tmp] = [tmp, acc];
		}
	}
	r.x.set(acc.x);
	r.y.set(acc.y);
	r.z.set(acc.z);
	r.t.set(acc.t);
}

/** Group order L, little-endian. */
const L = Uint8Array.from([
	0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	0, 0x10,
]);
function geL(r: Uint8Array): boolean {
	for (let i = 31; i >= 0; i--) if (r[i] !== L[i]) return r[i] > L[i];
	return true;
}
function subL(r: Uint8Array): void {
	let borrow = 0;
	for (let i = 0; i < 32; i++) {
		const v = r[i] - L[i] - borrow;
		r[i] = v & 0xff;
		borrow = v < 0 ? 1 : 0;
	}
}
/** A 64-byte little-endian number mod L, bit by bit. */
function reduceL(input: Uint8Array): Uint8Array {
	const r = new Uint8Array(32);
	for (let i = 511; i >= 0; i--) {
		let carry = (input[i >> 3] >> (i & 7)) & 1;
		for (let k = 0; k < 32; k++) {
			const v = (r[k] << 1) | carry;
			r[k] = v & 0xff;
			carry = v >> 8;
		}
		if (geL(r)) subL(r);
	}
	return r;
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
};

/** The 64 byte private key of orlp/ed25519 (MeshCore's identity): SHA-512 of the seed, first half clamped. */
export function ed25519ExpandSeed(seed: Uint8Array): Uint8Array {
	const prv = sha512(seed);
	prv[0] &= 248;
	prv[31] &= 127;
	prv[31] |= 64;
	return prv;
}

/** The public key: the first half of the private key times the base point (taken as stored). */
export function ed25519PublicFromPrivate(prv: Uint8Array): Uint8Array {
	const k = consts();
	const p = point();
	pmul(p, k.base, prv.subarray(0, 32), k.d2);
	const pub = new Uint8Array(32);
	pencode(pub, p);
	return pub;
}

export function ed25519Sign(seed: Uint8Array, msg: Uint8Array): Uint8Array {
	const k = consts();
	const prv = ed25519ExpandSeed(seed);
	const pub = ed25519PublicFromPrivate(prv);
	const r = reduceL(sha512(concat(prv.subarray(32), msg)));
	const pr = point();
	pmul(pr, k.base, r, k.d2);
	const sig = new Uint8Array(64);
	pencode(sig, pr);
	const kr = reduceL(sha512(concat(sig.subarray(0, 32), pub, msg)));
	// S = (r + kr a) mod L: schoolbook product, then reduce
	const acc = new Float64Array(64);
	for (let i = 0; i < 32; i++) for (let j = 0; j < 32; j++) acc[i + j] += kr[i] * prv[j];
	for (let i = 0; i < 32; i++) acc[i] += r[i];
	const prod = new Uint8Array(64);
	let carry = 0;
	for (let i = 0; i < 64; i++) {
		const v = acc[i] + carry;
		prod[i] = v % 256;
		carry = Math.floor(v / 256);
	}
	sig.set(reduceL(prod), 32);
	return sig;
}

export function ed25519Verify(sig: Uint8Array, msg: Uint8Array, pub: Uint8Array): boolean {
	const k = consts();
	if (sig.length !== 64 || pub.length !== 32 || geL(sig.subarray(32))) return false; // S must be < L
	const pa = point();
	if (!pdecode(pa, pub, k)) return false;
	fsub(pa.x, fe(), pa.x); // -A
	fsub(pa.t, fe(), pa.t);
	const kr = reduceL(sha512(concat(sig.subarray(0, 32), pub, msg)));
	const sb = point(),
		ha = point(),
		sum = point();
	pmul(sb, k.base, sig.subarray(32), k.d2);
	pmul(ha, pa, kr, k.d2);
	padd(sum, sb, ha, k.d2);
	const enc = new Uint8Array(32);
	pencode(enc, sum);
	return enc.every((v, i) => v === sig[i]);
}
