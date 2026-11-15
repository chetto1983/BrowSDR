/*
 * DMR Full Link Control from Voice LC Header and Terminator with LC data bursts (ETSI TS 102 361-1):
 * slot type (colour code, data type), BPTC(196,96) deinterleaving and data extraction, then the
 * RS(12,9) check with the header or terminator CRC mask. Only addressing metadata is returned.
 */
import type { DmrLinkControl } from './types';

const DATA_TYPE_VOICE_HEADER = 1;
const DATA_TYPE_TERMINATOR = 2;
/** Slot type data type of idle bursts, which a repeater sends between calls. */
export const DMR_IDLE = 9;
const MASKS: Record<number, number> = { [DATA_TYPE_VOICE_HEADER]: 0x96, [DATA_TYPE_TERMINATOR]: 0x99 };

// ── GF(256) with x^8 + x^4 + x^3 + x^2 + 1 ──────────────────────────
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
	let x = 1;
	for (let i = 0; i < 255; i++) {
		EXP[i] = x;
		LOG[x] = i;
		x <<= 1;
		if (x & 0x100) x ^= 0x11d;
	}
	for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const gmul = (a: number, b: number) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
/** RS(12,9) generator coefficients, lowest degree first. */
const RS_POLY = [64, 56, 14, 1];

/** RS(12,9) parity of nine LC bytes, in transmitted order. */
export function rs129Parity(data: ArrayLike<number>): [number, number, number] {
	const parity = [0, 0, 0, 0];
	for (let i = 0; i < 9; i++) {
		const feedback = data[i] ^ parity[2];
		for (let j = 2; j > 0; j--) parity[j] = parity[j - 1] ^ gmul(RS_POLY[j], feedback);
		parity[0] = gmul(RS_POLY[0], feedback);
	}
	return [parity[2], parity[1], parity[0]];
}

/** Burst bit i (0..263) from the dibit buffer, where `start` is the burst's first dibit. */
function burstBit(dibits: Uint8Array, start: number, mask: number, bit: number): number {
	const dibit = dibits[(start + (bit >> 1)) & mask] & 3;
	return bit & 1 ? dibit & 1 : dibit >> 1;
}

/** 20-bit slot type around the sync: colour code (4), data type (4), Golay parity (12). */
export function slotType(dibits: Uint8Array, start: number, mask: number): { colourCode: number; dataType: number } {
	let value = 0;
	for (let bit = 98; bit < 108; bit++) value = (value << 1) | burstBit(dibits, start, mask, bit);
	for (let bit = 156; bit < 166; bit++) value = (value << 1) | burstBit(dibits, start, mask, bit);
	return { colourCode: (value >> 16) & 0xf, dataType: (value >> 12) & 0xf };
}

// Hamming parity equations as data-bit index lists; a syndrome equal to a data bit's column flips it.
const H15113 = [
	[0, 1, 2, 3, 5, 7, 8],
	[1, 2, 3, 4, 6, 8, 9],
	[2, 3, 4, 5, 7, 9, 10],
	[0, 1, 2, 4, 6, 7, 10],
];
const H1393 = [
	[0, 1, 3, 5, 6],
	[0, 1, 2, 4, 6, 7],
	[0, 1, 2, 3, 5, 7, 8],
	[0, 2, 4, 5, 8],
];

/** Correct one bit error in a Hamming codeword: 0 clean, 1 corrected, 2 uncorrectable. */
function hammingCorrect(equations: number[][], dataBits: number, get: (i: number) => number, flip: (i: number) => void): 0 | 1 | 2 {
	let syndrome = 0;
	equations.forEach((bits, k) => {
		const parity = bits.reduce((acc, i) => acc ^ get(i), 0);
		if (parity !== get(dataBits + k)) syndrome |= 1 << k;
	});
	if (!syndrome) return 0;
	for (let k = 0; k < 4; k++) {
		if (syndrome === 1 << k) {
			flip(dataBits + k);
			return 1;
		}
	}
	for (let i = 0; i < dataBits; i++) {
		const column = equations.reduce((acc, bits, k) => acc | (bits.includes(i) ? 1 << k : 0), 0);
		if (column === syndrome) {
			flip(i);
			return 1;
		}
	}
	return 2;
}

