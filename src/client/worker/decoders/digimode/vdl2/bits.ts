// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir rust/onair_vdl2/src/bits.rs (scrambler, burst header code, burst
// layout) and core/src/vdl2/vdl2_proto.cpp, vdl2_proto.h (constants, training sequence, Gray map),
// https://github.com/adswill/OnAir; see third_party/onair.
//
// VDL Mode 2 burst bit layer (ICAO Annex 10 Vol III Part I section 6.3, Doc 9776): the x^15 + x + 1 scrambler, the
// (25,20) burst header code and the layout of the data and FEC octets of a burst.

import type { Vdl2Header, Vdl2Layout } from './types';

export const VDL2_SYMBOL_RATE = 10500;
export const PREAMBLE_SYMS = 16;
export const HEADER_BITS = 25;
/** Data octets of one Reed-Solomon block (255,249), and the codeword length. */
export const RS_K = 249;
export const RS_N = 255;
/** The scrambler register at the first header bit. */
export const LFSR_SEED = 0x6959;

/** Phase of each training symbol relative to the first, in units of pi/4. */
export const PREAMBLE_PHASE: readonly number[] = [0, 3, -3, 1, 1, 2, 0, 4, -3, 4, -2, 3, 1, -2, -3, 0];
/** Phase step (units of pi/4) -> its three bits (first bit sent = most significant). */
export const GRAY_BITS: readonly number[] = [0, 1, 3, 2, 6, 7, 5, 4];

/** The phase step that sends three bits. */
export const stepForBits = (bits: number): number => Math.max(0, GRAY_BITS.indexOf(bits & 7));

/** XORs the scrambler sequence (one pass scrambles, the same pass descrambles) over `bits` from `from` on; the sequence starts there. */
export function scramble(bits: Uint8Array, from = 0): void {
	let s = LFSR_SEED;
	for (let i = from; i < bits.length; i++) {
		const x = (s ^ (s >> 14)) & 1;
		s = (s >> 1) | (x << 14);
		bits[i] ^= x;
	}
}

const bits25 = (t: string): number => parseInt(t, 2);

/** Parity rows of the header code over the 25 bit word (bit 24 = first sent); the low five bits are the parity bits. */
const ROWS = [
	'0000000011111111111110000',
	'0011111100001111111101000',
	'1100011100110000111100100',
	'1101101101010011001100010',
	'0110100111100101010100001',
].map(bits25);

/** Error patterns by syndrome (bit 4 of the syndrome = row 0). */
const SYND = [
	'0000000000000000000000000',
	'0000000000000000000000001',
	'0000000000000000000000010',
	'0100000000000000000000100',
	'0000000000000000000000100',
	'0100000000000000000000010',
	'1000000000000000000000000',
	'0100000000000000000000000',
	'0000000000000000000001000',
	'0010000000000000000000000',
	'0001000000000000000000000',
	'0000100000000000000000000',
	'0000010000000000000000000',
	'1000100000000000000000000',
	'0000001000000000000000000',
	'0000000100000000000000000',
	'0000000000000000000010000',
	'0000000010000000000000000',
	'0100000000100000000000000',
	'0000000001000000000000000',
	'0100000001000000000000000',
	'0000000000100000000000000',
	'0000000000010000000000000',
	'1000000010000000000000000',
	'0000000000001000000000000',
	'0000000000000100000000000',
	'0000000000000010000000000',
	'0000000000000001000000000',
	'0000000000000000100000000',
	'0000000000000000010000000',
	'0000000000000000001000000',
	'0000000000000000000100000',
].map(bits25);

/** Reverses the low `n` bits of `v`. */
export function rev(v: number, n: number): number {
	let r = 0;
	for (let i = 0; i < n; i++) {
		r = ((r << 1) | (v & 1)) >>> 0;
		v >>>= 1;
	}
	return r;
}

function par(v: number): number {
	let p = 0;
	for (let x = v >>> 0; x; x &= x - 1) p ^= 1;
	return p;
}

function syndrome(w: number): number {
	let s = 0;
	ROWS.forEach((row, i) => (s |= par(w & row) << (4 - i)));
	return s;
}

/** The 25 header bits for a burst of `lenBits` data bits: 3 reserved zero bits, the 17 bit length sent least significant bit first, 5 parity bits. */
export function headerWord(lenBits: number): number {
	let w = rev(lenBits & 0x1ffff, 17) << 5;
	ROWS.forEach((row, i) => (w |= par(w & row) << (4 - i)));
	return w;
}

/**
 * Corrects the 25 bit header word and reads the length. The reserved bits are not checked; an uncorrected length may be
 * up to 0x3FFF, a corrected one up to 0x1FFF.
 */
export function headerDecode(word: number): Vdl2Header {
	let w = word & ((1 << 22) - 1);
	const s = syndrome(w);
	const h: Vdl2Header = { ok: false, corrected: s !== 0, len: 0 };
	w ^= SYND[s];
	if (w >>> 22 !== 0) return h;
	h.len = rev((w >>> 5) & 0x1ffff, 17);
	h.ok = h.len !== 0 && h.len <= (h.corrected ? 0x1fff : 0x3fff);
	return h;
}

/** Parity octets carried by the last (short) block of `n` data octets: 0 under 3, 2 for 3 - 30, 4 for 31 - 67, 6 above. */
export function lastFec(n: number): number {
	if (n < 3) return 0;
	if (n <= 30) return 2;
	return n <= 67 ? 4 : 6;
}

/** The layout for `lenBits` data bits; undefined when it cannot be a burst. */
export function layout(lenBits: number): Vdl2Layout | undefined {
	const l: Vdl2Layout = { dataOct: Math.floor((lenBits + 7) / 8), fecOct: 0, blocks: 0, lastLen: 0, lastFec: 6 };
	l.blocks = Math.floor(l.dataOct / RS_K);
	l.fecOct = l.blocks * (RS_N - RS_K);
	l.lastLen = l.dataOct % RS_K;
	if (l.lastLen !== 0) {
		l.blocks += 1;
		l.lastFec = lastFec(l.lastLen);
		l.fecOct += l.lastFec;
	} else {
		l.lastLen = RS_K;
	}
	return l.dataOct > 0 && l.fecOct > 0 ? l : undefined;
}
