// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/hfdig/hfdig_wspr.cpp (nhash, wsprPack, wsprUnpack,
// wsprConvEncode, wsprInterleave, wsprDeinterleave, wsprSymbols: the 50-bit WSPR message of types 1, 2 and 3, the K=32
// r=1/2 convolutional code and the bit-reversal interleaver, re-implemented there from the descriptions of WSJT-X's
// wsprsim_utils.c / wsprd_utils.c and JTEncode; lookup3 is Bob Jenkins' public-domain hashlittle()),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: 32-bit unsigned arithmetic with >>> 0; the hash
// table is a Map.

import { WSPR_SYNC } from '@/worker/decoders/digimode/ftx/tables';

export const POLY1 = 0xf2d05351;
export const POLY2 = 0xe4613c47;

const rot = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;

/** Bob Jenkins' lookup3 hashlittle(), as WSJT-X's nhash.c. */
export function nhash(key: Uint8Array, initval: number): number {
	let length = key.length;
	let a = (0xdeadbeef + length + initval) >>> 0;
	let b = a;
	let c = a;
	let k = 0;
	const byte = (i: number): number => key[k + i];
	const word = (i: number): number => (byte(i) | (byte(i + 1) << 8) | (byte(i + 2) << 16) | (byte(i + 3) << 24)) >>> 0;
	while (length > 12) {
		a = (a + word(0)) >>> 0;
		b = (b + word(4)) >>> 0;
		c = (c + word(8)) >>> 0;
		a = ((a - c) ^ rot(c, 4)) >>> 0;
		c = (c + b) >>> 0;
		b = ((b - a) ^ rot(a, 6)) >>> 0;
		a = (a + c) >>> 0;
		c = ((c - b) ^ rot(b, 8)) >>> 0;
		b = (b + a) >>> 0;
		a = ((a - c) ^ rot(c, 16)) >>> 0;
		c = (c + b) >>> 0;
		b = ((b - a) ^ rot(a, 19)) >>> 0;
		a = (a + c) >>> 0;
		c = ((c - b) ^ rot(b, 4)) >>> 0;
		b = (b + a) >>> 0;
		length -= 12;
		k += 12;
	}
	if (length === 0) return c;
	// the last 1 .. 12 bytes, little endian into a, b and c
	const tail = [0, 0, 0];
	for (let i = 0; i < length; i++) tail[i >> 2] += byte(i) * 2 ** (8 * (i & 3));
	a = (a + tail[0]) >>> 0;
	b = (b + tail[1]) >>> 0;
	c = (c + tail[2]) >>> 0;
	c = ((c ^ b) - rot(b, 14)) >>> 0;
	a = ((a ^ c) - rot(c, 11)) >>> 0;
	b = ((b ^ a) - rot(a, 25)) >>> 0;
	c = ((c ^ b) - rot(b, 16)) >>> 0;
	a = ((a ^ c) - rot(c, 4)) >>> 0;
	b = ((b ^ a) - rot(a, 14)) >>> 0;
	c = ((c ^ b) - rot(b, 24)) >>> 0;
	return c;
}

const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const callHash15 = (call: string): number => nhash(ascii(call), 146) & 32767;

/** WSPR's character code: digits 0..9, letters 10..35, space 36. */
function code(c: string | undefined): number {
	if (c === undefined) return -1;
	if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48;
	if (c >= 'A' && c <= 'Z') return c.charCodeAt(0) - 55;
	return c === ' ' ? 36 : -1;
}
const uncode = (v: number): string => (v < 10 ? String.fromCharCode(48 + v) : v < 36 ? String.fromCharCode(55 + v) : ' ');
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';

/** A callsign of up to 6 characters -> 28 bits (-1 if it does not fit). */
function packCall(c: string): number {
	if (!c || c.length > 6) return -1;
	let s: string;
	if (c.length > 2 && isDigit(c[2])) s = c;
	else if (c.length > 1 && isDigit(c[1]) && c.length <= 5) s = ' ' + c;
	else return -1;
	s = s.padEnd(6, ' ');
	const [c0, c1, c2] = [code(s[0]), code(s[1]), code(s[2])];
	if (c0 < 0 || c1 < 0 || c1 === 36 || c2 < 0 || c2 > 9) return -1;
	let n = (c0 * 36 + c1) * 10 + c2;
	for (let k = 3; k < 6; k++) {
		const v = code(s[k]);
		if (v < 10) return -1; // letters or space only
		n = n * 27 + (v - 10);
	}
	return n;
}

function unpackCall(n: number): string {
	if (n >= 262177560) return '';
	const c: string[] = [];
	for (let k = 0; k < 3; k++, n = Math.floor(n / 27)) c.unshift(uncode((n % 27) + 10));
	c.unshift(uncode(n % 10));
	n = Math.floor(n / 10);
	c.unshift(uncode(n % 36));
	c.unshift(uncode(Math.floor(n / 36)));
	return c.join('').trim();
}

