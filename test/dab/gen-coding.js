// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir core/src/dab/dab_gen_coding.cpp (the test transmitter's channel
// coding, written there from EN 300 401 clauses 10 and 11 and TS 102 563 without the receiver's dab_fec.cpp: prbs,
// scramble, crc16, fireCode, rsEncode, convEncode, the puncturing vectors, punctureFic, eepSize, punctureEep),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: crc16 is written out (OnAir calls its common CRC).

/** The first n bits of the energy dispersal sequence: p(n) = p(n-5) xor p(n-9), the bits before the first count as 1. */
export function prbs(n) {
	const bits = new Uint8Array(n);
	for (let i = 0; i < n; i++) bits[i] = (i >= 5 ? bits[i - 5] : 1) ^ (i >= 9 ? bits[i - 9] : 1);
	return bits;
}

const SEQ = prbs(511);

/** Modulo 2 addition of the energy dispersal sequence, one bit per byte, in place. */
export function scramble(bits, n = bits.length) {
	for (let i = 0; i < n; i++) bits[i] ^= SEQ[i % 511];
}

/** CRC-CCITT x^16 + x^12 + x^5 + 1, register all ones, result inverted (FIB, access units, PAD). */
export function crc16(d, n = d.length) {
	let reg = 0xffff;
	for (let i = 0; i < n; i++)
		for (let b = 7; b >= 0; b--) {
			const fb = ((reg >> 15) & 1) ^ ((d[i] >> b) & 1);
			reg = (reg << 1) & 0xffff;
			if (fb) reg ^= 0x1021;
		}
	return ~reg & 0xffff;
}

/** g(x) = (x^11 + 1)(x^5 + x^3 + x^2 + x + 1): x^16 + x^14 + x^13 + x^12 + x^11 + x^5 + x^3 + x^2 + x + 1. */
export function fireCode(d, n) {
	const low = (1 << 14) | (1 << 13) | (1 << 12) | (1 << 11) | (1 << 5) | (1 << 3) | (1 << 2) | (1 << 1) | 1;
	let reg = 0;
	for (let i = 0; i < n; i++)
		for (let b = 7; b >= 0; b--) {
			const fb = ((reg >> 15) & 1) ^ ((d[i] >> b) & 1);
			reg = (reg << 1) & 0xffff;
			if (fb) reg ^= low;
		}
	return reg;
}

// Reed-Solomon (120,110): g(x) = prod_{i=0..9} (x + alpha^i) over GF(2^8), p(x) = x^8 + x^4 + x^3 + x^2 + 1
const EXP = new Uint8Array(255);
const LOG = new Int32Array(256);
for (let i = 0, x = 1; i < 255; i++) {
	EXP[i] = x;
	LOG[x] = i;
	x <<= 1;
	if (x & 0x100) x ^= 0x11d;
}
const mul = (a, b) => (a && b ? EXP[(LOG[a] + LOG[b]) % 255] : 0);
const G = new Uint8Array(11);
G[0] = 1;
for (let r = 0, deg = 0; r < 10; r++, deg++) for (let i = deg + 1; i >= 0; i--) G[i] = (i ? G[i - 1] : 0) ^ mul(G[i], EXP[r]);

/** Systematic RS(120,110): the 110 data bytes, then the remainder of data(x) x^10 modulo g(x). */
export function rsEncode(data, cw) {
	const rem = new Uint8Array(10);
	for (let i = 0; i < 110; i++) {
		cw[i] = data[i];
		const fb = data[i] ^ rem[0];
		for (let j = 0; j < 9; j++) rem[j] = rem[j + 1] ^ mul(fb, G[9 - j]);
		rem[9] = mul(fb, G[0]);
	}
	cw.set(rem, 110);
}

/** Rate 1/4, K = 7, generators 133 171 145 133 (octal): 4 * (n + 6) bits with the tail. */
export function convEncode(bits, n) {
	const delays = [
		[0, 2, 3, 5, 6],
		[0, 1, 2, 3, 6],
		[0, 1, 4, 6],
		[0, 2, 3, 5, 6],
	];
	const mother = new Uint8Array(4 * (n + 6));
	for (let i = 0; i < n + 6; i++)
		for (let k = 0; k < 4; k++) {
			let v = 0;
			for (const d of delays[k]) {
				const j = i - d;
				if (j >= 0 && j < n) v ^= bits[j] & 1;
			}
			mother[4 * i + k] = v;
		}
	return mother;
}

// prettier-ignore
const PI = [
	'11001000100010001000100010001000', '11001000100010001100100010001000', '11001000110010001100100010001000', '11001000110010001100100011001000',
	'11001100110010001100100011001000', '11001100110010001100110011001000', '11001100110011001100110011001000', '11001100110011001100110011001100',
	'11101100110011001100110011001100', '11101100110011001110110011001100', '11101100111011001110110011001100', '11101100111011001110110011101100',
	'11101110111011001110110011101100', '11101110111011001110111011101100', '11101110111011101110111011101100', '11101110111011101110111011101110',
	'11111110111011101110111011101110', '11111110111011101111111011101110', '11111110111111101111111011101110', '11111110111111101111111011111110',
	'11111111111111101111111011111110', '11111111111111101111111111111110', '11111111111111111111111111111110', '11111111111111111111111111111111',
];

/** 128-bit blocks of the mother code word with their puncturing index, then the 24 tail bits. */
function puncture(mother, runs) {
	const tail = '110011001100110011001100';
	const out = [];
	let pos = 0;
	for (const [blocks, pi] of runs)
		for (let b = 0; b < blocks; b++)
			for (let sub = 0; sub < 4; sub++) for (let i = 0; i < 32; i++, pos++) if (PI[pi - 1][i] === '1') out.push(mother[pos]);
	for (let i = 0; i < 24; i++, pos++) if (tail[i] === '1') out.push(mother[pos]);
	return Uint8Array.from(out);
}

/** The FIC: PI = 16 for the first 21 blocks, PI = 15 for the last 3 (3096 bits to 2304). */
export const punctureFic = (mother) =>
	puncture(mother, [
		[21, 16],
		[3, 15],
	]);

/** Capacity units of an EEP sub-channel (option 0 = A, 1 = B; level 0..3); 0 when the combination is not allowed. */
export function eepSize(bitrate, option, level) {
	if (level < 0 || level > 3) return 0;
	if (option === 0) {
		if (bitrate <= 0 || bitrate % 8) return 0;
		const n = bitrate / 8;
		if (level === 1 && n < 2) return 0;
		return [12, 8, 6, 4][level] * n;
	}
	if (option === 1 && bitrate > 0 && bitrate % 32 === 0) return [27, 21, 18, 15][level] * (bitrate / 32);
	return 0;
}

/** EEP puncturing (tables 18 and 20): the bits sent, or null when they do not fill the sub-channel. */
export function punctureEep(mother, bitrate, option, level) {
	const size = eepSize(bitrate, option, level);
	if (!size) return null;
	let runs;
	if (option === 0) {
		const n = bitrate / 8;
		runs = [
			[[6 * n - 3, 24], [3, 23]],
			[[2 * n - 3, 14], [4 * n + 3, 13]],
			[[6 * n - 3, 8], [3, 7]],
			[[4 * n - 3, 3], [2 * n + 3, 2]],
		][level]; // prettier-ignore
	} else {
		const n = bitrate / 32,
			pi1 = [10, 6, 4, 2][level];
		runs = [
			[24 * n - 3, pi1],
			[3, pi1 - 1],
		];
	}
	const out = puncture(mother, runs);
	return out.length === size * 64 ? out : null;
}
