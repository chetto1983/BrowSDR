// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/avroad/avroad_air.cpp (the OGN part: tea, ur, sr, chkByte,
// ognWhiten, ognParityErrors, ognRepair, ognParse) and core/src/avroad/ogn_ldpc.inc (kParityCheck_n208k160),
// https://github.com/adswill/OnAir; see third_party/onair. As credited there: the LDPC (208,160) tables of the OGN
// tracker radio protocol are taken from OGN-Tracker (Pawel Jalocha) as carried in SoftRF libraries/OGN/ldpc.cpp
// (GPL-3.0), and the packet layout and value coding follow ogn.h. Changes: the generator table (kParityGen_n208k160,
// used only to make test packets) lives in the test fixtures; the bit-flip map is built on first use.

import type { OgnPacket } from './types';

/** Sync word of the OGN tracker protocol; on air the chips AA66 55A5 9699 965A. */
export const OGN_SYNC = 0x0af3656c;
export const OGN_BYTES = 26;
export const OGN_BITS = 208;

/** Parity checks of the (208,160) code: 48 rows of 208 bits, 7 little-endian words per row. */
// prettier-ignore
const PARITY_CHECK = new Uint32Array([
	0x00000805, 0x00000020, 0x04000000, 0x20000000, 0x00000040, 0x00044020, 0x00000000,
	0x00000001, 0x00800800, 0x00000000, 0x00000000, 0x00000000, 0x10010000, 0x00008c98,
	0x00004001, 0x01000080, 0x80000400, 0x00000000, 0x08000200, 0x00200000, 0x00000005,
	0x00000101, 0x20000200, 0x00000022, 0x00000000, 0x00000000, 0xcc008000, 0x00005002,
	0x00000401, 0x00000000, 0x00004900, 0x00000020, 0x00000000, 0x20c00349, 0x00000020,
	0x03140001, 0x00000002, 0x00000000, 0x40000001, 0x41534100, 0x00102c00, 0x00002000,
	0x04008800, 0x82000642, 0x00000000, 0x00000020, 0x88040020, 0x03000010, 0x00000400,
	0x00000802, 0x20000000, 0x02000014, 0x01200000, 0x04000403, 0x00800004, 0x0000a004,
	0x02020820, 0x00000000, 0x80020820, 0x10190040, 0x30000000, 0x00000002, 0x00000900,
	0x40804950, 0x00090000, 0x00000000, 0x00021204, 0x40001000, 0x10001100, 0x00000000,
	0x08000a00, 0x00020008, 0x00040000, 0x02400010, 0x01002000, 0x40280280, 0x00000010,
	0x00000000, 0x00008010, 0x118000a0, 0x00040080, 0x01000084, 0x00040100, 0x00000444,
	0x20040108, 0x18000000, 0x08608800, 0x0000000a, 0x08000010, 0x00040080, 0x00008000,
	0x00004080, 0x00422201, 0x00010000, 0x0000a400, 0x00400800, 0x00840000, 0x00000800,
	0x00000000, 0x60200000, 0x80100240, 0x08000021, 0x02800000, 0x100c0000, 0x00000000,
	0x00001000, 0x01010002, 0x00082001, 0x04000000, 0x00000001, 0x00040002, 0x00004030,
	0x00002300, 0x04000000, 0xa0080000, 0x20004000, 0x00028000, 0x00800000, 0x00000400,
	0x00004000, 0x00104100, 0x40041028, 0x24000020, 0x00200000, 0x00100000, 0x00008000,
	0x08011000, 0x20040000, 0x00000000, 0xa0800000, 0x08090000, 0x00000100, 0x00000a00,
	0x10180000, 0x00000204, 0x00002800, 0x20400800, 0x00000000, 0x10000000, 0x00000004,
	0x00000000, 0xc0000000, 0x10200000, 0x20028000, 0x20000000, 0x80000008, 0x00002011,
	0x82004000, 0x20000000, 0x04202000, 0x00000000, 0x00000000, 0x00020200, 0x00000400,
	0x08600000, 0x00001200, 0x94000000, 0x00000000, 0x40000008, 0x00000000, 0x00008020,
	0x04040000, 0x04010000, 0x04100000, 0x00000100, 0x00200000, 0x40000008, 0x00000804,
	0x00000200, 0x00000110, 0x04000100, 0x00000000, 0x28400400, 0x10000000, 0x00004000,
	0x00080000, 0x00000080, 0x04001000, 0x01882007, 0x00008024, 0x04000001, 0x00000010,
	0x20200000, 0x00000020, 0x00010040, 0x81000800, 0x10001000, 0x00300008, 0x00004400,
	0x90000010, 0x89841021, 0x00000118, 0x08080000, 0x00020000, 0x40000000, 0x00000040,
	0x04c20000, 0x10404034, 0x00000000, 0x00004000, 0x00810001, 0x04000200, 0x00000009,
	0x40102000, 0x020020a0, 0x40100000, 0x00100080, 0x00080400, 0x80030080, 0x00000020,
	0x00010000, 0x04020920, 0x00000200, 0x00060000, 0x00000218, 0x01002007, 0x00001000,
	0x00020008, 0x00a08040, 0x00080000, 0x40001400, 0x04200040, 0x80200001, 0x00000200,
	0x40000402, 0x01100000, 0x20808000, 0x00008000, 0x10100060, 0x00080000, 0x00001008,
	0x200010a0, 0x00000000, 0x01040100, 0x00000104, 0x02040042, 0x08012000, 0x00000001,
	0x01000000, 0x50000880, 0x00000092, 0x14400000, 0x00001840, 0x02400000, 0x00000000,
	0x00000010, 0x02000000, 0x00014000, 0x00200018, 0x00000240, 0x04000800, 0x00000180,
	0x00008000, 0x00880008, 0x08000044, 0x00100000, 0x00000004, 0x00400820, 0x00001001,
	0x01000000, 0x00002000, 0x02004001, 0x00000042, 0x00000000, 0x09201020, 0x00000048,
	0x00800000, 0x01000400, 0x00400002, 0xc0002000, 0x00002080, 0x00010064, 0x00000100,
	0x00000400, 0x08400840, 0x00000400, 0x00000890, 0x00008102, 0x00000020, 0x00000002,
	0x00200040, 0x00000081, 0x00000000, 0x02050000, 0x04940000, 0x20008020, 0x00000080,
	0x00000404, 0x00800000, 0x00001000, 0x00014000, 0x00082200, 0x0a000400, 0x00000000,
	0x0000a024, 0x00000000, 0x00000402, 0x08a01000, 0x00004010, 0x20000000, 0x00000008,
	0x00480046, 0x00008000, 0x00000208, 0x00000048, 0x00000000, 0x00410010, 0x00000002,
	0x0000008c, 0x00044c00, 0x00824004, 0x00000200, 0x00000000, 0x00028000, 0x00000000,
	0x10010004, 0x00080000, 0x43008000, 0x10000400, 0x80000100, 0x00000040, 0x00000080,
	0x80000000, 0x0020000c, 0x20420480, 0x00000100, 0x00000008, 0x00005410, 0x00000080,
	0x00000000, 0x00101000, 0x08000001, 0x02000200, 0x82004a80, 0x00004000, 0x00000202,
]);

