// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir rust/onair_dmr/src/burst.rs (SYNC_WORDS, match_sync, data_type_name,
// make_data_burst, make_voice_burst, burst_slot_type, burst_emb), core/src/dmr/dmr_proto.cpp (burstDataPayload) and
// core/src/dmr/dmr_link.cpp (bptcAssisted, bitRel, payloadReliability and the symbol fit of Link::decodeBurst),
// https://github.com/adswill/OnAir; see third_party/onair.
// Changes: bursts are read from BrowSDR's circular dibit buffer, which its own slicer filled; the symbol levels are
// fitted per burst (OnAir keeps a running calibration per time slot) and only serve as soft values; sync patterns are
// matched on dibits rather than on 48 bits.
//
// DMR burst layout (ETSI TS 102 361-1 clauses 6 and 9): 264 bits = 132 symbols, the centre field is symbols 54..77.
import { getBits, golay2008Decode, golay2008Parity, qr1676Decode, qr1676Parity, putBits } from './codes';
import { bptc196Decode, dibitToSymbol } from './product';

/** The 48-bit sync patterns: BS voice, BS data, MS voice, MS data, standalone RC, direct slot 1 voice / data, slot 2 voice / data. */
export const SYNC_WORDS = [
	0x755fd7df75f7, 0xdff57d75df5d, 0x7f7d5dd57dfd, 0xd5d7f77fd757, 0x77d55f7dfd77, 0x5d577f7757ff, 0xf7fdd5ddfd55, 0x7dffd5f55d5f,
	0xd7557f5ff7f5,
];
export const SYNC_BS_VOICE = 0;
export const SYNC_BS_DATA = 1;
export const SYNC_MS_DATA = 3;
const SYNC_DIBITS = SYNC_WORDS.map((w) => Uint8Array.from({ length: 24 }, (_, i) => Math.floor(w / 2 ** (46 - 2 * i)) & 3));
export const syncIsData = (s: number) => s === 1 || s === 3 || s === 6 || s === 8;
/** 1 or 2 for the direct mode patterns, 0 otherwise. */
export const syncDirectSlot = (s: number) => (s === 5 || s === 6 ? 1 : s === 7 || s === 8 ? 2 : 0);

const DATA_TYPES = [
	'PI header',
	'Voice LC header',
	'Terminator with LC',
	'CSBK',
	'MBC header',
	'MBC continuation',
	'Data header',
	'Rate 1/2 data',
	'Rate 3/4 data',
	'Idle',
	'Rate 1 data',
	'Unified single block data',
];
/** Data type name (table 9.x). */
export const dataTypeName = (dt: number) => DATA_TYPES[dt & 15] ?? 'reserved';

/** Index of the sync pattern within `maxDiff` dibits of the 24 centre dibits starting at `pos` of `dibits` (-1 none). */
export function matchSyncDibits(dibits: Uint8Array, pos: number, mask: number, maxDiff: number): number {
	let best = -1;
	let bd = 99;
	SYNC_DIBITS.forEach((want, s) => {
		let d = 0;
		for (let i = 0; i < 24 && d < bd; i++) if ((dibits[(pos + i) & mask] & 3) !== want[i]) d++;
		if (d < bd) {
			bd = d;
			best = s;
		}
	});
	return bd <= maxDiff ? best : -1;
}

/** The 264 bits and 132 soft symbol values (nominal levels +-1, +-3) of the burst whose first dibit is at `start`. */
export function readBurst(dibits: Uint8Array, symbols: Float32Array, mask: number, start: number): { bits: Uint8Array; z: Float32Array } {
	const bits = new Uint8Array(264);
	const z = new Float32Array(132);
	let sx = 0;
	let sy = 0;
	let sxx = 0;
	let sxy = 0;
	for (let j = 0; j < 132; j++) {
		const d = dibits[(start + j) & mask] & 3;
		bits[2 * j] = d >> 1;
		bits[2 * j + 1] = d & 1;
		const x = dibitToSymbol(d);
		const y = symbols[(start + j) & mask];
		z[j] = x;
		sx += x;
		sy += y;
		sxx += x * x;
		sxy += x * y;
	}
	// the symbol levels as OnAir fits them from the decided symbols: value = off + unit * level
	const den = 132 * sxx - sx * sx;
	const unit = den > 1e-6 ? (132 * sxy - sx * sy) / den : 0;
	if (unit > 0) {
		const off = (sy - unit * sx) / 132;
		for (let j = 0; j < 132; j++) z[j] = (symbols[(start + j) & mask] - off) / unit;
	}
	return { bits, z };
}

/** The 2 x 98 payload bits of a data burst, in transmit order. */
export function burstDataPayload(burst: Uint8Array): Uint8Array {
	const p = new Uint8Array(196);
	p.set(burst.subarray(0, 98), 0);
	p.set(burst.subarray(166, 264), 98);
	return p;
}

/** The slot type field (bits 98..108 and 156..166): colour code, data type and errors, or null when Golay (20,8) cannot correct it. */
export function burstSlotType(burst: Uint8Array): { cc: number; dt: number; errors: number } | null {
	const r = golay2008Decode(getBits(burst, 98, 10) * 1024 + getBits(burst, 156, 10));
	return r && { cc: r[1] >> 4, dt: r[1] & 15, errors: r[0] };
}