const validPower = (p: number): boolean => p >= 0 && p <= 60 && [0, 3, 7].includes(p % 10);

function put50(n: number, m: number, d: Uint8Array): void {
	d[0] = n >>> 20;
	d[1] = (n >>> 12) & 0xff;
	d[2] = (n >>> 4) & 0xff;
	d[3] = ((n & 15) << 4) | ((m >>> 18) & 15);
	d[4] = (m >>> 10) & 0xff;
	d[5] = (m >>> 2) & 0xff;
	d[6] = (m & 3) << 6;
}

/** Type 2: a prefix of 1 .. 3 characters or a suffix of one character or two digits: [base call, ng], null if neither. */
function prefixSuffix(c: string): [string, number] | null {
	const sl = c.indexOf('/');
	if (sl < 0 || c.indexOf('/', sl + 1) >= 0) return null;
	if (sl > 0 && sl <= 3 && c.length - sl - 1 > 2) {
		const pfx = c.slice(0, sl);
		let m = pfx.length === 1 ? 37 * 36 + 36 : pfx.length === 2 ? 36 : 0;
		for (const ch of pfx) {
			const v = code(ch);
			if (v < 0 || v === 36) return null;
			m = 37 * m + v;
		}
		return [c.slice(sl + 1), m];
	}
	const sfx = c.slice(sl + 1);
	if (sfx.length === 1 && code(sfx) >= 0 && code(sfx) < 36) return [c.slice(0, sl), 60000 + code(sfx)];
	if (sfx.length === 2 && isDigit(sfx[0]) && isDigit(sfx[1])) return [c.slice(0, sl), 60000 + 26 + 10 * +sfx[0] + +sfx[1]];
	return null;
}

const isGrid4 = (g: string): boolean =>
	g.length === 4 && g[0] >= 'A' && g[0] <= 'R' && g[1] >= 'A' && g[1] <= 'R' && isDigit(g[2]) && isDigit(g[3]);

/** "K1ABC FN42 37", "PJ4/K1ABC 37" (type 2), "<K1ABC> FN42AX 37" (type 3) -> 50 bits in 7 bytes (MSB first). */
export function wsprPack(msg: string, d: Uint8Array): boolean {
	const t = msg.toUpperCase().split(/\s+/).filter(Boolean);
	if (!t.length || !/^\d+$/.test(t[t.length - 1])) return false;
	const power = Number(t[t.length - 1]);
	if (!validPower(power)) return false;
	if (t.length === 3 && t[0].length > 2 && t[0][0] === '<' && t[0].endsWith('>')) {
		const g = t[1];
		if (g.length !== 6) return false;
		const n = packCall(g.slice(1) + g[0]);
		if (n < 0) return false;
		put50(n, 128 * callHash15(t[0].slice(1, -1)) - (power + 1) + 64, d);
		return true;
	}
	if (t.length === 3) {
		const g = t[1];
		const n = packCall(t[0]);
		if (!isGrid4(g) || n < 0) return false;
		const at = (k: number, base: number) => g.charCodeAt(k) - base;
		const m = (179 - 10 * at(0, 65) - at(2, 48)) * 180 + 10 * at(1, 65) + at(3, 48);
		put50(n, m * 128 + power + 64, d);
		return true;
	}
	if (t.length === 2) {
		const ps = prefixSuffix(t[0]);
		const n = ps ? packCall(ps[0]) : -1;
		if (!ps || n < 0) return false;
		let ng = ps[1];
		let nadd = 1;
		if (ng >= 32768) {
			ng -= 32768;
			nadd = 2;
		}
		put50(n, 128 * ng + power + nadd + 64, d);
		return true;
	}
	return false;
}

/** Type 2 call from its prefix / suffix number n3, '' when invalid. */
function type2Call(call: string, n3: number): string {
	if (n3 < 60000) {
		let v = n3;
		const p = [0, 0, 0].map(() => ' ');
		p[2] = uncode(v % 37);
		v = Math.floor(v / 37);
		p[1] = uncode(v % 37);
		v = Math.floor(v / 37);
		if (v >= 37) return '';
		p[0] = uncode(v);
		const pf = p.join('');
		const tail = pf.slice(pf.lastIndexOf(' ') + 1);
		return tail ? `${tail}/${call}` : '';
	}
	const nc = n3 - 60000;
	if (nc <= 9) return `${call}/${nc}`;
	if (nc <= 35) return `${call}/${String.fromCharCode(55 + nc)}`;
	if (nc <= 125) return `${call}/${Math.floor((nc - 26) / 10)}${(nc - 26) % 10}`;
	return '';
}

const INVALID: [string, number] = ['', -1];

