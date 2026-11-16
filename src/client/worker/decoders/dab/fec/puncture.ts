// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/dab/dab_fec.cpp (piVector, forEachKept, ficDepuncture,
// eepGeometry, eepDepuncture, uepGeometry and table 6, uepDepuncture and the puncturing directions),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: the mother-code positions that survive a puncturing
// profile are listed once into an Int32Array and cached per profile, so a depuncture is a single scatter.

import { CU_BITS } from '@/worker/decoders/dab/constants';
import type { EepGeometry, PunctureBlock, SubchannelProfile, UepGeometry, UepRow } from './types';

// puncturing vectors PI_1 .. PI_24 (EN 300 401 table 13): 32 positions = 8 groups of 4 code bits
const PI_STRINGS = [
	'',
	'11001000100010001000100010001000',
	'11001000100010001100100010001000',
	'11001000110010001100100010001000',
	'11001000110010001100100011001000',
	'11001100110010001100100011001000',
	'11001100110010001100110011001000',
	'11001100110011001100110011001000',
	'11001100110011001100110011001100',
	'11101100110011001100110011001100',
	'11101100110011001110110011001100',
	'11101100111011001110110011001100',
	'11101100111011001110110011101100',
	'11101110111011001110110011101100',
	'11101110111011001110111011101100',
	'11101110111011101110111011101100',
	'11101110111011101110111011101110',
	'11111110111011101110111011101110',
	'11111110111011101111111011101110',
	'11111110111111101111111011101110',
	'11111110111111101111111011111110',
	'11111111111111101111111011111110',
	'11111111111111101111111111111110',
	'11111111111111111111111111111110',
	'11111111111111111111111111111111',
];
const PI = PI_STRINGS.map((s) => Uint8Array.from(s, (ch) => (ch === '1' ? 1 : 0)));
/** PI_X, the puncturing of the 24 tail bits. */
const PI_X = Uint8Array.from('110011001100110011001100', (ch) => (ch === '1' ? 1 : 0));

/** The mother-code positions that survive puncturing, in order; null when they do not end at motherLen. */
function keptPositions(blocks: PunctureBlock[], motherLen: number): Int32Array | null {
	const out: number[] = [];
	let pos = 0;
	for (const b of blocks)
		for (let c = 0; c < b.count; c++) {
			const v = PI[b.pi];
			for (let rep = 0; rep < 4; rep++) for (let j = 0; j < 32; j++, pos++) if (v[j]) out.push(pos);
		}
	for (let j = 0; j < 24; j++, pos++) if (PI_X[j]) out.push(pos);
	return pos === motherLen ? Int32Array.from(out) : null;
}

/** The FIC: 21 blocks of PI_16 and 3 of PI_15 (EN 300 401 clause 11.2.1), 3096 mother bits to 2304. */
export const FIC_MOTHER = 3096;
export const FIC_PUNCTURED = 2304;
const FIC_KEPT = keptPositions(
	[
		{ count: 21, pi: 16 },
		{ count: 3, pi: 15 },
	],
	FIC_MOTHER,
) as Int32Array;

/** 2304 received soft bits of one FIC code word into the 3096 mother-code values (0 = punctured). */
export function ficDepuncture(rx: Int8Array, from: number, mother: Int8Array): void {
	mother.fill(0, 0, FIC_MOTHER);
	for (let k = 0; k < FIC_PUNCTURED; k++) mother[FIC_KEPT[k]] = rx[from + k];
}

/** The other direction (the test transmitter): 3096 mother bits to the 2304 sent. */
export function ficPuncture(mother: Uint8Array, out: Uint8Array): void {
	for (let k = 0; k < FIC_PUNCTURED; k++) out[k] = mother[FIC_KEPT[k]];
}

function eepBlocks(option: number, level: number, n: number): PunctureBlock[] | null {
	if (level < 0 || level > 3 || n < 1) return null;
	if (option === 1) {
		const pi1 = [10, 6, 4, 2][level];
		return [
			{ count: 24 * n - 3, pi: pi1 },
			{ count: 3, pi: pi1 - 1 },
		];
	}
	if (level === 1 && n < 2) return null; // 2-A needs at least 2 x 8 CUs
	// tables 17: L1 / PI1 and L2 / PI2 of the A profiles by protection level
	const [l1, p1, l2, p2] = [
		[6 * n - 3, 24, 3, 23],
		[2 * n - 3, 14, 4 * n + 3, 13],
		[6 * n - 3, 8, 3, 7],
		[4 * n - 3, 3, 2 * n + 3, 2],
	][level];
	return [
		{ count: l1, pi: p1 },
		{ count: l2, pi: p2 },
	];
}