/** The EMB field (bits 108..116 and 148..156) and the 32 embedded bits, or null when QR (16,7,6) cannot correct it. */
export function burstEmb(burst: Uint8Array): { cc: number; pi: number; lcss: number; errors: number; emb32: Uint8Array } | null {
	const r = qr1676Decode(getBits(burst, 108, 8) * 256 + getBits(burst, 148, 8));
	return r && { cc: r[1] >> 3, pi: (r[1] >> 2) & 1, lcss: r[1] & 3, errors: r[0], emb32: burst.slice(116, 148) };
}

/** Reliability of a bit of a symbol: the sign bit is as reliable as the distance from zero, the second as the distance from +-2. */
export const bitRel = (z: number, which: number) => (which === 0 ? Math.abs(z) : Math.abs(Math.abs(z) - 2));

/** Reliability of the 196 payload bits of a data burst. */
export function payloadReliability(z: Float32Array): Float32Array {
	const rel = new Float32Array(196);
	for (let i = 0; i < 49; i++) {
		rel[2 * i] = bitRel(z[i], 0);
		rel[2 * i + 1] = bitRel(z[i], 1);
		rel[98 + 2 * i] = bitRel(z[83 + i], 0);
		rel[98 + 2 * i + 1] = bitRel(z[83 + i], 1);
	}
	return rel;
}

/**
 * BPTC (196,96) of a data burst, helped by the soft values (OnAir dmr_link.cpp bptcAssisted): when the block does not
 * decode or `validate` (CRC, Reed-Solomon, idle pattern) rejects it, the six least reliable payload bits are flipped in
 * every combination. Returns [bits corrected or -1, the 96 information bits].
 */
export function bptcAssisted(burst: Uint8Array, z: Float32Array, validate?: (info: Uint8Array) => boolean): [number, Uint8Array] {
	const pay = burstDataPayload(burst);
	const first = bptc196Decode(pay);
	if (!validate || (first[0] >= 0 && validate(first[1]))) return first;
	const rel = payloadReliability(z);
	const idx = Array.from({ length: 196 }, (_, i) => i)
		.sort((a, b) => rel[a] - rel[b])
		.slice(0, 6);
	for (let mask = 1; mask < 64; mask++) {
		const p2 = pay.slice();
		for (let i = 0; i < 6; i++) if (mask & (1 << i)) p2[idx[i]] ^= 1;
		const [c2, info] = bptc196Decode(p2);
		let flips = 0;
		for (let m = mask; m; m &= m - 1) flips++;
		if (c2 >= 0 && validate(info)) return [c2 + flips, info];
	}
	return [-1, first[1]];
}

/** The ten slot type bits: the first half (8 info bits + 2 parity) or the second half (10 parity bits). */
function putSlotType(o: number[], cc: number, dt: number, second: boolean): void {
	const info = ((cc & 15) << 4) | (dt & 15);
	const par = golay2008Parity(info);
	if (!second) {
		putBits(o, info, 8);
		putBits(o, par >> 10, 2);
	} else putBits(o, par & 0x3ff, 10);
}

/** A 264-bit data burst from the 196 payload bits: `sync` >= 0 puts that pattern in the centre, otherwise an EMB with no LC fragment. */
export function makeDataBurst(cc: number, dt: number, payload: ArrayLike<number>, sync: number): Uint8Array {
	const o: number[] = Array.from({ length: 98 }, (_, i) => payload[i]);
	putSlotType(o, cc, dt, false);
	if (sync >= 0) putBits(o, SYNC_WORDS[sync], 48);
	else {
		const info = (cc & 15) << 3;
		const qr = qr1676Parity(info);
		putBits(o, info, 7);
		putBits(o, qr >> 8, 1);
		putBits(o, 0, 32);
		putBits(o, qr & 0xff, 8);
	}
	putSlotType(o, cc, dt, true);
	for (let i = 98; i < 196; i++) o.push(payload[i]);
	return Uint8Array.from(o);
}

/** A voice burst from `vs216`; with `sync` >= 0 the centre carries that pattern, otherwise EMB (cc, pi, lcss) and `emb32`. */
export function makeVoiceBurst(
	vs216: ArrayLike<number>,
	sync: number,
	cc: number,
	pi: number,
	lcss: number,
	emb32: ArrayLike<number>,
): Uint8Array {
	const o: number[] = Array.from({ length: 108 }, (_, i) => vs216[i]);
	if (sync >= 0) putBits(o, SYNC_WORDS[sync], 48);
	else {
		const info = ((cc & 15) << 3) | ((pi & 1) << 2) | (lcss & 3);
		const qr = qr1676Parity(info);
		putBits(o, info, 7);
		putBits(o, qr >> 8, 1);
		for (let i = 0; i < 32; i++) o.push(emb32[i] ?? 0);
		putBits(o, qr & 0xff, 8);
	}
	for (let i = 108; i < 216; i++) o.push(vs216[i]);
	return Uint8Array.from(o);
}
