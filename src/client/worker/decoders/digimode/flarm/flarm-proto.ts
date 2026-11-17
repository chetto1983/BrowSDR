// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/flarm/flarm_proto.cpp and core/include/dect2/flarm/flarm_proto.h
// (crc16, btea, obscure, makeV6Key, packetType, packetAddr, encodeV6, decodeV6, packPosition, unpackPosition,
// unpackVelocity, packVelocity, aircraftTypeName, addrTypeName, manchester, frameToChips, checkCrc),
// https://github.com/adswill/OnAir; see third_party/onair. As credited there: the constants and the layout of the old
// (V6) protocol follow the open SoftRF (Legacy) and OGN descriptions. Changes: CRC-16/CCITT-FALSE and Manchester coding
// written out (OnAir calls its common crc and linecode helpers); C rounding (lround) and int8 wrapping done by hand.

import type { FlarmDecodeResult, FlarmV6 } from './types';

/** Sync word after Manchester decoding; on air the chips 55 99 A5 A9 55 66 65 96. */
export const FLARM_SYNC = 0xf531fab6;
export const PAYLOAD_BYTES = 24;
/** Payload and CRC. */
export const FRAME_BYTES = 26;
export const CHIP_RATE = 100000;
export const ADDR_RANDOM = 0;
export const ADDR_ICAO = 1;
export const ADDR_FLARM = 2;
export const ADDR_ANONYMOUS = 3;

const KEY1 = [0xe43276df, 0xdca83759, 0x9802b8ac, 0x4675a56b, 0xfc78ea65, 0x804b90ea, 0xb76542cd, 0x329dfa32];
const KEY2 = 0x045d9f3b;
const KEY3 = 0x87b562f4;
const DELTA = 0x9e3779b9;

/** C's lround: halves away from zero. */
export const lround = (x: number): number => (x < 0 ? -Math.round(-x) : Math.round(x));
const int8 = (v: number): number => (v << 24) >> 24;
const signExt = (v: number, bits: number): number => (v << (32 - bits)) >> (32 - bits);

const rd32 = (b: ArrayLike<number>, o: number): number => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
function wr32(b: Uint8Array, o: number, v: number): void {
	b[o] = v;
	b[o + 1] = v >>> 8;
	b[o + 2] = v >>> 16;
	b[o + 3] = v >>> 24;
}
function parity8(v: number): number {
	v ^= v >> 4;
	v ^= v >> 2;
	return (v ^ (v >> 1)) & 1;
}

/** CRC-16/CCITT-FALSE: polynomial 0x1021, start 0xFFFF, MSB first. */
export function crc16(d: ArrayLike<number>, n = d.length): number {
	let crc = 0xffff;
	for (let i = 0; i < n; i++) {
		crc ^= d[i] << 8;
		for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
	}
	return crc;
}

const mx = (y: number, z: number, sum: number, p: number, e: number, key: ArrayLike<number>): number =>
	((((z >>> 5) ^ (y << 2)) + ((y >>> 3) ^ (z << 4))) ^ ((sum ^ y) + (key[(p & 3) ^ e] ^ z))) >>> 0;

/** XXTEA on n words (n > 0 encrypts, n < 0 decrypts). rounds 0: the standard 6 + 52 / n; FLARM uses 6. */
export function btea(v: Uint32Array, n: number, key: ArrayLike<number>, rounds = 6): void {
	if (n > 1) {
		let r = rounds || 6 + Math.floor(52 / n);
		let sum = 0;
		let z = v[n - 1];
		let y: number;
		do {
			sum = (sum + DELTA) >>> 0;
			const e = (sum >>> 2) & 3;
			let p = 0;
			for (; p < n - 1; p++) {
				y = v[p + 1];
				v[p] += mx(y, z, sum, p, e, key);
				z = v[p];
			}
			y = v[0];
			v[n - 1] += mx(y, z, sum, p, e, key);
			z = v[n - 1];
		} while (--r);
	} else if (n < -1) {
		n = -n;
		let r = rounds || 6 + Math.floor(52 / n);
		let sum = (r * DELTA) % 0x100000000;
		let y = v[0];
		let z: number;
		do {
			const e = (sum >>> 2) & 3;
			let p = n - 1;
			for (; p > 0; p--) {
				z = v[p - 1];
				v[p] -= mx(y, z, sum, p, e, key);
				y = v[p];
			}
			z = v[n - 1];
			v[0] -= mx(y, z, sum, p, e, key);
			y = v[0];
			sum = (sum - DELTA) >>> 0;
		} while (--r);
	}
}

export function obscure(key: number, seed: number): number {
	const m1 = Math.imul(seed, (key ^ (key >>> 16)) >>> 0) >>> 0;
	const m2 = Math.imul(seed, (m1 ^ (m1 >>> 16)) >>> 0) >>> 0;
	return (m2 ^ (m2 >>> 16)) >>> 0;
}

