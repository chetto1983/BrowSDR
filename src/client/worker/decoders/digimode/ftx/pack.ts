// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/hfdig/hfdig_ftx_msg.cpp (pack77 and its helpers, CallHash: the
// 77-bit messages of WSJT-X's packjt77.f90, re-implemented there from its description and cross-checked against
// ft8_lib's ft8/message.c), https://github.com/adswill/OnAir; see third_party/onair. Changes: the 58-, 64- and 71-bit
// numbers (nonstandard calls, free text, telemetry, the hash product) are BigInts instead of 64-bit integers and three
// 32-bit limbs.

import { ARRL_SECTIONS, rttyMult } from './tables';

export const NTOKENS = 2063592;
export const MAX22 = 4194304;
export const MAXGRID4 = 32400;
export const A1 = ' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const A2 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const A3 = '0123456789';
export const A4 = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const A38 = ' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ/';
export const A42 = ' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ+-./?';

export const idx = (alpha: string, c: string | undefined): number => (c ? alpha.indexOf(c) : -1);
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';
const isAlpha = (c: string | undefined): boolean => c !== undefined && ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'));
export const allIn = (s: string, alpha: string): boolean => [...s].every((c) => alpha.includes(c));
export const isLetters = (s: string): boolean => s.length > 0 && [...s].every((c) => c >= 'A' && c <= 'Z');
export const isDigits = (s: string): boolean => s.length > 0 && [...s].every(isDigit);
export const isGrid4 = (g: string): boolean =>
	g.length === 4 && g[0] >= 'A' && g[0] <= 'R' && g[1] >= 'A' && g[1] <= 'R' && isDigit(g[2]) && isDigit(g[3]);
export const trimSpaces = (s: string): string => s.replace(/^ +| +$/g, '');
export const splitWords = (s: string): string[] => s.split(/\s+/).filter((w) => w.length > 0);
export const isToken = (s: string): boolean => s === 'DE' || s === 'QRZ' || s.startsWith('CQ');

/** n bits MSB first from b[pos] (n <= 52). */
export function getBits(b: ArrayLike<number>, pos: number, n: number): number {
	let v = 0;
	for (let i = 0; i < n; i++) v = v * 2 + (b[pos + i] & 1);
	return v;
}
export function getBitsBig(b: ArrayLike<number>, pos: number, n: number): bigint {
	let v = 0n;
	for (let i = 0; i < n; i++) v = (v << 1n) | BigInt(b[pos + i] & 1);
	return v;
}
/** The low n bits of v, MSB first, to b[pos .. pos + n). */
export function setBits(b: Uint8Array, pos: number, n: number, v: number | bigint): void {
	let x = BigInt(v);
	for (let i = n - 1; i >= 0; i--) {
		b[pos + i] = Number(x & 1n);
		x >>= 1n;
	}
}

/** K1ABC/R -> K1ABC (suffix 1), K1ABC/P -> K1ABC (2). */
export function stripCall(c: string): [string, number] {
	if (c.length > 2 && c.endsWith('/R')) return [c.slice(0, -2), 1];
	if (c.length > 2 && c.endsWith('/P')) return [c.slice(0, -2), 2];
	return [c, 0];
}

/** The callsigns heard, by their 22-, 12- and 10-bit hashes, to show <hashed> calls by name. */
export class CallHash {
	private readonly m = new Map<number, string>();

	static hash22(call: string): number {
		const c = call.slice(0, 11).padEnd(11, ' ');
		let n = 0n;
		for (const ch of c) n = n * 38n + BigInt(Math.max(0, idx(A38, ch)));
		return Number((BigInt.asUintN(64, 47055833459n * n) >> 42n) & 0x3fffffn);
	}
	add(call: string): void {
		if (!call || call.length > 11 || call[0] === '<' || !allIn(call, A38)) return;
		if (this.m.size > 5000) this.m.clear();
		this.m.set(CallHash.hash22(call), call);
	}
	find22(h: number): string {
		return this.m.get(h) ?? '';
	}
	/** The call of the lowest 22-bit hash whose top bits are h (OnAir's ordered map). */
	private findTop(h: number, shift: number): string {
		let key = Infinity;
		let call = '';
		for (const [k, v] of this.m)
			if (k >> shift === h && k < key) {
				key = k;
				call = v;
			}
		return call;
	}
	find12(h: number): string {
		return this.findTop(h, 10);
	}
	find10(h: number): string {
		return this.findTop(h, 12);
	}
	clear(): void {
		this.m.clear();
	}
}

