// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir rust/onair_dstar/src/header.rs (crc, pack, unpack, flag_text),
// rust/onair_dstar/src/fec.rs (bytes_to_bits, bits_to_bytes, conv_encode, viterbi, interleave_table, interleave,
// deinterleave, scramble_bits, header_encode, header_decode) and core/src/dstar/dstar_proto.cpp (kFrameSync, kDataSync,
// kEndPattern, kSlowScramble), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: bits and bytes are typed arrays and strings; the Viterbi decoder keeps its path metrics in a Float64Array.
//
// D-STAR (JARL D-STAR specification, DV mode): the radio header and its FEC, the sync patterns and the slow data
// scrambler. Every byte goes on the air least significant bit first.
import type { DstarHeader } from './types';

export const HEADER_BYTES = 41;
/** 328 bits + 2 tail bits, convolutional rate 1/2. */
export const HEADER_BITS = 660;
/** A voice frame: 72 AMBE bits + 24 slow data bits, 20 ms. */
export const FRAME_BITS = 96;
export const VOICE_BITS = 72;
/** Frames from one data sync to the next (frame 0 carries the sync). */
export const SUPERFRAME = 21;

/** After the bit sync, before the header: 111011001010000. */
export const FRAME_SYNC = [1, 1, 1, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0, 0];
/** The slow data of frame 0: 0x55 0x2D 0x16. */
export const DATA_SYNC = [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 0, 0];
/** In place of a voice frame at the end: 0x55 0x55 0x55 0x55 0xC8 0x7A. */
export const END_PATTERN = [
	1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1,
	1, 0,
];
/** The slow data bytes of the other frames are sent XOR these. */
export const SLOW_SCRAMBLE = [0x70, 0x4f, 0x93];

/** CRC-CCITT as D-STAR uses it (reflected 0x8408, start 0xFFFF, inverted); sent low byte first. */
export function dstarCrc(p: ArrayLike<number>, n = p.length): number {
	let c = 0xffff;
	for (let i = 0; i < n; i++) {
		c ^= p[i] & 0xff;
		for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x8408 : c >>> 1;
	}
	return ~c & 0xffff;
}

function putCall(o: Uint8Array, at: number, width: number, s: string): void {
	for (let i = 0; i < width; i++) o[at + i] = i < s.length ? s.charCodeAt(i) & 0xff : 0x20;
}

/** A callsign field: printable characters (others become '?'), trailing spaces removed. */
function getCall(p: Uint8Array, at: number, width: number): string {
	let s = '';
	for (let i = 0; i < width; i++) {
		const c = p[at + i];
		s += c >= 32 && c < 127 ? String.fromCharCode(c) : '?';
	}
	return s.replace(/ +$/, '');
}

/** A header in 41 bytes with its CRC; each field is cut / space padded to its width. */
export function headerPack(h: DstarHeader): Uint8Array {
	const o = new Uint8Array(HEADER_BYTES);
	for (let i = 0; i < 3; i++) o[i] = h.flag[i] ?? 0;
	putCall(o, 3, 8, h.rpt2);
	putCall(o, 11, 8, h.rpt1);
	putCall(o, 19, 8, h.ur);
	putCall(o, 27, 8, h.my);
	putCall(o, 35, 4, h.sfx);
	const c = dstarCrc(o, 39);
	o[39] = c & 0xff;
	o[40] = c >> 8;
	return o;
}

/** The fields of a header; ok is false when the CRC does not match (the fields are filled anyway). */
export function headerUnpack(i: Uint8Array): { header: DstarHeader; ok: boolean } {
	const header: DstarHeader = {
		flag: [i[0], i[1], i[2]],
		rpt2: getCall(i, 3, 8),
		rpt1: getCall(i, 11, 8),
		ur: getCall(i, 19, 8),
		my: getCall(i, 27, 8),
		sfx: getCall(i, 35, 4),
	};
	const c = dstarCrc(i, 39);
	return { header, ok: i[39] === (c & 0xff) && i[40] === c >> 8 };
}

const FLAG_SUB = ['', 'relay unavailable', 'no response', 'ACK', 'resend', 'unused', 'auto reply', 'repeater control'];

/** Text of the first flag byte ("data, via repeater, EMERGENCY, ..."). */
export function flagText(f0: number): string {
	const out: string[] = [];
	if (f0 & 0x80) out.push('data');
	out.push(f0 & 0x40 ? 'via repeater' : 'simplex');
	if (f0 & 0x20) out.push('interrupted');
	if (f0 & 0x10) out.push('control');
	if (f0 & 0x08) out.push('EMERGENCY');
	if (FLAG_SUB[f0 & 7]) out.push(FLAG_SUB[f0 & 7]);
	return out.join(', ');
}

/** Bytes to bits, LSB first: bits[8i + k] is bit k of byte i. */
export function bytesToBits(b: ArrayLike<number>, nBytes = b.length): Uint8Array {
	const bits = new Uint8Array(nBytes * 8);
	for (let i = 0; i < nBytes; i++) for (let k = 0; k < 8; k++) bits[i * 8 + k] = (b[i] >> k) & 1;
	return bits;
}

