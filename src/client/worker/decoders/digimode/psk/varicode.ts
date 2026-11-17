// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/psk/psk_varicode.cpp (the PSK31 varicode, VaricodeRx, the QPSK
// convolutional code K = 5 and its soft-decision Viterbi decoder, the QPSK phase mapping) and
// core/include/dect2/psk/psk_varicode.h, https://github.com/adswill/OnAir; see third_party/onair. OnAir credits
// P. Martinez G3PLX, "PSK31: A New Radio-Teletype Mode", RadCom 1998, and fldigi (W1HKJ et al.) for the table and the
// mapping, which it re-implemented. Changes: the 8PSK pieces (MFSK varicode, psk8Steps) are not ported.

/** G3PLX's varicode of ASCII 0 .. 127: no "00" inside a code, which starts and ends with a one. */
const VARICODE = (
	'1010101011 1011011011 1011101101 1101110111 1011101011 1101011111 1011101111 1011111101 ' +
	'1011111111 11101111 11101 1101101111 1011011101 11111 1101110101 1110101011 ' +
	'1011110111 1011110101 1110101101 1110101111 1101011011 1101101011 1101101101 1101010111 ' +
	'1101111011 1101111101 1110110111 1101010101 1101011101 1110111011 1011111011 1101111111 ' +
	'1 111111111 101011111 111110101 111011011 1011010101 1010111011 101111111 ' +
	'11111011 11110111 101101111 111011111 1110101 110101 1010111 110101111 ' +
	'10110111 10111101 11101101 11111111 101110111 101011011 101101011 110101101 ' +
	'110101011 110110111 11110101 110111101 111101101 1010101 111010111 1010101111 ' +
	'1010111101 1111101 11101011 10101101 10110101 1110111 11011011 11111101 ' +
	'101010101 1111111 111111101 101111101 11010111 10111011 11011101 10101011 ' +
	'11010101 111011101 10101111 1101111 1101101 101010111 110110101 101011101 ' +
	'101110101 101111011 1010101101 111110111 111101111 111111011 1010111111 101101101 ' +
	'1011011111 1011 1011111 101111 101101 11 111101 1011011 ' +
	'101011 1101 111101011 10111111 11011 111011 1111 111 ' +
	'111111 110111111 10101 10111 101 110111 1111011 1101011 ' +
	'11011111 1011101 111010101 1010110111 110111011 1010110101 1011010111 1110110101'
).split(' ');

/** The code as a number -> the character. */
const CODES = new Map(VARICODE.map((code, c) => [parseInt(code, 2), c]));

/** Parity of the set bits. */
export function parity(v: number): number {
	let p = 0;
	for (let x = v >>> 0; x; x &= x - 1) p ^= 1;
	return p;
}

/** The varicode of an ASCII character (0 .. 127), '' otherwise. */
export const varicode = (c: number): string => VARICODE[c] ?? '';

/** Text -> the bits sent (each character's code and two zeros); characters above 127 are skipped. */
export function varicodeBits(text: string): number[] {
	const bits: number[] = [];
	for (const ch of text) {
		const code = VARICODE[ch.charCodeAt(0)];
		if (code === undefined) continue;
		for (const b of code) bits.push(b === '1' ? 1 : 0);
		bits.push(0, 0);
	}
	return bits;
}

/** Bit by bit: a character comes out after the two zeros that end it (-1 none yet, -2 a code not in the table). */
export class VaricodeRx {
	private sh = 0;
	private n = 0;

	bit(b: number): number {
		this.sh = ((this.sh << 1) | (b & 1)) >>> 0;
		if (++this.n > 24) this.n = 24;
		if ((this.sh & 3) !== 0) return -1;
		// two zeros: the bits before them are a character (or nothing, between idle zeros)
		const code = this.sh >>> 2;
		const len = this.n - 2;
		this.sh = this.n = 0;
		if (code === 0 || len <= 0) return -1;
		if (len > 12) return -2;
		return CODES.get(code) ?? -2;
	}

	reset(): void {
		this.sh = this.n = 0;
	}
}

/** QPSK: one bit in, a 2-bit symbol out: bit 0 = parity(register & 0x17), bit 1 = parity(register & 0x19). */
export class ConvEncoder {
	private sh = 0;

	encode(bit: number): number {
		this.sh = ((this.sh << 1) | (bit & 1)) & 0x1f;
		return parity(this.sh & 0x17) | (parity(this.sh & 0x19) << 1);
	}
}

/** The two code bits of each (previous state, input) transition into each of the 16 states. */
const BRANCH = (() => {
	const t = new Uint8Array(16 * 2 * 2);
	for (let ns = 0; ns < 16; ns++)
		for (let x = 0; x < 2; x++) {
			const ps = (ns >> 1) | (x << 3);
			const reg = ((ps << 1) | (ns & 1)) & 0x1f;
			t[4 * ns + 2 * x] = parity(reg & 0x17);
			t[4 * ns + 2 * x + 1] = parity(reg & 0x19);
		}
	return t;
})();

/** Soft decision Viterbi decoder for that code: each symbol's two soft values (> 0 means 1), a bit out after DEPTH. */
export class Viterbi {
	static readonly DEPTH = 40;
	private readonly metric = new Float64Array(16);
	private readonly next = new Float64Array(16);
	private readonly hist = new Uint16Array(Viterbi.DEPTH);
	private pos = 0;
	private filled = 0;

	reset(): void {
		this.metric.fill(0);
		this.hist.fill(0);
		this.pos = this.filled = 0;
	}

	/** -1 until the traceback is filled. */
	decode(s0: number, s1: number): number {
		const { metric, next } = this;
		let dec = 0;
		for (let ns = 0; ns < 16; ns++) {
			let best = -1e30;
			let bx = 0;
			for (let x = 0; x < 2; x++) {
				const ps = (ns >> 1) | (x << 3);
				const m = metric[ps] + (BRANCH[4 * ns + 2 * x] ? s0 : -s0) + (BRANCH[4 * ns + 2 * x + 1] ? s1 : -s1);
				if (m > best) [best, bx] = [m, x];
			}
			next[ns] = best;
			if (bx) dec |= 1 << ns;
		}
		let top = -1e30;
		let bs = 0;
		for (let s = 0; s < 16; s++) if (next[s] > top) [top, bs] = [next[s], s];
		for (let s = 0; s < 16; s++) metric[s] = next[s] - top; // keep them small
		const depth = Viterbi.DEPTH;
		this.hist[this.pos] = dec;
		this.pos = (this.pos + 1) % depth;
		if (this.filled < depth && ++this.filled < depth) return -1;
		let s = bs;
		let out = 0;
		for (let k = 1; k <= depth; k++) {
			const d = this.hist[(this.pos - k + 2 * depth) % depth];
			out = s & 1;
			s = (s >> 1) | (((d >> s) & 1) << 3);
		}
		return out;
	}
}

/** QPSK phase change (0 .. 3 quarter turns, counter-clockwise) for a symbol, and back (fldigi's mapping). */
export const qpskTurns = (sym: number): number => (2 - sym) & 3;
export const qpskSymbol = (turns: number): number => (2 - turns) & 3;