/** A standard callsign (base call, no suffix) -> its 28-bit number without the offsets, -1 if not standard. */
export function packBasecall(call: string): number {
	const len = call.length;
	if (len < 3) return -1;
	let c6: string;
	if (call.startsWith('3DA0') && len > 4 && len <= 7) c6 = '3D0' + call.slice(4);
	else if (call.startsWith('3X') && isAlpha(call[2]) && len <= 7) c6 = 'Q' + call.slice(2);
	else if (isDigit(call[2]) && len <= 6) c6 = call;
	else if (isDigit(call[1]) && len <= 5) c6 = ' ' + call;
	else return -1;
	c6 = c6.padEnd(6, ' ');
	if (c6.length > 6) return -1;
	const i = [idx(A1, c6[0]), idx(A2, c6[1]), idx(A3, c6[2]), idx(A4, c6[3]), idx(A4, c6[4]), idx(A4, c6[5])];
	if (i.some((v) => v < 0)) return -1;
	// the letters after the digit must be a run without spaces in between
	for (let k = 3; k < 5; k++) if (c6[k] === ' ' && c6[k + 1] !== ' ') return -1;
	return (((i[0] * 36 + i[1]) * 10 + i[2]) * 27 + i[3]) * 27 * 27 + i[4] * 27 + i[5];
}

/** A call, a <hashed call> or a token -> 28 bits; -1 if it does not fit. */
export function pack28(t: string): number {
	if (t === 'DE') return 0;
	if (t === 'QRZ') return 1;
	if (t === 'CQ') return 2;
	if (t.startsWith('CQ ')) {
		const m = t.slice(3);
		if (m.length === 3 && isDigits(m)) return 3 + Number(m);
		if (m.length >= 1 && m.length <= 4 && isLetters(m)) {
			let v = 0;
			for (const c of m.padStart(4, ' ')) v = v * 27 + idx(A4, c);
			return 1003 + v;
		}
		return -1;
	}
	if (t.length > 2 && t[0] === '<' && t.endsWith('>')) {
		const c = t.slice(1, -1);
		if (!c || c.length > 11 || !allIn(c, A38)) return -1;
		return NTOKENS + CallHash.hash22(c);
	}
	const n = packBasecall(t);
	return n < 0 ? -1 : NTOKENS + MAX22 + n;
}

/** The grid / report field of a standard message: g15 and the R bit; null if it is not one. */
function packGrid(t: string[], from: number): { g: number; ir: number } | null {
	const n = t.length - from;
	if (n === 0) return { g: MAXGRID4 + 1, ir: 0 };
	let a = t[from];
	let ir = 0;
	if (n === 2) {
		if (a !== 'R' || !isGrid4(t[from + 1])) return null;
		ir = 1;
		a = t[from + 1];
	} else if (n !== 1) return null;
	if (a === 'RRR') return { g: MAXGRID4 + 2, ir };
	if (a === 'RR73') return { g: MAXGRID4 + 3, ir };
	if (a === '73') return { g: MAXGRID4 + 4, ir };
	if (isGrid4(a)) {
		const code = (k: number, base: string) => a.charCodeAt(k) - base.charCodeAt(0);
		return { g: ((code(0, 'A') * 18 + code(1, 'A')) * 10 + code(2, '0')) * 10 + code(3, '0'), ir };
	}
	return packReport(a);
}

/** A signal report "-12" or "R+05" (-50 .. +49 dB): g15 and the R bit; null if it is not one. */
function packReport(a: string): { g: number; ir: number } | null {
	const roger = a.length >= 2 && a[0] === 'R' && (a[1] === '+' || a[1] === '-');
	const r = roger ? a.slice(1) : a;
	if (r.length < 2 || r.length > 3 || (r[0] !== '+' && r[0] !== '-') || !isDigits(r.slice(1))) return null;
	const dd = (r[0] === '-' ? -1 : 1) * Number(r.slice(1));
	if (dd < -50 || dd > 49) return null;
	const irpt = 35 + dd;
	return { g: MAXGRID4 + (irpt < 5 ? irpt + 101 : irpt), ir: roger ? 1 : 0 };
}

