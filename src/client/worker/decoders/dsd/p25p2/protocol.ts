// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// P25 Phase 2 burst primitives ported from OnAir core/src/p25p2/p25p2_proto.cpp.
import { AMBE_C0, AMBE_C1, AMBE_C2, AMBE_C3, AMBE_ROW, DUID_LOOKUP, ISCH_WORDS } from './data';

export const P25P2_SYNC = 0x575d57f7ffn;
export const P25P2_BURST_DIBITS = 180;
export const P25P2_VOICE_OFFSETS = [2, 76, 172, 246] as const;
const DUID_POSITIONS = [20, 57, 142, 179] as const;
const MASK_44 = (1n << 44n) - 1n;

function bitErrors(value: bigint): number {
	let count = 0;
	while (value) {
		value &= value - 1n;
		count++;
	}
	return count;
}

export function ischValue(dibits: ArrayLike<number>): bigint {
	if (dibits.length < 20) throw new Error('P25 Phase 2 ISCH requires 20 dibits');
	let value = 0n;
	for (let index = 0; index < 20; index++) value = (value << 2n) | BigInt(dibits[index] & 3);
	return value;
}

export function ischSyncDistance(dibits: ArrayLike<number>): number {
	return bitErrors(ischValue(dibits) ^ P25P2_SYNC);
}

export function ischDecode(
	dibits: ArrayLike<number>,
): { channel: number; location: number; first: number; ultraframe: number; errors: number } | null {
	const value = ischValue(dibits);
	let best = -1;
	let errors = 41;
	for (let index = 0; index < ISCH_WORDS.length; index++) {
		const distance = bitErrors(value ^ ISCH_WORDS[index]);
		if (distance < errors) {
			errors = distance;
			best = index;
		}
	}
	if (errors > 7) return null;
	return { channel: (best >> 5) & 3, location: (best >> 3) & 3, first: (best >> 2) & 1, ultraframe: best & 3, errors };
}

export function p25p2Duid(burst: ArrayLike<number>): number {
	if (burst.length < P25P2_BURST_DIBITS) throw new Error('P25 Phase 2 burst requires 180 dibits');
	let word = 0;
	for (const position of DUID_POSITIONS) word = (word << 2) | (burst[position] & 3);
	return DUID_LOOKUP[word];
}

/** One superframe of 12 180-dibit bursts, with ten leading zero dibits. */
export function p25p2Scramble(wacn: number, system: number, nac: number): Uint8Array {
	const sequence = new Uint8Array(10 + 12 * P25P2_BURST_DIBITS);
	let state = (BigInt(wacn & 0xfffff) << 24n) | (BigInt(system & 0xfff) << 12n) | BigInt(nac & 0xfff);
	for (let index = 10; index < sequence.length; index++) {
		let dibit = 0;
		for (let bit = 0; bit < 2; bit++) {
			dibit = (dibit << 1) | Number((state >> 43n) & 1n);
			const feedback = ((state >> 33n) ^ (state >> 19n) ^ (state >> 14n) ^ (state >> 8n) ^ (state >> 3n) ^ (state >> 43n)) & 1n;
			state = ((state << 1n) | feedback) & MASK_44;
		}
		sequence[index] = dibit;
	}
	return sequence;
}

export function p25p2Descramble(burst: ArrayLike<number>, sequence: Uint8Array, slot: number): Uint8Array {
	if (burst.length < P25P2_BURST_DIBITS || slot < 0 || slot >= 12 || sequence.length < 12 * P25P2_BURST_DIBITS)
		throw new Error('Invalid P25 Phase 2 burst or scrambler');
	const result = new Uint8Array(P25P2_BURST_DIBITS);
	for (let index = 0; index < result.length; index++) result[index] = burst[index] ^ sequence[slot * P25P2_BURST_DIBITS + index];
	return result;
}

/** 72 air bits in mbelib's four-row AMBE+2 word order (96 bytes including unused cells). */
export function p25p2AmbeFrame(burst: ArrayLike<number>, offset: number): Uint8Array {
	if (burst.length < P25P2_BURST_DIBITS || offset < 0 || offset + 72 > 320) throw new Error('Invalid P25 Phase 2 AMBE offset');
	const columns = [AMBE_C0, AMBE_C1, AMBE_C2, AMBE_C3];
	const rowCount = [0, 0, 0, 0];
	const frame = new Uint8Array(96);
	for (let index = 0; index < 72; index++) {
		const row = AMBE_ROW[index];
		const column = columns[row][rowCount[row]++];
		const position = offset + index;
		const dibit = burst[20 + (position >> 1)];
		frame[row * 24 + column] = (dibit >> (1 - (position & 1))) & 1;
	}
	return frame;
}
