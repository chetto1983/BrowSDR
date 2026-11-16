// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/tones/tones_proto.cpp and core/include/dect2/tones/tones_proto.h
// (CTCSS, DCS, DTMF, five-tone sequential and SELCAL tables and codes) and dtmf_numbers.h (the kind of a key group),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: dcsDecode returns the hit or null, and of readings
// that rank the same it takes the lowest code (OnAir takes the first rotation found, which depends on where the
// receiver's window starts, so a waveform that reads as two such codes changed from hop to hop and never locked).

import type { DcsHit, SeqSet } from './types';

// ---- CTCSS: 50 sub-audible tones, ascending. The first 38 of the EIA / TIA-603 list are "standard"; 69.3 Hz and the
// ones above 150 Hz that are not in it are "extended".
export const CTCSS_HZ: readonly number[] = [
	67.0, 69.3, 71.9, 74.4, 77.0, 79.7, 82.5, 85.4, 88.5, 91.5, 94.8, 97.4, 100.0, 103.5, 107.2, 110.9, 114.8, 118.8, 123.0, 127.3, 131.8,
	136.5, 141.3, 146.2, 151.4, 156.7, 159.8, 162.2, 165.5, 167.9, 171.3, 173.8, 177.3, 179.9, 183.5, 186.2, 189.9, 192.8, 196.6, 199.5,
	203.5, 206.5, 210.7, 218.1, 225.7, 229.1, 233.6, 241.8, 250.3, 254.1,
];
const EXTENDED = [69.3, 159.8, 165.5, 171.3, 177.3, 183.5, 189.9, 196.6, 199.5, 206.5, 229.1, 254.1];

export const ctcssHz = (idx: number): number => CTCSS_HZ[Math.max(0, Math.min(CTCSS_HZ.length - 1, idx))];
export const ctcssExtended = (idx: number): boolean => EXTENDED.some((e) => Math.abs(e - ctcssHz(idx)) < 0.01);

/** Nearest tone, -1 when none is within 1.2 Hz. */
export function ctcssIndex(hz: number): number {
	let best = -1;
	let bd = 1.2;
	for (let i = 0; i < CTCSS_HZ.length; i++) {
		if (Math.abs(CTCSS_HZ[i] - hz) < bd) {
			bd = Math.abs(CTCSS_HZ[i] - hz);
			best = i;
		}
	}
	return best;
}

// ---- DCS (Digital Coded Squelch): 134.4 bit/s, a 23 bit Golay (23,12) word repeated without a gap. Bits are sent least
// significant first: 9 code bits (three octal digits), the marker bits 1,0,0 (written 100 with the first-sent bit last),
// then the 11 parity bits.
export const DCS_BAUD = 134.4;
/** The 83 codes of the usual list. */
export const DCS_STANDARD_CODES: readonly number[] = [
	23, 25, 26, 31, 32, 43, 47, 51, 54, 65, 71, 72, 73, 74, 114, 115, 116, 125, 131, 132, 134, 143, 152, 155, 156, 162, 165, 172, 174, 205,
	223, 226, 243, 244, 245, 251, 261, 263, 265, 271, 306, 311, 315, 331, 343, 346, 351, 364, 365, 371, 411, 412, 413, 423, 431, 432, 445,
	464, 465, 466, 503, 506, 516, 532, 546, 565, 606, 612, 624, 627, 631, 632, 654, 662, 664, 703, 712, 723, 731, 732, 734, 743, 754,
];
const GOLAY = 0xc75; // x^11 + x^10 + x^6 + x^5 + x^4 + x^2 + 1
const MASK23 = 0x7fffff;

/** v = data(12 bits) << 11 | parity(11 bits): zero for a code word. */
function golayRem(v: number): number {
	for (let i = 22; i >= 11; i--) if ((v >>> i) & 1) v ^= GOLAY << (i - 11);
	return v;
}

/** 23 (octal digits written in decimal) -> 19. */
function octalValue(code: number): number {
	let v = 0;
	let mul = 1;
	for (let i = 0; i < 3; i++) {
		v += (code % 10) * mul;
		mul *= 8;
		code = Math.floor(code / 10);
	}
	return v & 0x1ff;
}

const octalWritten = (v: number) => ((v >> 6) & 7) * 100 + ((v >> 3) & 7) * 10 + (v & 7);
const rotl = (w: number, r: number) => (r === 0 ? w : ((w << r) | (w >>> (23 - r))) & MASK23);

/** Code as written (23 means octal 023); bit i of the result is the i-th bit on the air. */
export function dcsWord(code: number): number {
	const data = 0x800 | octalValue(code);
	const par = golayRem(data << 11);
	return (data | (par << 12)) >>> 0;
}

/** The word as received (normal polarity): the code when parity and marker are right, else -1. */
export function dcsValid(w: number): number {
	w &= MASK23;
	const data = w & 0xfff;
	const par = (w >>> 12) & 0x7ff;
	if (data >> 9 !== 4) return -1;
	if (golayRem((data << 11) | par) !== 0) return -1;
	return octalWritten(data & 0x1ff);
}

