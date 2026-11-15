import type { TetraBlock } from './types';

/** Scrambling initialisation for the BSCH, which every cell sends with colour code zero (§8.2.5). */
export const BSCH_SCRAMBLING = 3;

/** Extended colour code to scrambler state: colour code, MNC and MCC above the two fixed ones (§8.2.5.2). */
export function cellScrambling(mcc: number, mnc: number, colourCode: number): number {
	if (colourCode === 0) return BSCH_SCRAMBLING;
	return (((colourCode | (mnc << 6) | (mcc << 20)) << 2) | BSCH_SCRAMBLING) >>> 0;
}

const tap = (lfsr: number, position: number) => (lfsr >>> (32 - position)) & 1;

/** Descramble soft bits in place order: the 32-bit LFSR of §8.2.5.1 flips the sign of each scrambled bit. */
export function descramble(soft: ArrayLike<number>, init: number): Float32Array {
	const out = new Float32Array(soft.length);
	let lfsr = init >>> 0;
	for (let i = 0; i < soft.length; i++) {
		const bit =
			tap(lfsr, 32) ^
			tap(lfsr, 26) ^
			tap(lfsr, 23) ^
			tap(lfsr, 22) ^
			tap(lfsr, 16) ^
			tap(lfsr, 12) ^
			tap(lfsr, 11) ^
			tap(lfsr, 10) ^
			tap(lfsr, 8) ^
			tap(lfsr, 7) ^
			tap(lfsr, 5) ^
			tap(lfsr, 4) ^
			tap(lfsr, 2) ^
			tap(lfsr, 1);
		lfsr = ((lfsr >>> 1) | (bit << 31)) >>> 0;
		out[i] = bit ? -soft[i] : soft[i];
	}
	return out;
}

/** Undo the (K, a) block interleaver of §8.2.4.1. */
export function deinterleave(soft: Float32Array, size: number, step: number): Float32Array {
	const out = new Float32Array(size);
	for (let i = 1; i <= size; i++) out[i - 1] = soft[(step * i) % size];
	return out;
}

/** Spread rate-2/3 coded bits over the rate-1/4 mother code; untransmitted positions stay 0 (erased). §8.2.3.1.3 */
export function depuncture23(soft: Float32Array, type2Length: number): Float32Array {
	const mother = new Float32Array(type2Length * 4);
	const keep = [0, 1, 2, 5];
	for (let j = 1; j <= soft.length; j++) {
		const group = Math.floor((j - 1) / 3);
		const index = 8 * group + keep[j - 3 * group];
		if (index <= mother.length) mother[index - 1] = soft[j - 1];
	}
	return mother;
}

// Mother code generators G1..G4 = 1+D+D^4, 1+D^2+D^3+D^4, 1+D+D^2+D^4, 1+D+D^3+D^4 (§8.2.3.1.1).
const GENERATORS = [0b10011, 0b11101, 0b10111, 0b11011];
const parity = (value: number) => {
	let bits = value;
	bits ^= bits >> 4;
	bits ^= bits >> 2;
	bits ^= bits >> 1;
	return bits & 1;
};
/**
 * BRANCH[state * 2 + input] holds the four mother-code output signs (+1 for a one). The index is the
 * shift register itself: bit 0 is the input (D^0) and bits 1..4 the previous inputs (D^1..D^4).
 */
const BRANCH = Array.from({ length: 32 }, (_, register) => GENERATORS.map((generator) => (parity(generator & register) ? 1 : -1)));

/** Soft-decision Viterbi over the 16-state mother code; the tail bits return the encoder to state zero. */
export function viterbi(mother: Float32Array, type2Length: number): Uint8Array {
	let metric = new Float64Array(16).fill(-Infinity);
	metric[0] = 0;
	const history = new Uint8Array(type2Length * 16);
	for (let k = 0; k < type2Length; k++) {
		const next = new Float64Array(16).fill(-Infinity);
		const r0 = mother[4 * k],
			r1 = mother[4 * k + 1],
			r2 = mother[4 * k + 2],
			r3 = mother[4 * k + 3];
		for (let state = 0; state < 16; state++) {
			if (metric[state] === -Infinity) continue;
			for (let input = 0; input < 2; input++) {
				const out = BRANCH[state * 2 + input];
				const candidate = metric[state] + r0 * out[0] + r1 * out[1] + r2 * out[2] + r3 * out[3];
				const target = ((state << 1) | input) & 15;
				if (candidate > next[target]) {
					next[target] = candidate;
					history[k * 16 + target] = state;
				}
			}
		}
		metric = next;
	}
	const bits = new Uint8Array(type2Length);
	let state = 0;
	for (let k = type2Length - 1; k >= 0; k--) {
		bits[k] = state & 1;
		state = history[k * 16 + state];
	}
	return bits;
}

/** CRC-CCITT over the info bits, MSB first, preset and complemented (§8.2.3.2). */
export function crc16(bits: Uint8Array, length: number): number {
	let crc = 0xffff;
	for (let i = 0; i < length; i++) {
		const top = ((crc >> 15) & 1) ^ bits[i];
		crc = ((crc << 1) & 0xffff) ^ (top ? 0x1021 : 0);
	}
	return crc ^ 0xffff;
}

export function field(bits: Uint8Array, start: number, length: number): number {
	let value = 0;
	for (let i = 0; i < length; i++) value = value * 2 + bits[start + i];
	return value;
}

/**
 * Type-5 soft bits of one control channel block to its type-1 info bits: descramble, deinterleave,
 * depuncture the rate-2/3 code, Viterbi-decode, then check the 16-bit CRC that follows the info bits.
 */
export function decodeControlBlock(type5: ArrayLike<number>, interleaveStep: number, scrambling: number, infoLength: number): TetraBlock {
	const type2Length = infoLength + 16 + 4;
	const type3 = deinterleave(descramble(type5, scrambling), type5.length, interleaveStep);
	const type2 = viterbi(depuncture23(type3, type2Length), type2Length);
	const info = type2.slice(0, infoLength);
	return { info, crcOk: crc16(type2, infoLength) === field(type2, infoLength, 16) };
}
