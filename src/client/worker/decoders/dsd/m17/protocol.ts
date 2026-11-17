// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// M17 2.0 receive-side coding, ported from OnAir core/src/m17/m17_proto.cpp at 3d3f1ca.
import type { M17Lsf } from './types';

export const M17_SYNC = { lsf: 0x55f7, stream: 0xff5d, packet: 0x75ff, bert: 0xdf55, eot: 0x555d } as const;
export type { M17FrameType, M17Lsf } from './types';

const RAND = new Uint8Array([
	0xd6, 0xb5, 0xe2, 0x30, 0x82, 0xff, 0x84, 0x62, 0xba, 0x4e, 0x96, 0x90, 0xd8, 0x98, 0xdd, 0x5d, 0x0c, 0xc8, 0x52, 0x43, 0x91, 0x1d, 0xf8,
	0x6e, 0x68, 0x2f, 0x35, 0xda, 0x14, 0xea, 0xcd, 0x76, 0x19, 0x8d, 0xd5, 0x80, 0xd1, 0x33, 0x87, 0x13, 0x57, 0x18, 0x2d, 0x29, 0x78, 0xc3,
]);
const GOLAY_P = new Uint16Array([0x8eb, 0x93e, 0xa97, 0xdc6, 0x367, 0x6cd, 0xd99, 0x3da, 0x7b4, 0xf68, 0x63b, 0xc75]);
const P1 = new Uint8Array([
	1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1,
	0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1,
]);
const P2 = new Uint8Array([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0]);
const P3 = new Uint8Array([1, 1, 1, 1, 1, 1, 1, 0]);
const qpp = (index: number) => (45 * index + 92 * index * index) % 368;
const bit = (data: Uint8Array, index: number) => (data[index >> 3] >> (7 - (index & 7))) & 1;
const parity = (value: number) => {
	let count = 0;
	for (; value; value &= value - 1) count++;
	return count & 1;
};

export function m17SyncSymbols(word: number): Int8Array {
	const output = new Int8Array(8);
	for (let i = 0; i < 8; i++) {
		const dibit = (word >> (14 - 2 * i)) & 3;
		output[i] = dibit === 1 ? 3 : dibit === 0 ? 1 : dibit === 2 ? -1 : -3;
	}
	return output;
}

/** Positive soft bit means one, in deinterleaved and derandomized order. */
export function m17SoftBits(symbols: ArrayLike<number>): Float32Array {
	if (symbols.length < 184) throw new Error('M17 requires 184 payload symbols');
	const hard = new Float32Array(368);
	const soft = new Float32Array(368);
	for (let i = 0; i < 184; i++) {
		const value = Math.max(-4, Math.min(4, symbols[i]));
		hard[2 * i] = -value;
		hard[2 * i + 1] = Math.abs(value) - 2;
	}
	for (let i = 0; i < 368; i++) if (bit(RAND, i)) hard[i] = -hard[i];
	for (let i = 0; i < 368; i++) soft[i] = hard[qpp(i)];
	return soft;
}

function depuncture(soft: ArrayLike<number>, pattern: Uint8Array, inputBits: number): Float32Array {
	const output = new Float32Array(2 * inputBits);
	let source = 0;
	for (let i = 0; i < output.length && source < soft.length; i++) if (pattern[i % pattern.length]) output[i] = soft[source++];
	return output;
}

export function m17Viterbi(soft: ArrayLike<number>, inputBits: number): { bits: Uint8Array; corrected: number } {
	const negative = -1e30;
	let previous = new Float64Array(16).fill(negative);
	let next = new Float64Array(16);
	previous[0] = 0;
	const decisions = new Uint8Array(inputBits * 16);
	const ancestors = new Uint8Array(inputBits * 16);
	for (let time = 0; time < inputBits; time++) {
		next.fill(negative);
		const a = soft[2 * time],
			b = soft[2 * time + 1];
		for (let state = 0; state < 16; state++) {
			if (previous[state] <= negative) continue;
			for (let input = 0; input < 2; input++) {
				const sr = ((state << 1) | input) & 31;
				const first = parity(sr & 0x19),
					second = parity(sr & 0x17);
				const score = previous[state] + (first ? a : -a) + (second ? b : -b);
				const target = sr & 15;
				if (score > next[target]) {
					next[target] = score;
					decisions[time * 16 + target] = input;
					ancestors[time * 16 + target] = state;
				}
			}
		}
		[previous, next] = [next, previous];
	}
	let state = 0;
	const bits = new Uint8Array(inputBits);
	for (let time = inputBits - 1; time >= 0; time--) {
		bits[time] = decisions[time * 16 + state];
		state = ancestors[time * 16 + state];
	}
	let sr = 0,
		corrected = 0;
	for (let time = 0; time < inputBits; time++) {
		sr = ((sr << 1) | bits[time]) & 31;
		const a = soft[2 * time],
			b = soft[2 * time + 1];
		if (a && a > 0 !== Boolean(parity(sr & 0x19))) corrected++;
		if (b && b > 0 !== Boolean(parity(sr & 0x17))) corrected++;
	}
	return { bits, corrected };
}