const rd32 = (b: ArrayLike<number>, o: number): number => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
function wr32(b: Uint8Array, o: number, v: number): void {
	b[o] = v;
	b[o + 1] = v >>> 8;
	b[o + 2] = v >>> 16;
	b[o + 3] = v >>> 24;
}
export function popcount(value: number): number {
	let x = value - ((value >>> 1) & 0x55555555);
	x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
	return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

const TEA_DELTA = 0x9e3779b9;
const teaStep = (x: number, s: number): number => ((x << 4) ^ (x + s) ^ (x >>> 5)) >>> 0;

/** TEA with 8 loops on the word pair d[o], d[o + 1] and an all-zero key: the whitening of positions. */
function tea(d: Uint32Array, o: number, enc: boolean): void {
	let a = d[o];
	let b = d[o + 1];
	if (enc) {
		let s = 0;
		for (let i = 0; i < 8; i++) {
			s = (s + TEA_DELTA) >>> 0;
			a = (a + teaStep(b, s)) >>> 0;
			b = (b + teaStep(a, s)) >>> 0;
		}
	} else {
		let s = (TEA_DELTA * 8) % 0x100000000;
		for (let i = 0; i < 8; i++) {
			b = (b - teaStep(a, s)) >>> 0;
			a = (a - teaStep(b, s)) >>> 0;
			s = (s - TEA_DELTA) >>> 0;
		}
	}
	d[o] = a;
	d[o + 1] = b;
}

/** The floating formats: two range bits over `mant` bits, steps 1, 2, 4, 8. */
function ur(v: number, mant: number): number {
	const r = v >>> mant;
	v &= (1 << mant) - 1;
	const b = 1 << mant;
	if (r === 0) return v;
	if (r === 1) return b + 1 + (v << 1);
	if (r === 2) return 3 * b + 2 + (v << 2);
	return 7 * b + 4 + (v << 3);
}
function sr(v: number, mant: number): number {
	const m = ur(v & ((1 << (mant + 2)) - 1), mant);
	return (v >>> (mant + 2)) & 1 ? -m : m;
}

const chkByte = (row: number, byte: number): number => (PARITY_CHECK[row * 7 + (byte >> 2)] >>> ((byte & 3) * 8)) & 0xff;

/** The transmit-side scrambling of the position words (used by the tests). */
export function ognWhiten(p: Uint8Array): void {
	const d = new Uint32Array(4);
	for (let i = 0; i < 4; i++) d[i] = rd32(p, 4 + 4 * i);
	tea(d, 0, true);
	tea(d, 2, true);
	for (let i = 0; i < 4; i++) wr32(p, 4 + 4 * i, d[i]);
}

/** Failed checks of the (208,160) LDPC code. */
export function ognParityErrors(p: ArrayLike<number>): number {
	let bad = 0;
	for (let r = 0; r < 48; r++) {
		let c = 0;
		for (let b = 0; b < OGN_BYTES; b++) c += popcount(p[b] & chkByte(r, b));
		bad += c & 1;
	}
	return bad;
}

let checkBits: Int16Array[] | undefined;
/** For every check, the bits it covers (numbered byte by byte, most significant first). */
function checkMap(): Int16Array[] {
	checkBits ??= Array.from({ length: 48 }, (_, r) => {
		const bits: number[] = [];
		for (let b = 0; b < OGN_BYTES; b++) for (let k = 0; k < 8; k++) if ((chkByte(r, b) >> k) & 1) bits.push(b * 8 + (7 - k));
		return Int16Array.from(bits);
	});
	return checkBits;
}

/** The bit to flip next: the weakest evidence among the bits of the most failed checks. */
function weakest(fail: Int32Array, bits: Uint8Array, soft: ArrayLike<number>): number {
	let best = -1;
	let bestM = 1e30;
	for (let i = 0; i < OGN_BITS; i++) {
		if (fail[i] < 2) continue;
		const q = (Math.abs(soft[i]) * 0.5) / fail[i] + (soft[i] > 0 === (bits[i] !== 0) ? 0 : -1);
		if (q < bestM) {
			bestM = q;
			best = i;
		}
	}
	if (best >= 0) return best;
	for (let i = 0; i < OGN_BITS; i++)
		if (fail[i] && Math.abs(soft[i]) < bestM) {
			bestM = Math.abs(soft[i]);
			best = i;
		}
	return best;
}

/** Gallager-style bit flipping on the 208 bits, weakest evidence first; soft > 0 means a one. Repairs p in place. */
export function ognRepair(p: Uint8Array, soft: ArrayLike<number>, iterations = 30): boolean {
	const map = checkMap();
	const bits = new Uint8Array(OGN_BITS);
	for (let i = 0; i < OGN_BITS; i++) bits[i] = (p[i >> 3] >> (7 - (i & 7))) & 1;
	const fail = new Int32Array(OGN_BITS);
	for (let it = 0; it < iterations; it++) {
		fail.fill(0);
		let total = 0;
		for (const row of map) {
			let par = 0;
			for (const k of row) par ^= bits[k];
			if (!par) continue;
			total++;
			for (const k of row) fail[k]++;
		}
		if (!total) {
			p.fill(0, 0, OGN_BYTES);
			for (let i = 0; i < OGN_BITS; i++) p[i >> 3] |= bits[i] << (7 - (i & 7));
			return true;
		}
		const best = weakest(fail, bits, soft);
		if (best < 0) return false;
		bits[best] ^= 1;
	}
	return false;
}

function emptyPacket(h: number): OgnPacket {
	return {
		address: h & 0xffffff,
		addrType: (h >>> 24) & 3,
		other: !!((h >>> 26) & 1),
		relay: (h >>> 28) & 3,
		encrypted: !!((h >>> 30) & 1),
		emergency: !!((h >>> 31) & 1),
		addrParityOk: !(popcount(h & 0x0fffffff) & 1),
		lat: 0,
		lon: 0,
		altM: 0,
		speedMs: 0,
		headingDeg: 0,
		climbMs: 0,
		turnDegS: 0,
		acftType: 0,
		fixQuality: 0,
		second: 0,
		stealth: false,
	};
}

/** The fields of a packet (a copy is dewhitened); an encrypted packet's position fields are left at zero. */
export function ognParse(p: ArrayLike<number>): OgnPacket {
	const w = new Uint32Array(5);
	for (let i = 0; i < 5; i++) w[i] = rd32(p, 4 * i);
	const o = emptyPacket(w[0]);
	if (o.encrypted) return o;
	tea(w, 1, false);
	tea(w, 3, false);
	const lat = (w[1] << 8) >> 8;
	const lon = (w[2] << 8) >> 8;
	o.lat = ((lat * 8 + 4) * 0.0001) / 60;
	o.lon = ((lon * 16 + 8) * 0.0001) / 60;
	o.second = (w[1] >>> 24) & 0x3f;
	o.fixQuality = w[1] >>> 30;
	o.altM = ur(w[3] & 0x3fff, 12);
	o.speedMs = ur((w[3] >>> 14) & 0x3ff, 8) * 0.1;
	o.turnDegS = sr((w[3] >>> 24) & 0xff, 5) * 0.1;
	o.headingDeg = (((w[4] & 0x3ff) * 3600 + 512) >> 10) * 0.1;
	o.climbMs = sr((w[4] >>> 10) & 0x1ff, 6) * 0.1;
	o.stealth = !!((w[4] >>> 19) & 1);
	o.acftType = (w[4] >>> 20) & 0xf;
	return o;
}

const OGN_AIRCRAFT = [
	'unknown',
	'glider',
	'tow plane',
	'helicopter',
	'skydiver',
	'drop plane',
	'hang glider',
	'paraglider',
	'powered aircraft',
	'jet',
	'UFO',
	'balloon',
	'airship',
	'UAV',
	'ground support',
	'static',
];
export const ognAircraftName = (t: number): string => OGN_AIRCRAFT[t & 15];
export const ognAddrName = (t: number): string => ['random', 'ICAO', 'FLARM', 'OGN'][t & 3];
