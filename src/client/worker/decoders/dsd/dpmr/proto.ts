// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/dpmr/dpmr_proto.cpp and core/include/dect2/dpmr/dpmr_proto.h
// (frame syncs, ccSymbols, ccDecode, crc8, crc7, crc16, hamEncode, hamDecode, pn9, blockEncode, blockDecode,
// blockDecodeSoft, header / CCH / end / data builders and parsers, names, idText), https://github.com/adswill/OnAir;
// see third_party/onair.
// Changes: bits are Uint8Array (one per element); parsers return records or null instead of filling references.
//
// dPMR mode 1 air interface (ETSI TS 102 490, peer to peer, 6.25 kHz): four-level FSK, 2400 symbols/s, outer
// deviation +-1050 Hz; dibits 01 +3, 00 +1, 10 -1, 11 -3 (the mapping of BrowSDR's slicer).
// Frame syncs: FS1 (header, 24 symbols), FS2 (payload frames, 12), FS3 (end frame, 24), FS4 (packet data header, 24).
//   header   FS1 or FS4 | HI0 (120 bits) | colour code (24 bits) | HI1 (120 bits, HI0 repeated)            156 symbols
//   payload  FS2 (frames 0, 2) or colour code (frames 1, 3) | CCH (72 bits) | TCH (288 bits)              192 symbols, 80 ms
//   end      FS3 | END (72 bits)                                                                          60 symbols
// HI: 80 bits (72 + CRC-8) in ten Hamming (12,8) words; CCH: 48 bits (41 + CRC-7) in six; END: 48 bits (41 + CRC-7) in
// six. Every block is written as rows of Hamming words and read out by columns, then XORed with PN9 (x^9 + x^5 + 1, all
// ones at the start of each block). TCH: four 72-bit AMBE+2 voice frames, or a 24-byte data block in 24 Hamming words.
// The colour code (0 to 63) is sent as 12 symbols, two per bit (1: +3 -3, 0: -3 +3). The superframe CCH carries the
// called id (frames 0, 1) and own id (frames 2, 3) in 12-bit halves, so a late entry finds both.
import type { DpmrCch, DpmrEnd, DpmrHeader } from './types';

export const FRAME_SYM = 192;
export const HDR_SYM = 156;
export const END_SYM = 60;
export const FS_LONG = 24;
export const FS_SHORT = 12;
export const CC_SYM = 12;

export const HDR_COMM = 0;
export const HDR_STATUS = 5;
export const MODE_DATA1 = 2;
export const MODE_DATA2 = 3;
export const MODE_PACKET = 4;
export const MODE_VOICE_DATA = 5;
export const CALL_INDIVIDUAL = 0;
export const CALL_GROUP = 1;
export const CALL_ALL = 2;

export function dibitToSym(d: number): number {
	return d === 1 ? 3 : d === 0 ? 1 : d === 2 ? -1 : -3;
}

function syncSymbols(hex: string): Int8Array {
	return Int8Array.from({ length: hex.length * 2 }, (_, i) => dibitToSym((parseInt(hex[i >> 1], 16) >> (i & 1 ? 0 : 2)) & 3));
}

export const FS1 = syncSymbols('57FF5F75D577');
export const FS2 = syncSymbols('5FF7D7');
export const FS3 = syncSymbols('7DFFD5F55D5F');
export const FS4 = syncSymbols('FD55F5DF7FDD');

export function ccSymbols(cc: number): Int8Array {
	const out = new Int8Array(CC_SYM);
	for (let i = 0; i < 6; i++) {
		const b = (cc >> (5 - i)) & 1;
		out[2 * i] = b ? 3 : -3;
		out[2 * i + 1] = b ? -3 : 3;
	}
	return out;
}

/** v: 12 normalised symbols; the best colour code, and 1 for a clean one. */
export function ccDecode(v: ArrayLike<number>): { cc: number; score: number } {
	let cc = 0;
	let score = 0;
	for (let i = 0; i < 6; i++) {
		const d = v[2 * i] - v[2 * i + 1];
		if (d > 0) cc |= 1 << (5 - i);
		score += Math.abs(d);
	}
	return { cc, score: score / 36 };
}

function crcGen(b: ArrayLike<number>, n: number, deg: number, poly: number, init: number): number {
	let r = init;
	const top = 1 << (deg - 1);
	const mask = (1 << deg) - 1;
	for (let i = 0; i < n; i++) {
		const f = ((r & top) !== 0) !== (b[i] !== 0);
		r = (r << 1) & mask;
		if (f) r ^= poly;
	}
	return r;
}

export const crc8 = (b: ArrayLike<number>, n: number): number => crcGen(b, n, 8, 0x07, 0);
export const crc7 = (b: ArrayLike<number>, n: number): number => crcGen(b, n, 7, 0x09, 0);
export const crc16 = (b: ArrayLike<number>, n: number): number => crcGen(b, n, 16, 0x1021, 0xffff);

/** The parity pattern (syndrome) of each data bit. */
const SYN = [0x3, 0x5, 0x6, 0x7, 0x9, 0xa, 0xb, 0xc];