function bitsToBytes(bits: ArrayLike<number>, count: number): Uint8Array {
	const bytes = new Uint8Array(Math.ceil(count / 8));
	for (let i = 0; i < count; i++) if (bits[i]) bytes[i >> 3] |= 0x80 >> (i & 7);
	return bytes;
}

export function m17Crc16(bytes: ArrayLike<number>): number {
	let crc = 0xffff;
	for (let i = 0; i < bytes.length; i++) {
		crc ^= bytes[i] << 8;
		for (let j = 0; j < 8; j++) crc = ((crc << 1) ^ (crc & 0x8000 ? 0x5935 : 0)) & 0xffff;
	}
	return crc;
}

export function m17DecodeCallsign(value: bigint): string {
	if (value === 0xffffffffffffn) return '@ALL';
	if (value === 0n) return '';
	if (value >= 0xee6b28000000n) return `#${value.toString(16).toUpperCase().padStart(12, '0')}`;
	const alphabet = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-/.';
	let text = '';
	while (value) {
		text += alphabet[Number(value % 40n)];
		value /= 40n;
	}
	return text.trimEnd();
}

export function m17UnpackLsf(bytes: Uint8Array): M17Lsf | null {
	if (bytes.length !== 30 || m17Crc16(bytes) !== 0) return null;
	let dst = 0n,
		src = 0n;
	for (let i = 0; i < 6; i++) {
		dst = (dst << 8n) | BigInt(bytes[i]);
		src = (src << 8n) | BigInt(bytes[6 + i]);
	}
	return { dst: m17DecodeCallsign(dst), src: m17DecodeCallsign(src), type: (bytes[12] << 8) | bytes[13], meta: bytes.slice(14, 28) };
}

function golayParity(data: number): number {
	let parityBits = 0;
	for (let i = 0; i < 12; i++) if ((data >> i) & 1) parityBits ^= GOLAY_P[i];
	return parityBits;
}
const golayPatterns = new Uint32Array(4096).fill(0xffffffff);
const golayWeights = new Uint8Array(4096).fill(99);
function golaySyndrome(error: number): number {
	return golayParity(error >>> 12) ^ (error & 0xfff);
}
function addGolayPattern(pattern: number, weight: number): void {
	const syndrome = golaySyndrome(pattern);
	if (weight < golayWeights[syndrome]) {
		golayWeights[syndrome] = weight;
		golayPatterns[syndrome] = pattern;
	}
}
addGolayPattern(0, 0);
for (let a = 0; a < 24; a++) {
	addGolayPattern(1 << a, 1);
	for (let b = a + 1; b < 24; b++) {
		addGolayPattern((1 << a) | (1 << b), 2);
		for (let c = b + 1; c < 24; c++) addGolayPattern((1 << a) | (1 << b) | (1 << c), 3);
	}
}

function golayDecode(word: number): { data: number; errors: number; valid: boolean } {
	const syndrome = golaySyndrome(word);
	const pattern = golayPatterns[syndrome];
	if (pattern === 0xffffffff) return { data: word >>> 12, errors: 4, valid: false };
	return { data: ((word ^ pattern) >>> 12) & 0xfff, errors: golayWeights[syndrome], valid: true };
}

export function m17DecodeLsf(soft: ArrayLike<number>): { lsf: M17Lsf | null; corrected: number } {
	const decoded = m17Viterbi(depuncture(soft, P1, 244), 244);
	return { lsf: m17UnpackLsf(bitsToBytes(decoded.bits, 240)), corrected: decoded.corrected };
}

export function m17DecodeStream(soft: ArrayLike<number>): {
	lich: Uint8Array;
	lichValid: boolean;
	golayErrors: number;
	frameNumber: number;
	payload: Uint8Array;
	corrected: number;
} {
	const lichBits = new Uint8Array(48);
	let lichValid = true,
		golayErrors = 0;
	for (let k = 0; k < 4; k++) {
		let word = 0;
		for (let i = 0; i < 24; i++) word = (word << 1) | (soft[k * 24 + i] > 0 ? 1 : 0);
		const decoded = golayDecode(word);
		lichValid &&= decoded.valid;
		golayErrors += decoded.errors;
		for (let i = 0; i < 12; i++) lichBits[k * 12 + i] = (decoded.data >> (11 - i)) & 1;
	}
	const decoded = m17Viterbi(depuncture(Array.prototype.slice.call(soft, 96), P2, 148), 148);
	const bytes = bitsToBytes(decoded.bits, 144);
	return {
		lich: bitsToBytes(lichBits, 48),
		lichValid,
		golayErrors,
		frameNumber: (bytes[0] << 8) | bytes[1],
		payload: bytes.slice(2, 18),
		corrected: decoded.corrected,
	};
}

export function m17DecodePacket(soft: ArrayLike<number>): { chunk: Uint8Array; eof: boolean; counter: number; corrected: number } {
	const decoded = m17Viterbi(depuncture(soft, P3, 210), 210);
	const bytes = bitsToBytes(decoded.bits, 206);
	return { chunk: bytes.slice(0, 25), eof: Boolean(bytes[25] & 0x80), counter: (bytes[25] >> 2) & 31, corrected: decoded.corrected };
}