export const dcsStandard = (code: number): boolean => DCS_STANDARD_CODES.includes(code);

/**
 * All 23 rotations (the word repeats; where it starts is not known) and both polarities of a received word; the best
 * reading, the normal polarity first.
 */
export function dcsDecode(w: number): DcsHit | null {
	w &= MASK23;
	const found: Array<{ code: number; inv: boolean }> = [];
	for (let r = 0; r < 23; r++) {
		const normal = dcsValid(rotl(w, r));
		if (normal >= 0) found.push({ code: normal, inv: false });
		const inverted = dcsValid(rotl(~w & MASK23, r));
		if (inverted >= 0) found.push({ code: inverted, inv: true });
	}
	if (!found.length) return null;
	found.sort((a, b) => a.code - b.code || Number(a.inv) - Number(b.inv));
	// best: the normal polarity first, then a code of the standard list, then the lowest code
	let best = 0;
	let bs = -1;
	found.forEach((c, i) => {
		const s = (c.inv ? 0 : 2) + (dcsStandard(c.code) ? 1 : 0);
		if (s > bs) {
			bs = s;
			best = i;
		}
	});
	const hit: DcsHit = {
		code: found[best].code,
		inverted: found[best].inv,
		standard: dcsStandard(found[best].code),
		aliasCode: -1,
		aliasInverted: false,
	};
	found.forEach((c, i) => {
		if (i === best || !dcsStandard(c.code)) return;
		if (hit.aliasCode < 0 || (!c.inv && hit.aliasInverted)) {
			hit.aliasCode = c.code;
			hit.aliasInverted = c.inv;
		}
	});
	return hit;
}

/** "D023N". */
export const dcsName = (code: number, inverted: boolean): string => `D${String(code).padStart(3, '0')}${inverted ? 'I' : 'N'}`;

// ---- DTMF
export const DTMF_ROWS: readonly number[] = [697, 770, 852, 941];
export const DTMF_COLS: readonly number[] = [1209, 1336, 1477, 1633];
export const DTMF_KEYS = '123A456B789C*0#D';

/** dtmf_numbers.h: a group ending in '#' is a complete code, one starting with '*' a feature / access code, 7 digits and more a number. */
export function dtmfKind(keys: string): 'code' | 'star' | 'number' | 'short' {
	const digits = keys.replace(/[^0-9]/g, '').length;
	return keys.endsWith('#') ? 'code' : keys.startsWith('*') ? 'star' : digits >= 7 ? 'number' : 'short';
}

// ---- five-tone sequential calling
export const SEQ_SETS: readonly SeqSet[] = [
	{ id: 'zvei1', name: 'ZVEI1 / PZVEI', digit: [2400, 1060, 1160, 1270, 1400, 1530, 1670, 1830, 2000, 2200], rep: 2600, toneMs: 70 },
	{ id: 'zvei2', name: 'ZVEI2 / ZVEI3', digit: [2400, 1060, 1160, 1270, 1400, 1530, 1670, 1830, 2000, 2200], rep: 970, toneMs: 70 },
	{ id: 'ccir', name: 'CCIR', digit: [1981, 1124, 1197, 1275, 1358, 1446, 1540, 1640, 1747, 1860], rep: 2110, toneMs: 100 },
	{ id: 'eea', name: 'EEA', digit: [1981, 1124, 1197, 1275, 1358, 1446, 1540, 1640, 1747, 1860], rep: 2110, toneMs: 40 },
	{ id: 'eia', name: 'EIA', digit: [600, 741, 882, 1023, 1164, 1305, 1446, 1587, 1728, 1869], rep: 459, toneMs: 33 },
	{ id: 'dzvei', name: 'DZVEI', digit: [2200, 970, 1060, 1160, 1270, 1400, 1530, 1670, 1830, 2000], rep: 2400, toneMs: 70 },
];

/** Every distinct tone of all sets, ascending. */
export const SEQ_POOL: readonly number[] = [...new Set(SEQ_SETS.flatMap((set) => [...set.digit, set.rep]))].sort((a, b) => a - b);

// ---- SELCAL (aviation): 16 tones, two pairs of two tones, each pair 1 s, 0.2 s apart
const SELCAL_HZ = [312.6, 346.7, 384.6, 426.6, 473.2, 524.8, 582.1, 645.7, 716.1, 794.3, 881.0, 977.2, 1083.9, 1202.3, 1333.5, 1479.1];
const SELCAL_LETTERS = 'ABCDEFGHJKLMPQRS';
export const SELCAL_N = SELCAL_HZ.length;
/** idx 0 .. 15 for the letters A B C D E F G H J K L M P Q R S. */
export const selcalHz = (idx: number): number => SELCAL_HZ[Math.max(0, Math.min(SELCAL_N - 1, idx))];
export const selcalLetter = (idx: number): string => SELCAL_LETTERS[Math.max(0, Math.min(SELCAL_N - 1, idx))];
export const selcalIndex = (letter: string): number => Math.max(0, SELCAL_LETTERS.indexOf(letter));
