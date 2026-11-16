// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/hfdig/hfdig_ftx_msg.cpp (unpack77, unpack28, callAndGrid,
// gridToLatLon: the 77-bit messages of WSJT-X's packjt77.f90, re-implemented there from its description and
// cross-checked against ft8_lib's ft8/message.c), https://github.com/adswill/OnAir; see third_party/onair. Changes: the
// 58- and 71-bit numbers are BigInts; each message type is a function of its own.

import { ARRL_SECTIONS, rttyMult } from './tables';
import {
	A1,
	A2,
	A3,
	A38,
	A4,
	A42,
	type CallHash,
	getBits,
	getBitsBig,
	isDigits,
	isGrid4,
	isLetters,
	isToken,
	MAX22,
	MAXGRID4,
	NTOKENS,
	splitWords,
	stripCall,
	trimSpaces,
} from './pack';

function unpackHashed(h: number, bits: number, hash: CallHash | null): string {
	const c = !hash ? '' : bits === 22 ? hash.find22(h) : bits === 12 ? hash.find12(h) : hash.find10(h);
	return c ? `<${c}>` : '<...>';
}

/** 28 bits -> text; empty when invalid. */
function unpack28(n: number, hash: CallHash | null): string {
	if (n < NTOKENS) {
		if (n === 0) return 'DE';
		if (n === 1) return 'QRZ';
		if (n === 2) return 'CQ';
		if (n <= 1002) return `CQ ${String(n - 3).padStart(3, '0')}`;
		if (n <= 532443) {
			let m = n - 1003;
			let c = '';
			for (let k = 0; k < 4; k++, m = Math.floor(m / 27)) c = A4[m % 27] + c;
			const s = trimSpaces(c);
			return s ? `CQ ${s}` : '';
		}
		return '';
	}
	n -= NTOKENS;
	if (n < MAX22) return unpackHashed(n, 22, hash);
	n -= MAX22;
	const c = [0, 0, 0, 0, 0, 0].map(() => ' ');
	for (let k = 5; k >= 3; k--, n = Math.floor(n / 27)) c[k] = A4[n % 27];
	c[2] = A3[n % 10];
	n = Math.floor(n / 10);
	c[1] = A2[n % 36];
	n = Math.floor(n / 36);
	if (n >= 37) return '';
	c[0] = A1[n];
	let s = trimSpaces(c.join(''));
	if (s.length >= 4 && s.startsWith('3D0')) s = '3DA0' + s.slice(3);
	else if (s.length >= 2 && s[0] === 'Q' && s[1] >= 'A' && s[1] <= 'Z') s = '3X' + s.slice(1);
	return !s || s.includes(' ') ? '' : s;
}

const report = (isnr: number): string => `${isnr >= 0 ? '+' : '-'}${String(Math.abs(isnr)).padStart(2, '0')}`;

/** Digits of v in base `alpha.length`, `count` of them, most significant first. */
function digits(v: bigint, count: number, alpha: string): string {
	let s = '';
	const base = BigInt(alpha.length);
	for (let k = 0; k < count; k++, v /= base) s = alpha[Number(v % base)] + s;
	return s;
}

/** Standard messages (i3 = 1 with /R, i3 = 2 with /P). */
function unpackStandard(b: ArrayLike<number>, i3: number, hash: CallHash | null, learn: (c: string) => void): string {
	const [ipa, ipb, ir] = [b[28], b[57], b[58]];
	const g = getBits(b, 59, 15);
	let ca = unpack28(getBits(b, 0, 28), hash);
	let cb = unpack28(getBits(b, 29, 28), hash);
	if (!ca || !cb || isToken(cb)) return '';
	const suf = i3 === 1 ? '/R' : '/P';
	if (ipa && !isToken(ca) && ca[0] !== '<') ca += suf;
	if (ipb && cb[0] !== '<') cb += suf;
	// a CQ does not carry a report
	if (g > MAXGRID4 + 1 && isToken(ca) && ca.startsWith('CQ')) return '';
	learn(ca);
	learn(cb);
	return `${ca} ${cb}${gridField(g, ir)}`;
}