/** EEP sub-channel protection (EN 300 401 tables 15 to 20): null when size, option and level form no valid profile. */
export function eepGeometry(size: number, option: number, level: number): EepGeometry | null {
	if (level < 0 || level > 3 || (option !== 0 && option !== 1)) return null;
	const unit = option === 0 ? [12, 8, 6, 4][level] : [27, 21, 18, 15][level];
	if (size <= 0 || size % unit) return null;
	const n = size / unit;
	if (!eepBlocks(option, level, n)) return null;
	const bitrate = (option === 0 ? 8 : 32) * n;
	return { n, bitrate, infoBits: bitrate * 24 };
}

// UEP (short form, EN 300 401 table 6): size in CUs, bitrate, protection level, L1..L4 and PI1..PI4
// prettier-ignore
const UEP: readonly UepRow[] = [
	[16, 32, 5, [3, 4, 17, 0], [5, 3, 2, 0]], [21, 32, 4, [3, 3, 18, 0], [11, 6, 5, 0]], [24, 32, 3, [3, 4, 14, 3], [15, 9, 6, 8]],
	[29, 32, 2, [3, 4, 14, 3], [22, 13, 8, 13]], [35, 32, 1, [3, 5, 13, 3], [24, 17, 12, 17]],
	[24, 48, 5, [4, 3, 26, 3], [5, 4, 2, 3]], [29, 48, 4, [3, 4, 26, 3], [9, 6, 4, 6]], [35, 48, 3, [3, 4, 26, 3], [15, 10, 6, 9]],
	[42, 48, 2, [3, 4, 26, 3], [24, 14, 8, 15]], [52, 48, 1, [3, 5, 25, 3], [24, 18, 13, 18]],
	[29, 56, 5, [6, 10, 23, 3], [5, 4, 2, 3]], [35, 56, 4, [6, 10, 23, 3], [9, 6, 4, 5]], [42, 56, 3, [6, 12, 21, 3], [16, 7, 6, 9]],
	[52, 56, 2, [6, 10, 23, 3], [23, 13, 8, 13]],
	[32, 64, 5, [6, 9, 31, 2], [5, 3, 2, 3]], [42, 64, 4, [6, 9, 33, 0], [11, 6, 5, 0]], [48, 64, 3, [6, 12, 27, 3], [16, 8, 6, 9]],
	[58, 64, 2, [6, 10, 29, 3], [23, 13, 8, 13]], [70, 64, 1, [6, 11, 28, 3], [24, 18, 12, 18]],
	[40, 80, 5, [6, 10, 41, 3], [6, 3, 2, 3]], [52, 80, 4, [6, 10, 41, 3], [11, 6, 5, 6]], [58, 80, 3, [6, 11, 40, 3], [16, 8, 6, 7]],
	[70, 80, 2, [6, 10, 41, 3], [23, 13, 8, 13]], [84, 80, 1, [6, 10, 41, 3], [24, 17, 12, 18]],
	[48, 96, 5, [7, 9, 53, 3], [5, 4, 2, 4]], [58, 96, 4, [7, 10, 52, 3], [9, 6, 4, 6]], [70, 96, 3, [6, 12, 51, 3], [16, 9, 6, 10]],
	[84, 96, 2, [6, 10, 53, 3], [22, 12, 9, 12]], [104, 96, 1, [6, 13, 50, 3], [24, 18, 13, 19]],
	[58, 112, 5, [14, 17, 50, 3], [5, 4, 2, 5]], [70, 112, 4, [11, 21, 49, 3], [9, 6, 4, 8]], [84, 112, 3, [11, 23, 47, 3], [16, 8, 6, 9]],
	[104, 112, 2, [11, 21, 49, 3], [23, 12, 9, 14]],
	[64, 128, 5, [12, 19, 62, 3], [5, 3, 2, 4]], [84, 128, 4, [11, 21, 61, 3], [11, 6, 5, 7]], [96, 128, 3, [11, 22, 60, 3], [16, 9, 6, 10]],
	[116, 128, 2, [11, 21, 61, 3], [22, 12, 9, 14]], [140, 128, 1, [11, 20, 62, 3], [24, 17, 13, 19]],
	[80, 160, 5, [11, 19, 87, 3], [5, 4, 2, 4]], [104, 160, 4, [11, 23, 83, 3], [11, 6, 5, 9]], [116, 160, 3, [11, 24, 82, 3], [16, 8, 6, 11]],
	[140, 160, 2, [11, 21, 85, 3], [22, 11, 9, 13]], [168, 160, 1, [11, 22, 84, 3], [24, 18, 12, 19]],
	[96, 192, 5, [11, 20, 110, 3], [6, 4, 2, 5]], [116, 192, 4, [11, 22, 108, 3], [10, 6, 4, 9]], [140, 192, 3, [11, 24, 106, 3], [16, 10, 6, 11]],
	[168, 192, 2, [11, 20, 110, 3], [22, 13, 9, 13]], [208, 192, 1, [11, 21, 109, 3], [24, 20, 13, 24]],
	[116, 224, 5, [12, 22, 131, 3], [8, 6, 2, 6]], [140, 224, 4, [12, 26, 127, 3], [12, 8, 4, 11]], [168, 224, 3, [11, 20, 134, 3], [16, 10, 7, 9]],
	[208, 224, 2, [11, 22, 132, 3], [24, 16, 10, 15]], [232, 224, 1, [11, 24, 130, 3], [24, 20, 12, 20]],
	[128, 256, 5, [11, 24, 154, 3], [6, 5, 2, 5]], [168, 256, 4, [11, 24, 154, 3], [12, 9, 5, 10]], [192, 256, 3, [11, 27, 151, 3], [16, 10, 7, 10]],
	[232, 256, 2, [11, 22, 156, 3], [24, 14, 10, 13]], [280, 256, 1, [11, 26, 152, 3], [24, 19, 14, 18]],
	[160, 320, 5, [11, 26, 200, 3], [8, 5, 2, 6]], [208, 320, 4, [11, 25, 201, 3], [13, 9, 5, 10]], [280, 320, 2, [11, 26, 200, 3], [24, 17, 9, 17]],
	[192, 384, 5, [11, 27, 247, 3], [8, 6, 2, 7]], [280, 384, 3, [11, 24, 250, 3], [16, 9, 7, 10]], [416, 384, 1, [12, 28, 245, 3], [24, 20, 14, 23]],
];