/**
 * Iterative row (15,11) and column (13,9) Hamming correction of the 13x15 BPTC matrix at matrix[1..195].
 * Returns the number of passes that changed something, or -1 when errors remain.
 */
export function bptcCorrect(matrix: Uint8Array): number {
	for (let pass = 0; pass < 5; pass++) {
		let worst = 0;
		for (let r = 0; r < 9; r++) {
			const base = r * 15 + 1;
			worst = Math.max(
				worst,
				hammingCorrect(
					H15113,
					11,
					(i) => matrix[base + i],
					(i) => (matrix[base + i] ^= 1),
				),
			);
		}
		for (let c = 0; c < 15; c++) {
			const at = (i: number) => c + 1 + i * 15;
			worst = Math.max(
				worst,
				hammingCorrect(
					H1393,
					9,
					(i) => matrix[at(i)],
					(i) => (matrix[at(i)] ^= 1),
				),
			);
		}
		if (worst === 0) return pass;
	}
	return -1;
}

/** Deinterleaved BPTC(196,96) matrix of a data burst: its two 98-bit info halves, in matrix order. */
export function bptcMatrix(dibits: Uint8Array, start: number, mask: number): Uint8Array {
	const raw = new Uint8Array(196);
	for (let i = 0; i < 98; i++) {
		raw[i] = burstBit(dibits, start, mask, i);
		raw[98 + i] = burstBit(dibits, start, mask, 166 + i);
	}
	const matrix = new Uint8Array(196);
	for (let a = 0; a < 196; a++) matrix[a] = raw[(a * 181) % 196];
	return matrix;
}

/** BPTC(196,96) data after Hamming correction: the 96 data bits as 12 bytes. */
export function bptc19696(dibits: Uint8Array, start: number, mask: number): Uint8Array {
	const matrix = bptcMatrix(dibits, start, mask);
	bptcCorrect(matrix);
	const bytes = new Uint8Array(12);
	let pos = 0;
	const take = (from: number, to: number) => {
		for (let a = from; a <= to; a++, pos++) bytes[pos >> 3] |= matrix[a] << (7 - (pos & 7));
	};
	take(4, 11);
	for (let row = 1; row < 9; row++) take(row * 15 + 1, row * 15 + 11);
	return bytes;
}

/**
 * Decode the Full LC of a data burst whose sync ended just before `afterSync`.
 * Returns null unless the burst is a Voice LC Header or Terminator with LC and its RS(12,9) check passes.
 */
export function decodeDmrLinkControl(dibits: Uint8Array, afterSync: number, mask: number): DmrLinkControl | null {
	const start = afterSync - 78; // 49 info dibits + 5 slot type dibits + 24 sync dibits
	const { colourCode, dataType } = slotType(dibits, start, mask);
	const crcMask = MASKS[dataType];
	if (crcMask === undefined) return null;
	const lc = bptc19696(dibits, start, mask);
	const parity = rs129Parity(lc);
	if (parity.some((value, i) => (lc[9 + i] ^ crcMask) !== value)) return null;
	const flco = lc[0] & 0x3f;
	if (flco !== 0 && flco !== 3) return null; // group or unit-to-unit voice channel user
	return {
		colourCode,
		terminator: dataType === DATA_TYPE_TERMINATOR,
		group: flco === 0,
		featureSet: lc[1],
		emergency: (lc[2] & 0x80) !== 0,
		privacy: (lc[2] & 0x40) !== 0,
		target: (lc[3] << 16) | (lc[4] << 8) | lc[5],
		source: (lc[6] << 16) | (lc[7] << 8) | lc[8],
	};
}