/** Bits to bytes, LSB first (the inverse of bytesToBits); bits past the end read as 0. */
export function bitsToBytes(bits: ArrayLike<number>, nBytes: number, start = 0): Uint8Array {
	const b = new Uint8Array(nBytes);
	for (let i = 0; i < nBytes; i++) {
		let v = 0;
		for (let k = 0; k < 8; k++) v |= ((bits[start + i * 8 + k] ?? 0) & 1) << k;
		b[i] = v;
	}
	return b;
}

/** Convolutional encoder (K = 3, generators 7 and 5): n bits in, 2n out: b ^ d1 ^ d2 and b ^ d2. */
export function convEncode(inp: ArrayLike<number>, n = inp.length): Uint8Array {
	const out = new Uint8Array(2 * n);
	let d1 = 0;
	let d2 = 0;
	for (let i = 0; i < n; i++) {
		const b = inp[i] & 1;
		out[2 * i] = b ^ d1 ^ d2;
		out[2 * i + 1] = b ^ d2;
		d2 = d1;
		d1 = b;
	}
	return out;
}

/**
 * Soft Viterbi decoder: nOut bits from 2 nOut soft values (positive = 1), the tail bits bring the coder back to state 0.
 * Returns the channel bits that differ from the re-encoded result.
 */
export function viterbi(soft: ArrayLike<number>, nOut: number, out: Uint8Array): number {
	const from = new Uint8Array(nOut * 4);
	let m = new Float64Array([0, -1e30, -1e30, -1e30]);
	for (let i = 0; i < nOut; i++) {
		const nm = new Float64Array([-1e30, -1e30, -1e30, -1e30]);
		const a0 = soft[2 * i];
		const a1 = soft[2 * i + 1];
		for (let s = 0; s < 4; s++) {
			if (m[s] < -1e29) continue;
			const d1 = s & 1;
			const d2 = s >> 1;
			for (let b = 0; b < 2; b++) {
				const v = m[s] + (b ^ d1 ^ d2 ? a0 : -a0) + (b ^ d2 ? a1 : -a1);
				const ns = b | (d1 << 1);
				if (v > nm[ns]) {
					nm[ns] = v;
					from[i * 4 + ns] = s;
				}
			}
		}
		m = nm;
	}
	let s = 0;
	for (let i = nOut - 1; i >= 0; i--) {
		out[i] = s & 1;
		s = from[i * 4 + s];
	}
	const re = convEncode(out, nOut);
	let err = 0;
	for (let i = 0; i < 2 * nOut; i++) if (soft[i] > 0 !== (re[i] !== 0)) err++;
	return err;
}

/** Interleaver: input bit i goes to position ILV[i] (24 columns over the 660 header bits). */
const ILV = (() => {
	const t = new Uint16Array(HEADER_BITS);
	let k = 0;
	for (let i = 0; i < HEADER_BITS; i++) {
		t[i] = k;
		k += 24;
		if (k >= 672) k -= 671;
		else if (k >= 660) k -= 647;
	}
	return t;
})();

export function interleave(inp: ArrayLike<number>): Uint8Array {
	const out = new Uint8Array(HEADER_BITS);
	for (let i = 0; i < HEADER_BITS; i++) out[ILV[i]] = inp[i];
	return out;
}

export function deinterleave(inp: ArrayLike<number>): Float32Array {
	const out = new Float32Array(HEADER_BITS);
	for (let i = 0; i < HEADER_BITS; i++) out[i] = inp[ILV[i]];
	return out;
}

/** XORs the scrambler sequence (x^7 + x^4 + 1, register starts all ones) into bits; applying it twice restores them. */
export function scrambleBits(bits: Uint8Array): Uint8Array {
	let s = 0x7f;
	for (let i = 0; i < bits.length; i++) {
		const o = ((s >> 3) ^ (s >> 6)) & 1;
		s = ((s << 1) | o) & 0x7f;
		bits[i] ^= o;
	}
	return bits;
}

/** The header on the air: 41 bytes -> 660 bits (convolutional code, interleaver, scrambler). */
export function headerEncode(hdr: Uint8Array): Uint8Array {
	const inp = bytesToBits(hdr).subarray(0, 330);
	const padded = new Uint8Array(330);
	padded.set(inp);
	return scrambleBits(interleave(convEncode(padded)));
}

/** 660 soft values (positive = 1) -> 41 bytes, and the channel bit errors the Viterbi decoder corrected. */
export function headerDecode(soft: ArrayLike<number>): { bytes: Uint8Array; errors: number } {
	const sc = scrambleBits(new Uint8Array(HEADER_BITS));
	const d = new Float32Array(HEADER_BITS);
	for (let i = 0; i < HEADER_BITS; i++) d[i] = sc[i] ? -soft[i] : soft[i];
	const out = new Uint8Array(330);
	const errors = viterbi(deinterleave(d), 330, out);
	return { bytes: bitsToBytes(out, HEADER_BYTES), errors };
}