/** The key of a V6 packet: unix time (64 s steps) and the sender's address, (addr << 8) & 0xFFFFFF. */
export function makeV6Key(ts: number, addrShifted: number): Uint32Array {
	const key = new Uint32Array(4);
	for (let i = 0; i < 4; i++) {
		const ndx = (ts >>> 23) & 1 ? i + 4 : i;
		key[i] = obscure((KEY1[ndx] ^ ((ts >>> 6) ^ addrShifted)) >>> 0, KEY2) ^ KEY3;
	}
	return key;
}

/** The clear header: 0 V6, 2 the newer protocol. */
export const packetType = (b: ArrayLike<number>): number => (rd32(b, 0) >>> 24) & 15;
export const packetAddr = (b: ArrayLike<number>): number => rd32(b, 0) & 0xffffff;

export function emptyV6(): FlarmV6 {
	return {
		addr: 0,
		type: 0,
		addrType: ADDR_FLARM,
		vsRaw: 0,
		airborne: true,
		stealth: false,
		noTrack: false,
		gps: 323,
		aircraftType: 1,
		lat19: 0,
		lon20: 0,
		alt: 0,
		smult: 0,
		ns: [0, 0, 0, 0],
		ew: [0, 0, 0, 0],
	};
}

const byteWord = (a: number[]): number => ((a[0] & 255) | ((a[1] & 255) << 8) | ((a[2] & 255) << 16) | ((a[3] & 255) << 24)) >>> 0;

function v6Words(p: FlarmV6): number[] {
	const b = (v: boolean) => (v ? 1 : 0);
	return [
		((p.addr & 0xffffff) | ((p.type & 15) << 24) | ((p.addrType & 7) << 28)) >>> 0,
		((p.vsRaw & 0x3ff) |
			(b(p.airborne) << 12) |
			(b(p.stealth) << 13) |
			(b(p.noTrack) << 14) |
			((p.gps & 0xfff) << 16) |
			((p.aircraftType & 15) << 28)) >>>
			0,
		((p.lat19 & 0x7ffff) | ((p.alt & 0x1fff) << 19)) >>> 0,
		((p.lon20 & 0xfffff) | ((p.smult & 3) << 30)) >>> 0,
		byteWord(p.ns),
		byteWord(p.ew),
	];
}

/** The 24 bytes of a packet, encrypted for unix time `ts`. */
export function encodeV6(p: FlarmV6, ts: number): Uint8Array {
	const w = v6Words(p);
	const b = new Uint8Array(PAYLOAD_BYTES);
	w.forEach((v, i) => wr32(b, 4 * i, v));
	let par = 0;
	for (let i = 0; i < PAYLOAD_BYTES; i++) par ^= parity8(b[i]);
	if (par) wr32(b, 4, (w[1] | (1 << 15)) >>> 0);
	const e = new Uint32Array(5);
	for (let i = 0; i < 5; i++) e[i] = rd32(b, 4 + 4 * i);
	btea(e, 5, makeV6Key(ts, (p.addr << 8) & 0xffffff), 6);
	for (let i = 0; i < 5; i++) wr32(b, 4 + 4 * i, e[i]);
	return b;
}

function v6Fields(w0: number, e: Uint32Array): FlarmV6 {
	const [w1, w2, w3, w4, w5] = e;
	return {
		addr: w0 & 0xffffff,
		type: (w0 >>> 24) & 15,
		addrType: (w0 >>> 28) & 7,
		vsRaw: signExt(w1 & 0x3ff, 10),
		airborne: !!((w1 >>> 12) & 1),
		stealth: !!((w1 >>> 13) & 1),
		noTrack: !!((w1 >>> 14) & 1),
		gps: (w1 >>> 16) & 0xfff,
		aircraftType: (w1 >>> 28) & 15,
		lat19: w2 & 0x7ffff,
		alt: w2 >>> 19,
		lon20: w3 & 0xfffff,
		smult: w3 >>> 30,
		ns: [0, 1, 2, 3].map((i) => int8(w4 >>> (8 * i))),
		ew: [0, 1, 2, 3].map((i) => int8(w5 >>> (8 * i))),
	};
}

/** Decrypts with the key of unix time `ts` and checks the parity of the result. */
export function decodeV6(raw: ArrayLike<number>, ts: number): { result: FlarmDecodeResult; packet?: FlarmV6 } {
	const w0 = rd32(raw, 0);
	if (((w0 >>> 24) & 15) !== 0) return { result: 'notV6' };
	const e = new Uint32Array(5);
	for (let i = 0; i < 5; i++) e[i] = rd32(raw, 4 + 4 * i);
	btea(e, -5, makeV6Key(ts, (w0 << 8) & 0xffffff), 6);
	let par = parity8(w0 & 255) ^ parity8((w0 >>> 8) & 255) ^ parity8((w0 >>> 16) & 255) ^ parity8(w0 >>> 24);
	for (const v of e) par ^= parity8(v & 255) ^ parity8((v >>> 8) & 255) ^ parity8((v >>> 16) & 255) ^ parity8(v >>> 24);
	if (par) return { result: 'badParity' };
	return { result: 'ok', packet: v6Fields(w0, e) };
}

