// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/marine/marine_navtex.cpp and marine_navtex.h (CCIR 476 code,
// subject names, text encoder and SITOR-B slots), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: characters are strings ('' where the C++ code has 0).

// Service signals of the CCIR 476 code (7 bits, four of them mark, first bit sent = least significant bit of the value,
// as fldigi navtex.cxx reads them; alpha 0x0F goes out as BBBBYYY).
export const ALPHA = 0x0f;
export const BETA = 0x33;
export const REP = 0x66;
export const LTRS = 0x5a;
export const FIGS = 0x36;
export const SPARE = 0x6a;
export const SPACE = 0x5c;
export const CR = 0x78;
export const LF = 0x6c;

// Code words, letter set and figure set. The 35 words with four marks: 32 characters and shifts, plus alpha, beta and
// the repeat signal. Source: ITU-R M.476 / M.625 code table as published by fldigi (src/navtex/navtex.cxx,
// code_to_ltrs / code_to_figs); where the national variants differ (J, S, V, Z in the figure set) the international
// alphabet no. 2 is used. '' in the figure column = bell.
const ROWS: ReadonlyArray<readonly [number, string, string]> = [
	[0x17, 'J', ''],
	[0x1b, 'F', '!'],
	[0x1d, 'C', ':'],
	[0x1e, 'K', '('],
	[0x27, 'W', '2'],
	[0x2b, 'Y', '6'],
	[0x2d, 'P', '0'],
	[0x2e, 'Q', '1'],
	[0x35, 'G', '&'],
	[0x39, 'M', '.'],
	[0x3a, 'X', '/'],
	[0x3c, 'V', '='],
	[0x47, 'A', '-'],
	[0x4b, 'S', "'"],
	[0x4d, 'I', '8'],
	[0x4e, 'U', '7'],
	[0x53, 'D', '$'],
	[0x55, 'R', '4'],
	[0x56, 'E', '3'],
	[0x59, 'N', ','],
	[0x5c, ' ', ' '],
	[0x63, 'Z', '+'],
	[0x65, 'L', ')'],
	[0x69, 'H', '#'],
	[0x6c, '\n', '\n'],
	[0x71, 'O', '9'],
	[0x72, 'B', '?'],
	[0x74, 'T', '5'],
	[0x78, '\r', '\r'],
];

const LETTERS: string[] = new Array<string>(128).fill('');
const FIGURES: string[] = new Array<string>(128).fill('');
for (const [code, ltr, fig] of ROWS) {
	LETTERS[code] = ltr;
	FIGURES[code] = fig;
}

export function popcount7(v: number): number {
	let n = 0;
	for (let x = v & 0x7f; x; x &= x - 1) n++;
	return n;
}

export const isControl = (c: number): boolean => c === ALPHA || c === BETA || c === REP || c === LTRS || c === FIGS || c === SPARE;

/** 7 bits with exactly four set. */
export const ccir476Valid = (code: number): boolean => code >= 0 && code < 128 && popcount7(code) === 4;

/** The character of a code word in the letter or figure set; '' for service signals and the bell (not LTRS / FIGS). */
export function ccir476Char(code: number, figs: boolean): string {
	if (code < 0 || code >= 128) return '';
	return figs ? FIGURES[code] : LETTERS[code];
}

/** The code word of a character in the letter or figure set; -1 when the set has no such character. */
export function ccir476Code(ch: string, figs: boolean): number {
	const c = ch.toUpperCase();
	for (const [code, ltr, fig] of ROWS) {
		if (!figs && ltr === c && c !== '') return code;
		if (figs && fig === c && c !== '') return code;
	}
	return -1;
}

const SUBJECTS: Record<string, string> = {
	A: 'Navigational warning',
	B: 'Meteorological warning',
	C: 'Ice report',
	D: 'Search and rescue information, piracy warning',
	E: 'Meteorological forecast',
	F: 'Pilot service message',
	G: 'AIS message',
	H: 'LORAN message',
	I: 'Spare',
	J: 'Satellite navigation system message',
	K: 'Other electronic navaid message',
	L: 'Navigational warning (additional to A)',
	V: 'Special service',
	W: 'Special service',
	X: 'Special service',
	Y: 'Special service',
	Z: 'No messages on hand',
};

/** ITU-R M.540 / IMO NAVTEX Manual, subject indicator characters. */
export const navtexSubjectName = (b2: string): string => SUBJECTS[b2] ?? 'Unknown';

/** Text -> code words, with LTRS/FIGS shifts where the set changes; the shift is restated after every line feed. */
export function navtexEncode(text: string): number[] {
	const out = [LTRS];
	let figs = false;
	for (const c0 of text) {
		const c = c0.toUpperCase();
		if (c === '\n') {
			out.push(CR, LF, figs ? FIGS : LTRS);
			continue;
		}
		if (c === '\r') continue;
		if (c === ' ' || c === '\t') {
			out.push(SPACE);
			continue;
		}
		if (c >= 'A' && c <= 'Z') {
			if (figs) {
				out.push(LTRS);
				figs = false;
			}
			const code = ccir476Code(c, false);
			if (code >= 0) out.push(code);
			continue;
		}
		const code = ccir476Code(c, true);
		if (code < 0) continue;
		if (!figs) {
			out.push(FIGS);
			figs = true;
		}
		out.push(code);
	}
	return out;
}

/**
 * FEC mode B on the air: tokens are DX characters (a code, or -1 for the idle signal). Result: 7-bit codes in
 * transmission order, DX at even places, the retransmission (5 places later) at odd places, alpha where there is
 * nothing to retransmit.
 */
export function sitorBSlots(tokens: readonly number[]): number[] {
	const n = tokens.length + 2; // the last retransmissions come two DX places after the last DX
	const out = new Array<number>(2 * n);
	for (let j = 0; j < n; j++) {
		out[2 * j] = j < tokens.length && tokens[j] >= 0 ? tokens[j] : BETA;
		out[2 * j + 1] = j >= 2 && tokens[j - 2] >= 0 ? tokens[j - 2] : ALPHA;
	}
	return out;
}

/** Least significant bit first (fldigi navtex.cxx bytes_to_code), one bit per entry. */
export function codesToBits(codes: readonly number[]): number[] {
	const bits: number[] = [];
	for (const c of codes) for (let i = 0; i < 7; i++) bits.push((c >> i) & 1);
	return bits;
}