/** "CQ DX ..." / "CQ 123 ...": the modifier belongs to the first field. */
function joinCqModifier(input: string[]): string[] {
	const t = [...input];
	const letters = t.length >= 3 && t[1].length <= 4 && isLetters(t[1]) && pack28(t[2]) >= 0 && t[2] !== 'DE';
	const digits = t.length >= 3 && t[1].length === 3 && isDigits(t[1]);
	if (t[0] === 'CQ' && (letters || digits)) t.splice(0, 2, 'CQ ' + t[1]);
	return t;
}

function packStandard(input: string[], b: Uint8Array): boolean {
	const t = joinCqModifier(input);
	if (t.length < 2) return false;
	const [ca, sa] = isToken(t[0]) ? [t[0], 0] : stripCall(t[0]);
	const [cb, sb] = stripCall(t[1]);
	if ((sa === 1 && sb === 2) || (sa === 2 && sb === 1)) return false;
	const na = pack28(ca);
	const nb = pack28(cb);
	if (na < 0 || nb < 0 || isToken(cb)) return false;
	const grid = packGrid(t, 2);
	if (!grid) return false;
	if (na <= 2 && grid.ir) return false;
	setBits(b, 0, 28, na);
	b[28] = sa ? 1 : 0;
	setBits(b, 29, 28, nb);
	b[57] = sb ? 1 : 0;
	b[58] = grid.ir;
	setBits(b, 59, 15, grid.g);
	setBits(b, 74, 3, sa === 2 || sb === 2 ? 2 : 1);
	return true;
}

function isNonstandard(c: string): boolean {
	if (!c || c.length > 11 || !allIn(c, A38)) return false;
	return packBasecall(stripCall(c)[0]) < 0;
}

const bare = (s: string): string => (s.length > 2 && s[0] === '<' && s.endsWith('>') ? s.slice(1, -1) : s);

/** Which call of a type 4 message is hashed and which is sent in full: [hashed, plain, iflip], null if neither fits. */
function type4Calls(t: string[]): [string, string, number] | null {
	const n0 = isNonstandard(bare(t[0]));
	const n1 = isNonstandard(bare(t[1]));
	const h0 = t[0][0] === '<';
	const h1 = t[1][0] === '<';
	if (h0 && !h1 && n1) return [bare(t[0]), t[1], 0];
	if (h1 && !h0 && n0) return [bare(t[1]), t[0], 1];
	if (!h0 && !h1 && n1 && !n0) return [t[0], t[1], 0];
	if (!h0 && !h1 && n0 && !n1) return [t[1], t[0], 1];
	return null;
}

function packType4(t: string[], b: Uint8Array): boolean {
	if (t.length < 2 || t.length > 3) return false;
	let icq = 0;
	let iflip = 0;
	let nrpt = 0;
	let plain: string;
	let hashed = '';
	if (t[0] === 'CQ') {
		if (t.length !== 2 || !isNonstandard(t[1])) return false;
		icq = 1;
		plain = t[1];
	} else {
		const calls = type4Calls(t);
		if (!calls) return false;
		[hashed, plain, iflip] = calls;
		if (!hashed || !allIn(hashed, A38) || hashed.length > 11) return false;
		if (t.length === 3) {
			nrpt = ['', 'RRR', 'RR73', '73'].indexOf(t[2]);
			if (nrpt < 1) return false;
		}
	}
	let n58 = 0n;
	for (const c of plain.padStart(11, ' ')) n58 = n58 * 38n + BigInt(idx(A38, c));
	setBits(b, 0, 12, hashed ? CallHash.hash22(hashed) >> 10 : 0);
	setBits(b, 12, 58, n58);
	b[70] = iflip;
	setBits(b, 71, 2, nrpt);
	b[73] = icq;
	setBits(b, 74, 3, 4);
	return true;
}

function packFreeText(s: string, b: Uint8Array): boolean {
	if (s.length > 13 || !allIn(s, A42)) return false;
	let v = 0n;
	for (const c of s.padEnd(13, ' ')) v = v * 42n + BigInt(idx(A42, c));
	setBits(b, 0, 71, v);
	setBits(b, 71, 3, 0);
	setBits(b, 74, 3, 0);
	return true;
}

function packTelemetry(s: string, b: Uint8Array): boolean {
	if (s.length !== 18 || s[0] > '7' || !/^[0-9A-F]+$/.test(s)) return false;
	setBits(b, 0, 71, BigInt('0x' + s));
	setBits(b, 71, 3, 5);
	setBits(b, 74, 3, 0);
	return true;
}