/** The grid / report field of a standard message (with its leading space), empty when there is none. */
function gridField(g: number, ir: number): string {
	if (g <= MAXGRID4) {
		const gr = String.fromCharCode(65 + Math.floor(g / 1800), 65 + (Math.floor(g / 100) % 18)) + (Math.floor(g / 10) % 10) + (g % 10);
		return ir ? ` R ${gr}` : ` ${gr}`;
	}
	const irpt = g - MAXGRID4;
	if (irpt < 2) return '';
	if (irpt < 5) return ['', '', ' RRR', ' RR73', ' 73'][irpt];
	let isnr = irpt - 35;
	if (isnr > 50) isnr -= 101;
	return ` ${ir ? 'R' : ''}${report(isnr)}`;
}

/** i3 = 0: free text, DXpedition, Field Day, telemetry. */
function unpackZero(b: ArrayLike<number>, n3: number, hash: CallHash | null, learn: (c: string) => void): string {
	if (n3 === 0) return trimSpaces(digits(getBitsBig(b, 0, 71), 13, A42));
	if (n3 === 5) {
		const hex = digits(getBitsBig(b, 0, 71), 18, '0123456789ABCDEF').replace(/^0+/, '');
		return hex || '0';
	}
	const c1 = unpack28(getBits(b, 0, 28), hash);
	const c2 = unpack28(getBits(b, 28, 28), hash);
	if (n3 === 1) {
		if (!c1 || !c2 || isToken(c1) || isToken(c2)) return '';
		const h = unpackHashed(getBits(b, 56, 10), 10, hash);
		const rpt = 2 * getBits(b, 66, 5) - 30;
		learn(c1);
		learn(c2);
		return `${c1} RR73; ${c2} ${h} ${report(rpt)}`;
	}
	if (n3 === 3 || n3 === 4) {
		if (!c1 || !c2 || isToken(c2)) return '';
		const [ir, intx, ncl, isec] = [b[56], getBits(b, 57, 4), getBits(b, 61, 3), getBits(b, 64, 7)];
		if (isec < 1 || isec > 86) return '';
		const ntx = intx + (n3 === 3 ? 1 : 17);
		learn(c1);
		learn(c2);
		return `${c1} ${c2}${ir ? ' R ' : ' '}${ntx}${String.fromCharCode(65 + ncl)} ${ARRL_SECTIONS[isec - 1]}`;
	}
	return '';
}

/** i3 = 3: ARRL RTTY Roundup. */
function unpackRttyRu(b: ArrayLike<number>, hash: CallHash | null, learn: (c: string) => void): string {
	const c1 = unpack28(getBits(b, 1, 28), hash);
	const c2 = unpack28(getBits(b, 29, 28), hash);
	if (!c1 || !c2 || isToken(c2)) return '';
	const [itu, ir, irpt, nexch] = [b[0], b[57], getBits(b, 58, 3), getBits(b, 61, 13)];
	let ex: string;
	if (nexch > 8000) {
		if (nexch - 8000 > 171) return '';
		ex = rttyMult(nexch - 8001);
	} else {
		if (nexch < 1) return '';
		ex = String(nexch).padStart(4, '0');
	}
	learn(c1);
	learn(c2);
	return `${itu ? 'TU; ' : ''}${c1} ${c2}${ir ? ' R ' : ' '}5${irpt + 2}9 ${ex}`;
}

/** i3 = 4: one nonstandard call in full, the other hashed. */
function unpackType4(b: ArrayLike<number>, hash: CallHash | null): string {
	const h12 = getBits(b, 0, 12);
	const [iflip, nrpt, icq] = [b[70], getBits(b, 71, 2), b[73]];
	const plain = trimSpaces(digits(getBitsBig(b, 12, 58), 11, A38));
	if (!plain) return '';
	hash?.add(plain);
	if (icq) return `CQ ${plain}`;
	const h = unpackHashed(h12, 12, hash);
	return (iflip ? `${plain} ${h}` : `${h} ${plain}`) + ['', ' RRR', ' RR73', ' 73'][nrpt];
}

/** i3 = 5: EU VHF contest. */
function unpackEuVhf(b: ArrayLike<number>, hash: CallHash | null): string {
	const c1 = unpackHashed(getBits(b, 0, 12), 12, hash);
	const c2 = unpackHashed(getBits(b, 12, 22), 22, hash);
	const [ir, irpt, ser] = [b[34], getBits(b, 35, 3), getBits(b, 38, 11)];
	let g6 = getBits(b, 49, 25);
	if (g6 > 18662399) return '';
	const gr: string[] = [];
	for (const [base, from] of [
		[24, 65],
		[24, 65],
		[10, 48],
		[10, 48],
		[18, 65],
	] as const) {
		gr.unshift(String.fromCharCode(from + (g6 % base)));
		g6 = Math.floor(g6 / base);
	}
	gr.unshift(String.fromCharCode(65 + g6));
	const ex = String(52 + irpt).padStart(2, '0') + String(ser).padStart(4, '0');
	return `${c1} ${c2}${ir ? ' R ' : ' '}${ex} ${gr.join('')}`;
}