const round7 = (v: number): number => (v >> 7) + (v & 0x40 ? (v < 0 ? -1 : 1) : 0);

/** Degrees to the packet's 19 / 20 low position bits. */
export function packPosition(latDeg: number, lonDeg: number): { lat19: number; lon20: number } {
	const lat = lround(latDeg * 1e7) | 0;
	const lon = lround(lonDeg * 1e7) | 0;
	return { lat19: round7(lat) & 0x7ffff, lon20: round7(lon) & 0xfffff };
}

/** The position bits around a reference position (valid within ±3° of latitude and ±6° of longitude). */
export function unpackPosition(lat19: number, lon20: number, refLat: number, refLon: number): { lat: number; lon: number } {
	const rl = (lround(refLat * 1e7) | 0) >> 7;
	const ro = (lround(refLon * 1e7) | 0) >> 7;
	let la = (lat19 - rl) & 0x7ffff;
	if (la >= 0x40000) la -= 0x80000;
	let lo = (lon20 - ro) & 0xfffff;
	if (lo >= 0x80000) lo -= 0x100000;
	return { lat: ((la + rl) * 128) / 1e7, lon: ((lo + ro) * 128) / 1e7 };
}

/** Ground speed (m/s), track (degrees) and climb (m/s) of the velocity fields. */
export function unpackVelocity(p: FlarmV6): { speedMs: number; trackDeg: number; climbMs: number } {
	const ns = Math.trunc((p.ns[0] + p.ns[1] + p.ns[2] + p.ns[3]) / 4);
	const ew = Math.trunc((p.ew[0] + p.ew[1] + p.ew[2] + p.ew[3]) / 4);
	const speedMs = (Math.sqrt(ew * ew + ns * ns) * (1 << p.smult)) / 4;
	let trackDeg = 0;
	if (ns || ew) {
		trackDeg = (Math.atan2(ew, ns) * 180) / Math.PI;
		if (trackDeg < 0) trackDeg += 360;
	}
	return { speedMs, trackDeg, climbMs: (p.vsRaw * (1 << p.smult)) / 10 };
}

export function packVelocity(speedMs: number, trackDeg: number, climbMs: number, p: FlarmV6): void {
	const s4 = Math.min(lround(speedMs * 4), 0x3ff);
	p.smult = s4 & 0x200 ? 3 : s4 & 0x100 ? 2 : s4 & 0x080 ? 1 : 0;
	const speed = s4 >> p.smult;
	const a = (trackDeg * Math.PI) / 180;
	const ns = int8(Math.trunc(speed * Math.cos(a)));
	const ew = int8(Math.trunc(speed * Math.sin(a)));
	p.ns = [ns, ns, ns, ns];
	p.ew = [ew, ew, ew, ew];
	p.vsRaw = Math.max(-512, Math.min(511, lround(climbMs * 10) >> p.smult));
}

const AIRCRAFT_TYPES = [
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
	'gyrocopter',
	'balloon',
	'airship',
	'UAV',
	'reserved',
	'static object',
];
export const aircraftTypeName = (t: number): string => AIRCRAFT_TYPES[t & 15];
export const addrTypeName = (t: number): string => ['random', 'ICAO', 'FLARM', 'anonymous'][t & 3];

/** Manchester chips of bytes, MSB first: a 1 is the chip pair 01, a 0 is 10. */
export function manchester(bytes: ArrayLike<number>): number[] {
	const chips: number[] = [];
	for (let i = 0; i < bytes.length; i++)
		for (let k = 7; k >= 0; k--) {
			const bit = (bytes[i] >> k) & 1;
			chips.push(bit ^ 1, bit);
		}
	return chips;
}

/** The chips of a frame: the sync word (optional), the 24 payload bytes and their CRC. */
export function frameToChips(payload: ArrayLike<number>, withSync = true): number[] {
	const f = new Uint8Array(FRAME_BYTES);
	for (let i = 0; i < PAYLOAD_BYTES; i++) f[i] = payload[i];
	const c = crc16(f, PAYLOAD_BYTES);
	f[24] = c >> 8;
	f[25] = c & 255;
	return [...(withSync ? manchester([0xf5, 0x31, 0xfa, 0xb6]) : []), ...manchester(f)];
}

/** The CRC of a 26-byte frame, in either byte order. */
export function checkCrc(f: ArrayLike<number>): boolean {
	const c = crc16(f, PAYLOAD_BYTES);
	return (f[24] === c >> 8 && f[25] === (c & 255)) || (f[25] === c >> 8 && f[24] === (c & 255));
}