/** The transmitters of a Field Day class ("16A": 1 .. 32 and a class letter A .. F), 0 if it is not one. */
function fieldDayTransmitters(cls: string): number {
	const last = cls[cls.length - 1];
	if (cls.length < 2 || cls.length > 3 || last < 'A' || last > 'F' || !isDigits(cls.slice(0, -1))) return 0;
	const ntx = Number(cls.slice(0, -1));
	return ntx >= 1 && ntx <= 32 ? ntx : 0;
}

/** ARRL Field Day (i3 = 0, n3 = 3 / 4): "WA9XYZ KA1ABC R 16A EMA": c28 c28 R1 n4 k3 S7. */
function packFieldDay(t: string[], b: Uint8Array): boolean {
	if (t.length !== 4 && t.length !== 5) return false;
	const r = t.length === 5;
	if (r && t[2] !== 'R') return false;
	const cls = t[r ? 3 : 2];
	const sec = t[r ? 4 : 3];
	const last = cls[cls.length - 1];
	const ntx = fieldDayTransmitters(cls);
	if (!ntx) return false;
	const isec = ARRL_SECTIONS.indexOf(sec) + 1;
	if (!isec || isToken(t[0]) || isToken(t[1])) return false;
	const na = pack28(t[0]);
	const nb = pack28(t[1]);
	if (na < 0 || nb < 0) return false;
	const n3 = ntx <= 16 ? 3 : 4;
	setBits(b, 0, 28, na);
	setBits(b, 28, 28, nb);
	b[56] = r ? 1 : 0;
	setBits(b, 57, 4, ntx - (n3 === 3 ? 1 : 17));
	setBits(b, 61, 3, last.charCodeAt(0) - 65);
	setBits(b, 64, 7, isec);
	setBits(b, 71, 3, n3);
	setBits(b, 74, 3, 0);
	return true;
}

/** The exchange of an RTTY Roundup message: a serial number 1 .. 7999 or a multiplier (8001 ..); 0 if neither. */
function rttyExchange(ex: string): number {
	if (isDigits(ex)) {
		const n = ex.length > 4 ? 0 : Number(ex);
		return n >= 1 && n <= 7999 ? n : 0;
	}
	for (let i = 0; i < 171; i++) if (ex === rttyMult(i)) return 8001 + i;
	return 0;
}

/** ARRL RTTY Roundup (i3 = 3): "TU; W9XYZ K1ABC R 579 MA" / "W9XYZ K1ABC 579 0012": t1 c28 c28 R1 r3 s13. */
function packRttyRu(input: string[], b: Uint8Array): boolean {
	const t = [...input];
	const tu = t.length > 0 && t[0] === 'TU;';
	if (tu) t.shift();
	if (t.length !== 4 && t.length !== 5) return false;
	const r = t.length === 5;
	if (r && t[2] !== 'R') return false;
	const rst = t[r ? 3 : 2];
	if (!/^5[2-9]9$/.test(rst)) return false;
	const nexch = rttyExchange(t[r ? 4 : 3]);
	if (!nexch || isToken(t[0]) || isToken(t[1])) return false;
	const na = pack28(t[0]);
	const nb = pack28(t[1]);
	if (na < 0 || nb < 0) return false;
	b[0] = tu ? 1 : 0;
	setBits(b, 1, 28, na);
	setBits(b, 29, 28, nb);
	b[57] = r ? 1 : 0;
	setBits(b, 58, 3, rst.charCodeAt(1) - 50);
	setBits(b, 61, 13, nexch);
	setBits(b, 74, 3, 3);
	return true;
}

/**
 * Text -> 77 bits (standard messages, /R /P, CQ with a modifier, <hashed> calls, contest messages, nonstandard calls
 * (type 4), telemetry, free text). Returns false when the text cannot be sent.
 */
export function pack77(text: string, b: Uint8Array): boolean {
	const t = splitWords(text.toUpperCase());
	const joined = t.join(' ');
	b.fill(0, 0, 77);
	if (!t.length) return false;
	const packers: Array<(t: string[], b: Uint8Array) => boolean> = [
		(w, bits) => w.length >= 2 && packStandard(w, bits),
		packFieldDay,
		packRttyRu,
		packType4,
		(w, bits) => w.length === 1 && packTelemetry(joined, bits),
	];
	for (const pack of packers) {
		if (pack(t, b)) return true;
		b.fill(0, 0, 77);
	}
	return packFreeText(joined, b);
}