export function hamEncode(d: ArrayLike<number>, c: Uint8Array, dStart = 0, cStart = 0): void {
	let p = 0;
	for (let i = 0; i < 8; i++) {
		c[cStart + i] = d[dStart + i] & 1;
		if (c[cStart + i]) p ^= SYN[i];
	}
	for (let i = 0; i < 4; i++) c[cStart + 8 + i] = (p >> (3 - i)) & 1;
}

/** Corrects one error in place; 0 clean, 1 corrected, -1 more. */
export function hamDecode(c: Uint8Array): number {
	let s = 0;
	for (let i = 0; i < 8; i++) if (c[i]) s ^= SYN[i];
	for (let i = 0; i < 4; i++) if (c[8 + i]) s ^= 1 << (3 - i);
	if (!s) return 0;
	for (let i = 0; i < 8; i++)
		if (SYN[i] === s) {
			c[i] ^= 1;
			return 1;
		}
	for (let i = 0; i < 4; i++)
		if (1 << (3 - i) === s) {
			c[8 + i] ^= 1;
			return 1;
		}
	return -1;
}

export function pn9(n: number): Uint8Array {
	const out = new Uint8Array(n);
	let s = 0x1ff;
	for (let i = 0; i < n; i++) {
		out[i] = s & 1;
		const f = (s ^ (s >> 5)) & 1;
		s = (s >> 1) | (f << 8);
	}
	return out;
}

/** nWords Hamming words (8 * nWords info bits) to 12 * nWords air bits, interleaved and scrambled. */
export function blockEncode(info: ArrayLike<number>, nWords: number): Uint8Array {
	const air = new Uint8Array(12 * nWords);
	const c = new Uint8Array(12);
	const pn = pn9(12 * nWords);
	for (let w = 0; w < nWords; w++) {
		hamEncode(info, c, 8 * w);
		for (let k = 0; k < 12; k++) air[k * nWords + w] = c[k];
	}
	for (let i = 0; i < air.length; i++) air[i] ^= pn[i];
	return air;
}

/** Bits corrected, or -1 when a word could not be corrected. */
export function blockDecode(air: ArrayLike<number>, nWords: number, info: Uint8Array): number {
	const c = new Uint8Array(12);
	const pn = pn9(12 * nWords);
	let fixed = 0;
	let bad = false;
	for (let w = 0; w < nWords; w++) {
		for (let k = 0; k < 12; k++) c[k] = (air[k * nWords + w] ^ pn[k * nWords + w]) & 1;
		const r = hamDecode(c);
		if (r < 0) bad = true;
		else fixed += r;
		info.set(c.subarray(0, 8), 8 * w);
	}
	return bad ? -1 : fixed;
}

let codewords: Uint16Array | null = null;

function codewordTable(): Uint16Array {
	if (codewords) return codewords;
	codewords = new Uint16Array(256);
	const d = new Uint8Array(8);
	const c = new Uint8Array(12);
	for (let v = 0; v < 256; v++) {
		for (let i = 0; i < 8; i++) d[i] = (v >> (7 - i)) & 1;
		hamEncode(d, c);
		let w = 0;
		for (let k = 0; k < 12; k++) w = (w << 1) | c[k];
		codewords[v] = w;
	}
	return codewords;
}

function popcount(v: number): number {
	let n = 0;
	for (let x = v; x; x &= x - 1) n++;
	return n;
}

/**
 * Soft decision from values in air order (> 0 a 1, the magnitude the confidence; before the descrambling): every word
 * is the codeword closest to the received values (all 256 tried), which also repairs most double errors that the hard
 * decoder can only detect. A word more than two bits from the hard decisions is not trusted (-1).
 */
export function blockDecodeSoft(soft: ArrayLike<number>, nWords: number, info: Uint8Array): number {
	const table = codewordTable();
	const pn = pn9(12 * nWords);
	const s = new Float32Array(12);
	let fixed = 0;
	let bad = false;
	for (let w = 0; w < nWords; w++) {
		let hard = 0;
		for (let k = 0; k < 12; k++) {
			s[k] = pn[k * nWords + w] ? -soft[k * nWords + w] : soft[k * nWords + w];
			hard = (hard << 1) | (s[k] > 0 ? 1 : 0);
		}
		let best = 0;
		let bm = -1e30;
		for (let v = 0; v < 256; v++) {
			const c = table[v];
			let m = 0;
			for (let k = 0; k < 12; k++) m += (c >> (11 - k)) & 1 ? s[k] : -s[k];
			if (m > bm) {
				bm = m;
				best = v;
			}
		}
		const dist = popcount(table[best] ^ hard);
		if (dist > 2) bad = true;
		else fixed += dist;
		for (let i = 0; i < 8; i++) info[8 * w + i] = (best >> (7 - i)) & 1;
	}
	return bad ? -1 : fixed;
}

function put(b: Uint8Array, p: { i: number }, v: number, n: number): void {
	for (let k = n - 1; k >= 0; k--) b[p.i++] = Math.floor(v / 2 ** k) & 1;
}