/** Type 1: call, four-character grid, power. */
function unpackType1(call: string, ng: number, ntype: number, table: Map<number, string>): [string, number] {
	if (ng >= 32400) return INVALID;
	const q = 179 - Math.floor(ng / 180);
	const [a, c, bb, dd] = [Math.floor(q / 10), q % 10, Math.floor((ng % 180) / 10), ng % 10];
	if (a < 0 || a > 17 || bb > 17 || call.length > 6 || call.includes(' ')) return INVALID;
	table.set(callHash15(call), call);
	return [`${call} ${String.fromCharCode(65 + a, 65 + bb)}${c}${dd} ${ntype}`, ntype];
}

/** Type 2: a call with a prefix or suffix, power. */
function unpackType2(call: string, ng: number, ntype: number, table: Map<number, string>): [string, number] {
	const nu = ntype % 10;
	const nadd = nu > 7 ? nu - 7 : nu > 3 ? nu - 3 : nu;
	const full = type2Call(call, ng + 32768 * (nadd - 1));
	const p = ntype - nadd;
	if (!full || !validPower(p)) return INVALID;
	table.set(callHash15(full), full);
	return [`${full} ${p}`, p];
}

/** Type 3: the hashed call (shown when heard in a type 1 or 2 message), a six-character grid sent as the "call", rotated. */
function unpackType3(call: string, n2: number, ntype: number, table: Map<number, string>): [string, number] {
	const p = -(ntype + 1);
	if (call.length !== 6 || !validPower(p)) return INVALID;
	const g = call.slice(5) + call.slice(0, 5);
	const letters = (k: number, hi: string) => g[k] >= 'A' && g[k] <= hi;
	if (!letters(0, 'R') || !letters(1, 'R') || !isDigit(g[2]) || !isDigit(g[3]) || !letters(4, 'X') || !letters(5, 'X')) return INVALID;
	const known = table.get((n2 - ntype - 64) / 128);
	return [`<${known ?? '...'}> ${g} ${p}`, p];
}

/** 50 bits -> [text, dBm]; text empty when invalid. Hashes of the type 1 / 2 calls go into table; type 3 shows them. */
export function wsprUnpack(d: Uint8Array, table: Map<number, string>): [string, number] {
	const n1 = ((d[0] << 20) | (d[1] << 12) | (d[2] << 4) | ((d[3] >> 4) & 15)) >>> 0;
	const n2 = (((d[3] & 15) << 18) | (d[4] << 10) | (d[5] << 2) | ((d[6] >> 6) & 3)) >>> 0;
	const call = unpackCall(n1);
	if (!call) return INVALID;
	const ntype = (n2 & 127) - 64;
	const ng = n2 >>> 7;
	if (ntype >= 0 && ntype <= 62)
		return [0, 3, 7].includes(ntype % 10) ? unpackType1(call, ng, ntype, table) : unpackType2(call, ng, ntype, table);
	if (ntype < 0 && ntype !== -64) return unpackType3(call, n2, ntype, table);
	return INVALID;
}

/** Even parity of the bits of a 32-bit word. */
export function parity(x: number): number {
	x ^= x >>> 16;
	x ^= x >>> 8;
	x ^= x >>> 4;
	x ^= x >>> 2;
	x ^= x >>> 1;
	return x & 1;
}

/** 50 data bits and 31 zeros through the K=32 r=1/2 code: 162 coded bits. */
export function wsprConvEncode(d: Uint8Array, out: Uint8Array): void {
	let reg = 0;
	for (let i = 0; i < 81; i++) {
		const bit = i < 50 ? (d[i >> 3] >> (7 - (i & 7))) & 1 : 0;
		reg = ((reg << 1) | bit) >>> 0;
		out[2 * i] = parity(reg & POLY1);
		out[2 * i + 1] = parity(reg & POLY2);
	}
}

const rev8 = (j: number): number => {
	let r = 0;
	for (let k = 0; k < 8; k++) r |= ((j >> k) & 1) << (7 - k);
	return r;
};

/** Coded order -> channel order. */
export function wsprInterleave(input: Uint8Array, out: Uint8Array): void {
	let p = 0;
	for (let j = 0; j < 256 && p < 162; j++) {
		const r = rev8(j);
		if (r < 162) out[r] = input[p++];
	}
}

/** Channel order -> coded order. */
export function wsprDeinterleave(input: ArrayLike<number>, out: Float64Array): void {
	let p = 0;
	for (let j = 0; j < 256 && p < 162; j++) {
		const r = rev8(j);
		if (r < 162) out[p++] = input[r];
	}
}

/** 162 channel symbols (0..3) of a message; null when it cannot be sent. */
export function wsprSymbols(msg: string): number[] | null {
	const d = new Uint8Array(7);
	if (!wsprPack(msg, d)) return null;
	return wsprSymbolsOf(d);
}

/** 162 channel symbols of 50 packed bits. */
export function wsprSymbolsOf(d: Uint8Array): number[] {
	const coded = new Uint8Array(162);
	const ch = new Uint8Array(162);
	wsprConvEncode(d, coded);
	wsprInterleave(coded, ch);
	return Array.from(ch, (c, i) => WSPR_SYNC[i] + 2 * c);
}