/** UEP sub-channel (short form, table 6 index 0..63); null beyond the table. */
export function uepGeometry(index: number): UepGeometry | null {
	const r = UEP[index];
	if (!r) return null;
	return { size: r[0], bitrate: r[1], level: r[2], infoBits: r[1] * 24 };
}

function uepBlocks(index: number): PunctureBlock[] {
	const [, , , l, pi] = UEP[index];
	const out: PunctureBlock[] = [];
	for (let i = 0; i < 4; i++) if (l[i] > 0) out.push({ count: l[i], pi: pi[i] });
	return out;
}

const profiles = new Map<string, SubchannelProfile | null>();

/**
 * The profile of an EEP (eep = true: size, option, level) or UEP (uepIndex) sub-channel, cached; null when the
 * protection does not fill the sub-channel (EEP exactly, UEP with fewer than 64 padding bits).
 */
export function subchannelProfile(eep: boolean, size: number, option: number, level: number, uepIndex: number): SubchannelProfile | null {
	const key = eep ? `e${size}/${option}/${level}` : `u${uepIndex}`;
	const known = profiles.get(key);
	if (known !== undefined) return known;
	let profile: SubchannelProfile | null = null;
	if (eep) {
		const g = eepGeometry(size, option, level);
		const blocks = g && eepBlocks(option, level, g.n);
		const kept = g && blocks ? keptPositions(blocks, 4 * (g.infoBits + 6)) : null;
		if (g && kept && kept.length === size * CU_BITS) profile = { kept, infoBits: g.infoBits, bits: size * CU_BITS };
	} else {
		const g = uepGeometry(uepIndex);
		const kept = g ? keptPositions(uepBlocks(uepIndex), 4 * (g.infoBits + 6)) : null;
		const have = g ? g.size * CU_BITS : 0;
		if (g && kept && have - kept.length >= 0 && have - kept.length < 64) profile = { kept, infoBits: g.infoBits, bits: have };
	}
	profiles.set(key, profile);
	return profile;
}

/** The received soft bits of one logical frame into the mother code word (0 = punctured; padding is ignored). */
export function depuncture(profile: SubchannelProfile, rx: Int8Array, mother: Int8Array): void {
	const kept = profile.kept;
	mother.fill(0, 0, 4 * (profile.infoBits + 6));
	for (let k = 0; k < kept.length; k++) mother[kept[k]] = rx[k];
}

/** The other direction (the test transmitter): the bits sent of a mother code word, padding bits 0. */
export function puncture(profile: SubchannelProfile, mother: Uint8Array, out: Uint8Array): void {
	const kept = profile.kept;
	out.fill(0, 0, profile.bits);
	for (let k = 0; k < kept.length; k++) out[k] = mother[kept[k]];
}