function get(b: ArrayLike<number>, p: { i: number }, n: number): number {
	let v = 0;
	for (let k = 0; k < n; k++) v = v * 2 + b[p.i++];
	return v;
}

export function headerBits(h: DpmrHeader): Uint8Array {
	const b = new Uint8Array(80);
	const p = { i: 0 };
	put(b, p, h.type, 4);
	put(b, p, h.called & 0xffffff, 24);
	put(b, p, h.own & 0xffffff, 24);
	put(b, p, h.commMode, 3);
	put(b, p, h.callType, 2);
	put(b, p, h.emergency ? 1 : 0, 1);
	put(b, p, h.extra & 0xff, 8);
	put(b, p, 0, 6);
	put(b, p, crc8(b, 72), 8);
	return b;
}

export function headerParse(b: ArrayLike<number>): DpmrHeader | null {
	if (get(b, { i: 72 }, 8) !== crc8(b, 72)) return null;
	const p = { i: 0 };
	const h: DpmrHeader = {
		type: get(b, p, 4),
		called: get(b, p, 24),
		own: get(b, p, 24),
		commMode: get(b, p, 3),
		callType: get(b, p, 2),
		emergency: get(b, p, 1) === 1,
		extra: get(b, p, 8),
	};
	return h.type <= HDR_STATUS && h.commMode <= MODE_VOICE_DATA && h.callType <= CALL_ALL ? h : null;
}

export function cchBits(c: DpmrCch): Uint8Array {
	const b = new Uint8Array(48);
	const p = { i: 0 };
	put(b, p, c.frame, 2);
	put(b, p, c.idPart, 12);
	put(b, p, c.commMode, 3);
	put(b, p, c.version, 2);
	put(b, p, c.callType, 2);
	put(b, p, c.emergency ? 1 : 0, 1);
	put(b, p, 0, 1);
	put(b, p, c.slowData & 0x3ffff, 18);
	put(b, p, crc7(b, 41), 7);
	return b;
}

export function cchParse(b: ArrayLike<number>): DpmrCch | null {
	if (get(b, { i: 41 }, 7) !== crc7(b, 41)) return null;
	const p = { i: 0 };
	const c: DpmrCch = {
		frame: get(b, p, 2),
		idPart: get(b, p, 12),
		commMode: get(b, p, 3),
		version: get(b, p, 2),
		callType: get(b, p, 2),
		emergency: get(b, p, 1) === 1,
		slowData: get(b, { i: 23 }, 18),
	};
	return c.commMode <= MODE_VOICE_DATA ? c : null;
}

export function endBits(e: DpmrEnd): Uint8Array {
	const b = new Uint8Array(48);
	const p = { i: 0 };
	put(b, p, e.type, 2);
	put(b, p, e.own & 0xffffff, 24);
	put(b, p, 0, 15);
	put(b, p, crc7(b, 41), 7);
	return b;
}

export function endParse(b: ArrayLike<number>): DpmrEnd | null {
	if (get(b, { i: 41 }, 7) !== crc7(b, 41)) return null;
	const p = { i: 0 };
	return { type: get(b, p, 2), own: get(b, p, 24) };
}

/** Data block: block number, 21 characters, CRC-16; 192 bits. */
export function dataBits(block: number, text21: string): Uint8Array {
	const b = new Uint8Array(192);
	const p = { i: 0 };
	put(b, p, block & 0xff, 8);
	for (let i = 0; i < 21; i++) put(b, p, i < text21.length ? text21.charCodeAt(i) & 0xff : 0, 8);
	put(b, p, crc16(b, 176), 16);
	return b;
}

export function dataParse(b: ArrayLike<number>): { block: number; text: string } | null {
	if (get(b, { i: 176 }, 16) !== crc16(b, 176)) return null;
	const p = { i: 0 };
	const block = get(b, p, 8);
	let text = '';
	for (let i = 0; i < 21; i++) {
		const ch = get(b, p, 8);
		if (ch) text += ch >= 32 && ch < 127 ? String.fromCharCode(ch) : '.';
	}
	return { block, text };
}

const HDR_TYPES = ['call', 'connection request', 'unconnect', 'acknowledge', 'system request', 'status'];
const COMM_MODES = ['voice', 'voice + slow data', 'data type 1', 'data type 2', 'packet data', 'voice + data'];

export const hdrTypeName = (t: number): string => HDR_TYPES[t] ?? '?';
export const commModeName = (m: number): string => COMM_MODES[m] ?? '?';
export const callTypeName = (t: number): string =>
	t === CALL_INDIVIDUAL ? 'individual' : t === CALL_GROUP ? 'group' : t === CALL_ALL ? 'all call' : '?';

/** PMR446 digital channel 1 to 16. */
export const pmr446Mhz = (ch: number): number => 446.103125 + (ch - 1) * 0.00625;

/** dPMR ids are shown as 8-digit numbers (the "all" id 0xFFFFFF as ALL). */
export function idText(id: number): string {
	if (id < 0) return '?';
	return id === 0xffffff ? 'ALL' : String(id).padStart(8, '0');
}