/** 77 bits -> text; empty when the bits are not a valid message. Learns the calls it sees (when hash is given). */
export function unpack77(b: ArrayLike<number>, hash: CallHash | null): string {
	const i3 = getBits(b, 74, 3);
	const n3 = getBits(b, 71, 3);
	let any = false;
	for (let i = 0; i < 77; i++) any ||= b[i] !== 0;
	if (!any) return '';
	const learn = (c: string): void => {
		if (!hash || !c || c[0] === '<' || isToken(c)) return;
		hash.add(stripCall(c)[0]);
		hash.add(c);
	};
	if (i3 === 1 || i3 === 2) return unpackStandard(b, i3, hash, learn);
	if (i3 === 0) return unpackZero(b, n3, hash, learn);
	if (i3 === 3) return unpackRttyRu(b, hash, learn);
	if (i3 === 4) return unpackType4(b, hash);
	if (i3 === 5) return unpackEuVhf(b, hash);
	return '';
}

const bareCall = (s: string): string => {
	const c = s.length > 2 && s[0] === '<' && s.endsWith('>') ? s.slice(1, -1) : s;
	return c === '...' ? '' : c;
};
const isGridWord = (g: string): boolean =>
	g !== 'RR73' && (isGrid4(g) || (g.length === 6 && isGrid4(g.slice(0, 4)) && g[4] >= 'A' && g[4] <= 'X' && g[5] >= 'A' && g[5] <= 'X'));

/** Where the calls begin: after "CQ" and its modifier ("CQ DX", "CQ 123"), else 0. */
function firstCall(t: string[]): number {
	if (t[0] !== 'CQ') return 0;
	const modifier = t.length >= 3 && (isLetters(t[1]) || isDigits(t[1])) && t[1].length <= 4 && !isGridWord(t[2]) && t[2] !== 'R';
	return modifier ? 2 : 1;
}

/**
 * The calling station and its grid of a decoded message ("CQ K1ABC FN42" -> K1ABC, FN42; "K1ABC W9XYZ EN37" -> W9XYZ,
 * EN37): [call, grid], empty strings when the message has none.
 */
export function callAndGrid(msg: string): [string, string] {
	const t = splitWords(msg);
	if (!t.length) return ['', ''];
	if (msg.includes(';')) return [t.length === 5 && t[1] === 'RR73;' ? bareCall(t[3]) : '', ''];
	const first = firstCall(t);
	let call = '';
	let grid = '';
	if (t.length >= 2 && isGridWord(t[t.length - 1])) {
		grid = t[t.length - 1];
		let i = t.length - 2;
		if (t[i] === 'R' && i > 0) i--;
		call = bareCall(t[i]);
		if (first === 0 && t.length >= 3 && i === 0) call = bareCall(t[0]);
	} else if (first > 0 && t.length > first) call = bareCall(t[first]);
	else if (t.length >= 2) call = bareCall(t[1]);
	if (isDigits(call) || call === 'R' || call === 'RRR' || call === '73') call = '';
	return [call, grid];
}

/** The middle of a 4- or 6-character locator: [lat, lon], null when it is not one. */
export function gridToLatLon(g: string): [number, number] | null {
	if (g.length < 4 || !isGrid4(g.slice(0, 4))) return null;
	const at = (k: number, base: string) => g.charCodeAt(k) - base.charCodeAt(0);
	let lon = at(0, 'A') * 20 - 180 + at(2, '0') * 2;
	let lat = at(1, 'A') * 10 - 90 + at(3, '0');
	if (g.length >= 6 && g[4] >= 'A' && g[4] <= 'X' && g[5] >= 'A' && g[5] <= 'X') {
		lon += at(4, 'A') * (2 / 24) + 1 / 24;
		lat += at(5, 'A') * (1 / 24) + 0.5 / 24;
	} else {
		lon += 1;
		lat += 0.5;
	}
	return [lat, lon];
}
