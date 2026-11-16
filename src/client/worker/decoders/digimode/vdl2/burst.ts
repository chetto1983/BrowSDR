// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir rust/onair_vdl2/src/burst.rs (burst body, HDLC deframer, FCS) and
// core/src/vdl2/vdl2_proto_rs.cpp (vdl2BurstData, vdl2HdlcFrames), https://github.com/adswill/OnAir; see
// third_party/onair. Changes: frames are returned as arrays (the caller-buffer overflow checks of the C ABI go).
//
// Gathering the data and FEC octets of a burst into Reed-Solomon blocks and correcting them, the HDLC deframer (0x7E
// flags, zero-bit insertion, abort on seven ones) and the FCS (CRC-16/X.25, residue 0xF0B8). ICAO Annex 10 Vol III
// Part I section 6.3.2 (interleaving), ISO 3309.

import { RS_K, RS_N } from './bits';
import { rsDecode } from './rs';
import type { Vdl2Layout } from './types';

/** Most Reed-Solomon blocks a burst can have: the 17 bit header length is at most 131071 bits = 16384 octets = 66 blocks. */
export const MAX_BLOCKS = 70;

function getOctet(bits: Uint8Array, at: number): number {
	let v = 0;
	for (let b = 0; b < 8; b++) v |= ((at + b < bits.length ? bits[at + b] : 0) & 1) << b;
	return v;
}

/** The Reed-Solomon blocks of a burst: octets sent column by column across the blocks, data then FEC. */
function gatherRows(bits: Uint8Array, l: Vdl2Layout): Uint8Array[] {
	const blocks = l.blocks;
	const rows = Array.from({ length: blocks }, () => new Uint8Array(RS_N));
	let k = 0;
	for (let c = 0; c < RS_K; c++)
		for (let r = 0; r < blocks; r++) {
			if (r === blocks - 1 && c >= l.lastLen) continue;
			rows[r][c] = getOctet(bits, 8 * k++);
		}
	const fecRows = l.lastFec !== 0 ? blocks : Math.max(0, blocks - 1);
	for (let c = 0; c < RS_N - RS_K; c++)
		for (let r = 0; r < fecRows; r++) {
			if (r === blocks - 1 && c >= l.lastFec) continue;
			rows[r][RS_K + c] = getOctet(bits, 8 * k++);
		}
	return rows;
}

/**
 * Gathers the descrambled bits after the header (bits past the end read as 0), corrects every block and returns the
 * first `lenBits` data bits (one per byte) and the octets the code corrected; `bits` undefined when a block cannot be
 * corrected.
 */
export function burstData(bits: Uint8Array, l: Vdl2Layout, lenBits: number): { bits?: Uint8Array; fixed: number } {
	if (l.blocks < 0 || l.blocks > MAX_BLOCKS) return { fixed: 0 };
	const rows = gatherRows(bits, l);
	let fixed = 0;
	for (let r = 0; r < l.blocks; r++) {
		const np = r === l.blocks - 1 ? l.lastFec : 6;
		if (np === 0) continue;
		const f = rsDecode(rows[r], np);
		if (f < 0) return { fixed };
		fixed += f;
	}
	const out = new Uint8Array(lenBits);
	let n = 0;
	for (let r = 0; r < l.blocks; r++) {
		const count = r === l.blocks - 1 ? l.lastLen : RS_K;
		for (let i = 0; i < count; i++) for (let b = 0; b < 8 && n < lenBits; b++) out[n++] = (rows[r][i] >> b) & 1;
	}
	return { bits: out.subarray(0, n), fixed };
}

function crcReg(p: Uint8Array): number {
	let c = 0xffff;
	for (const byte of p) {
		c ^= byte;
		for (let i = 0; i < 8; i++) c = c & 1 ? (c >>> 1) ^ 0x8408 : c >>> 1;
	}
	return c;
}

/** The FCS to send for the frame octets `p` (low octet first): the complement of the CRC register. */
export const fcs = (p: Uint8Array): number => ~crcReg(p) & 0xffff;

/** True when the frame, including its two FCS octets, leaves the CRC register at the residue 0xF0B8. */
export const fcsOk = (p: Uint8Array): boolean => p.length >= 2 && crcReg(p) === 0xf0b8;

/**
 * The frames between flags in the bit stream (one bit per byte). Frames need at least two octets and a whole number of
 * octets, and must not have seen seven ones in a row.
 */
export function hdlcFrames(bits: Uint8Array): Uint8Array[] {
	const frames: Uint8Array[] = [];
	const buf = new Uint8Array((bits.length >> 3) + 1);
	let cur = 0;
	let ones = 0;
	let sync = false;
	let abort = false;
	const push = (bit: number) => {
		if (!abort) {
			const at = cur >> 3;
			if (cur % 8 === 0) buf[at] = 0;
			buf[at] |= bit << (cur % 8);
		}
		cur++;
	};
	for (const bit of bits) {
		if (bit) {
			if (++ones > 6) {
				abort = true;
				cur = 0;
			} else push(1);
			continue;
		}
		if (ones === 5) {
			ones = 0; // inserted zero
			continue;
		}
		if (ones === 6) {
			// flag: drop its leading zero and six ones, then finish the frame
			cur = Math.max(0, cur - 7);
			if (sync && !abort && cur >= 16 && cur % 8 === 0) frames.push(buf.slice(0, cur / 8));
			cur = 0;
			abort = false;
			sync = true;
			ones = 0;
			continue;
		}
		push(0);
		ones = 0;
	}
	return frames;
}
