// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/adsl/adsl_proto.cpp and core/include/dect2/adsl/adsl_proto.h
// (getBits, setBits, scramble, crc24, expDecode, expEncode, packTraffic, unpackTraffic, packStatus, unpackStatus,
// makeData, makeNetwork, checkParity, correctCrc, parseNetwork, categoryName, emergencyName, amtName),
// https://github.com/adswill/OnAir; see third_party/onair. As credited there: written from the EASA ADS-L 4 SRD-860
// specification (Issue 2); the OGN / SoftRF ads-l.h (GPL-3.0) was read to settle what the specification leaves open.
// Changes: only the M-band (868.2 / 868.4 MHz) is received here, so the O-band CRC-8 and frameChips (the chips of a
// frame, used by OnAir's generator) are not ported (the M-band frame is built in the test fixtures).

import { btea, lround } from './flarm-proto';
import { RS_PARITY, rsDecode, rsEncode } from './adsl-rs';
import type { AdslParsed, AdslStatus, AdslTraffic } from './types';

/** After Manchester decoding: four preamble 1s, the 0101 of the "1001 1001" tail, sync 0x72 0x4B. */
export const ADSL_SYNC = 0xf5724b;
export const ADSL_SYNC_BITS = 24;
/** Network header, ADS-L data and CRC: the Length byte of a Traffic packet. */
export const TRAFFIC_NET_BYTES = 24;
export const STATUS_NET_BYTES = 16;
export const MAX_TARGETS = 10;
export const TYPE_TRAFFIC = 2;
export const TYPE_STATUS = 3;
export const TYPE_UPLINK = 4;
export const TYPE_FISB = 5;
export const TYPE_REMOTE_ID = 6;
export const AMT_RANDOM = 0;
export const AMT_ICAO = 5;
export const AMT_FLARM = 6;
export const AMT_OGN = 7;
export const AMT_FANET = 8;

const ZERO_KEY = [0, 0, 0, 0];

/** n bits from bit `off` (counted from the least significant bit of byte 0). */
export function getBits(d: ArrayLike<number>, off: number, n: number): number {
	let v = 0;
	for (let i = 0; i < n; i++) if ((d[(off + i) >> 3] >> ((off + i) & 7)) & 1) v += 2 ** i;
	return v;
}
export function setBits(d: Uint8Array, off: number, n: number, v: number): void {
	for (let i = 0; i < n; i++) {
		const b = off + i;
		const bit = Math.floor(v / 2 ** i) & 1;
		d[b >> 3] = (d[b >> 3] & ~(1 << (b & 7))) | (bit << (b & 7));
	}
}

/** XXTEA with the published all-zero key and 6 rounds over whole words (scramble / descramble). */
function scramble(b: Uint8Array, encrypt: boolean): void {
	const words = b.length >> 2;
	if (words < 2) return;
	const w = new Uint32Array(words);
	for (let i = 0; i < words; i++) w[i] = (b[4 * i] | (b[4 * i + 1] << 8) | (b[4 * i + 2] << 16) | (b[4 * i + 3] << 24)) >>> 0;
	btea(w, encrypt ? words : -words, ZERO_KEY, 6);
	for (let i = 0; i < words; i++) for (let k = 0; k < 4; k++) b[4 * i + k] = w[i] >>> (8 * k);
}

/** The specification's CRC-24 routine (the Mode S polynomial): the 3 low bytes. */
export function crc24(d: ArrayLike<number>, n = d.length): number {
	let crc = 0;
	const pass = (input: number) => {
		crc = (crc | input) >>> 0;
		for (let b = 0; b < 8; b++) {
			if (crc & 0x80000000) crc = (crc ^ 0xfffa0480) >>> 0;
			crc = (crc << 1) >>> 0;
		}
	};
	for (let i = 0; i < n; i++) pass(d[i]);
	pass(0);
	pass(0);
	pass(0);
	return crc >>> 8;
}

/** Exponential fields: N is the width of the base. */
export function expDecode(raw: number, n: number): number {
	const e = raw >>> n;
	const base = raw & ((1 << n) - 1);
	return ((1 << n) + base) * 2 ** e - (1 << n);
}
function expEncodeFull(v: number, n: number): number {
	let e = 3;
	while (e > 0 && v < 2 ** (n + e) - 2 ** n) e--;
	let base = Math.floor((v + 2 ** n - 2 ** (n + e)) / 2 ** e);
	if (base >= 1 << n) base = (1 << n) - 1;
	return (e << n) | base;
}
/** Clamps to the largest code below the all-ones "invalid" one. */
export function expEncode(v: number, n: number): number {
	const r = expEncodeFull(v, n);
	return r === (4 << n) - 1 ? r - 1 : r;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export function emptyTraffic(): AdslTraffic {
	return {
		amt: AMT_FLARM,
		addr: 0,
		relay: false,
		timeQ: 0,
		flightState: 0,
		category: 0,
		emergency: 1,
		hasPos: false,
		lat: 0,
		lon: 0,
		hasAlt: false,
		altM: 0,
		hasSpeed: false,
		speedMs: 0,
		hasClimb: false,
		climbMs: 0,
		hasTrack: false,
		trackDeg: 0,
		sil: 0,
		design: 0,
		nic: 0,
		hAcc: 0,
		vAcc: 0,
		velAcc: 0,
	};
}

function climbCode(t: AdslTraffic): number {
	if (!t.hasClimb) return 0x1ff;
	const q = lround(t.climbMs * 8);
	let cl = expEncodeFull(Math.abs(q), 6); // +119 m/s is 0x0FF; the same magnitude downwards would be the "invalid" 0x1FF
	if (q < 0) {
		if (cl === 0xff) cl = 0xfe;
		cl |= 0x100;
	}
	return cl;
}

/** The 15-byte Traffic payload. */
export function packTraffic(t: AdslTraffic): Uint8Array {
	const p = new Uint8Array(15);
	setBits(p, 0, 6, t.timeQ & 63);
	setBits(p, 6, 2, t.flightState & 3);
	setBits(p, 8, 5, t.category & 31);
	setBits(p, 13, 3, t.emergency & 7);
	const la = t.hasPos ? clamp(lround(t.lat * 93206), -0x7fffff, 0x7fffff) & 0xffffff : 0x800000;
	const lo = t.hasPos ? clamp(lround(t.lon * 46603), -0x7fffff, 0x7fffff) & 0xffffff : 0x800000;
	setBits(p, 16, 24, la);
	setBits(p, 40, 24, lo);
	setBits(p, 64, 8, t.hasSpeed ? expEncode(lround(Math.max(0, t.speedMs) * 4), 6) : 0xff);
	setBits(p, 72, 14, t.hasAlt ? expEncode(Math.max(0, t.altM + 320), 12) : 0x3fff);
	setBits(p, 86, 9, climbCode(t));
	setBits(p, 95, 9, t.hasTrack ? lround((((t.trackDeg + 360) % 360) * 512) / 360) & 511 : 0);
	setBits(p, 104, 2, t.sil);
	setBits(p, 106, 2, t.design);
	setBits(p, 108, 4, t.nic);
	setBits(p, 112, 3, t.hAcc);
	setBits(p, 115, 2, t.vAcc);
	setBits(p, 117, 2, t.velAcc);
	return p;
}

function unpackKinematics(p: ArrayLike<number>, o: AdslTraffic): void {
	const sp = getBits(p, 64, 8);
	if (sp !== 0xff) {
		o.hasSpeed = true;
		o.speedMs = expDecode(sp, 6) * 0.25;
	}
	const al = getBits(p, 72, 14);
	if (al !== 0x3fff) {
		o.hasAlt = true;
		o.altM = expDecode(al, 12) - 320;
	}
	const cl = getBits(p, 86, 9);
	// 0x1FF invalid (Issue 2); 0x100 ("minus zero") is what OGN and SoftRF trackers send for "no climb rate"
	if (cl !== 0x1ff && cl !== 0x100) {
		o.hasClimb = true;
		o.climbMs = expDecode(cl & 0xff, 6) * 0.125 * (cl & 0x100 ? -1 : 1);
	}
	o.hasTrack = o.hasSpeed && sp !== 0;
	if (o.hasTrack) o.trackDeg = (getBits(p, 95, 9) * 360) / 512;
}

export function unpackTraffic(p: ArrayLike<number>, amt: number, addr: number, relay: boolean): AdslTraffic {
	const o = emptyTraffic();
	Object.assign(o, { amt, addr, relay });
	o.timeQ = getBits(p, 0, 6);
	o.flightState = getBits(p, 6, 2);
	o.category = getBits(p, 8, 5);
	o.emergency = getBits(p, 13, 3);
	const la = getBits(p, 16, 24);
	const lo = getBits(p, 40, 24);
	if (la !== 0x800000 && lo !== 0x800000) {
		o.lat = ((la << 8) >> 8) / 93206;
		o.lon = ((lo << 8) >> 8) / 46603;
		o.hasPos = Math.abs(o.lat) <= 90 && Math.abs(o.lon) <= 180;
	}
	unpackKinematics(p, o);
	o.sil = getBits(p, 104, 2);
	o.design = getBits(p, 106, 2);
	o.nic = getBits(p, 108, 4);
	o.hAcc = getBits(p, 112, 3);
	o.vAcc = getBits(p, 115, 2);
	o.velAcc = getBits(p, 117, 2);
	return o;
}

const STATUS_LAYOUT = {
	maxVersion: [0, 4],
	mRx: [4, 2],
	ldrRx: [6, 2],
	hdrRx: [8, 2],
	mobile: [10, 2],
	econRx: [12, 8],
	econTx: [20, 8],
	xpdr: [28, 2],
} as const;

/** The 7-byte Status payload. */
export function packStatus(s: AdslStatus): Uint8Array {
	const p = new Uint8Array(7);
	for (const [key, [off, n]] of Object.entries(STATUS_LAYOUT)) setBits(p, off, n, s[key as keyof typeof STATUS_LAYOUT]);
	setBits(p, 30, 1, s.trafficClient ? 1 : 0);
	setBits(p, 31, 1, s.fisClient ? 1 : 0);
	return p;
}

export function unpackStatus(p: ArrayLike<number>, amt: number, addr: number): AdslStatus {
	const field = (key: keyof typeof STATUS_LAYOUT) => getBits(p, STATUS_LAYOUT[key][0], STATUS_LAYOUT[key][1]);
	return {
		amt,
		addr,
		maxVersion: field('maxVersion'),
		mRx: field('mRx'),
		ldrRx: field('ldrRx'),
		hdrRx: field('hdrRx'),
		mobile: field('mobile'),
		econRx: field('econRx'),
		econTx: field('econTx'),
		xpdr: field('xpdr'),
		trafficClient: getBits(p, 30, 1) !== 0,
		fisClient: getBits(p, 31, 1) !== 0,
	};
}

/** ADS-L Data: type, sender address, payload (clear text). */
export function makeData(type: number, amt: number, addr: number, relay: boolean, payload: ArrayLike<number>): Uint8Array {
	const d = new Uint8Array(5 + payload.length);
	d[0] = type;
	setBits(d, 8, 6, amt & 63);
	setBits(d, 14, 24, addr & 0xffffff);
	setBits(d, 39, 1, relay ? 1 : 0);
	d.set(Array.from(payload), 5);
	return d;
}

/** Network packet: header, data (scrambled with key index 0, clear with 3), then the CRC or Reed-Solomon parity. */
export function makeNetwork(data: Uint8Array, version: number, keyIndex: number, fec: boolean): Uint8Array {
	const net = new Uint8Array(1 + data.length);
	net[0] = (version & 15) | ((keyIndex & 3) << 5) | (fec ? 0x80 : 0);
	net.set(data, 1);
	if (keyIndex === 0) {
		const body = net.subarray(1);
		scramble(body, true);
	}
	const out = new Uint8Array(net.length + (fec ? RS_PARITY : 3));
	out.set(net);
	if (fec) out.set(rsEncode(net), net.length);
	else {
		const c = crc24(net);
		out.set([c >>> 16, (c >>> 8) & 255, c & 255], net.length);
	}
	return out;
}

const trailer = (net: ArrayLike<number>, n: number): number => ((net[n - 3] << 16) | (net[n - 2] << 8) | net[n - 1]) >>> 0;

/** A good CRC, or Reed-Solomon (corrected in place) when the header asks for it: the bytes corrected, or -1. */
export function checkParity(net: Uint8Array, n = net.length): number {
	if (n < 4) return -1;
	if (crc24(net, n - 3) === trailer(net, n)) return 0;
	if (n > RS_PARITY && n <= 255) return rsDecode(net, n);
	return -1;
}

let syndromeTable: Uint32Array | undefined;
/** The CRC syndrome of every single bit of a Traffic-sized packet. */
function bitSyndromes(): Uint32Array {
	if (syndromeTable) return syndromeTable;
	const t = new Uint32Array(TRAFFIC_NET_BYTES * 8);
	for (let b = 0; b < t.length; b++) {
		const v = new Uint8Array(TRAFFIC_NET_BYTES);
		v[b >> 3] = 0x80 >> (b & 7);
		t[b] = (crc24(v, TRAFFIC_NET_BYTES - 3) ^ trailer(v, TRAFFIC_NET_BYTES)) >>> 0;
	}
	return (syndromeTable = t);
}

const flip = (net: Uint8Array, bit: number): void => {
	net[bit >> 3] ^= 0x80 >> (bit & 7);
};

/** Every error pattern over the weakest bits of a Traffic-sized CRC packet, each with one more free bit; bits flipped, or -1. */
export function correctCrc(net: Uint8Array, weak: ArrayLike<number>, nWeak = weak.length): number {
	const syn = bitSyndromes();
	const s0 = (crc24(net, TRAFFIC_NET_BYTES - 3) ^ trailer(net, TRAFFIC_NET_BYTES)) >>> 0;
	if (!s0) return 0;
	nWeak = Math.min(nWeak, 4);
	for (let m = 0; m < 1 << nWeak; m++) {
		let s = s0;
		let flips = 0;
		for (let i = 0; i < nWeak; i++)
			if ((m >> i) & 1) {
				s = (s ^ syn[weak[i]]) >>> 0;
				flips++;
			}
		const extra = s ? syn.indexOf(s) : -1;
		if (s && extra < 0) continue;
		for (let i = 0; i < nWeak; i++) if ((m >> i) & 1) flip(net, weak[i]);
		if (extra >= 0) {
			flip(net, extra);
			flips++;
		}
		return flips;
	}
	return -1;
}

function uplinkTargets(pay: Uint8Array): AdslTraffic[] {
	const targets: AdslTraffic[] = [];
	for (let i = 0; i < MAX_TARGETS && 19 * i + 19 <= pay.length; i++) {
		const e = pay.subarray(19 * i, 19 * i + 19);
		const addr = getBits(e, 6, 24);
		const t = unpackTraffic(e.subarray(4), getBits(e, 0, 6), addr, true);
		if (addr || t.hasPos) targets.push(t);
	}
	return targets;
}

function parseHeader(net: ArrayLike<number>): AdslParsed {
	return {
		kind: 'bad',
		version: net[0] & 15,
		signature: ((net[0] >> 4) & 1) !== 0,
		keyIndex: (net[0] >> 5) & 3,
		fec: (net[0] & 0x80) !== 0,
		type: 0,
		relay: false,
		amt: 0,
		addr: 0,
		targets: [],
	};
}

/** A network packet (net[0] = network header) whose parity already checked. */
export function parseNetwork(net: Uint8Array, n = net.length): AdslParsed {
	if (n < 1) return { ...parseHeader([0]), kind: 'bad' };
	const o = parseHeader(net);
	const parity = o.fec ? RS_PARITY : 3;
	if (n < 1 + parity) return o;
	const dataBytes = n - 1 - parity;
	if (dataBytes < 5 || dataBytes % 4) return { ...o, kind: 'reserved' }; // header + payload is a whole number of words
	if (o.keyIndex === 1 || o.keyIndex === 2) return { ...o, kind: 'encrypted' }; // reserved keys, none is published
	const d = net.slice(1, 1 + dataBytes);
	if (o.keyIndex === 0) scramble(d, false);
	o.type = d[0];
	o.amt = getBits(d, 8, 6);
	o.addr = getBits(d, 14, 24);
	o.relay = getBits(d, 39, 1) !== 0;
	const pay = d.subarray(5);
	if (o.type === TYPE_TRAFFIC && pay.length >= 15) {
		o.targets.push(unpackTraffic(pay, o.amt, o.addr, o.relay));
		o.kind = 'traffic';
	} else if (o.type === TYPE_STATUS && pay.length >= 7) {
		o.status = unpackStatus(pay, o.amt, o.addr);
		o.kind = 'status';
	} else if (o.type === TYPE_UPLINK && pay.length >= 19) {
		o.targets = uplinkTargets(pay);
		o.kind = 'uplink';
	} else o.kind = 'other';
	return o;
}

const CATEGORIES = [
	'unknown',
	'light aircraft',
	'fixed wing',
	'light rotorcraft',
	'glider',
	'lighter than air',
	'ultralight',
	'paraglider',
	'skydiver',
	'eVTOL / UAM',
	'gyrocopter',
	'UAS (open)',
	'UAS (specific)',
	'UAS (certified)',
	'model plane',
	'heavy rotorcraft',
	'hang-glider',
	'paramotor',
];
export const categoryName = (c: number): string => CATEGORIES[c] ?? 'reserved';
const EMERGENCIES = [
	'undefined',
	'none',
	'general emergency',
	'lifeguard / medical',
	'no communications',
	'unlawful interference',
	'downed aircraft',
];
export const emergencyName = (e: number): string => EMERGENCIES[e] ?? 'reserved';
const AMT_NAMES: Record<number, string> = {
	[AMT_RANDOM]: 'random',
	[AMT_ICAO]: 'ICAO',
	[AMT_FLARM]: 'FLARM',
	[AMT_OGN]: 'OGN',
	[AMT_FANET]: 'FANET',
};
export const amtName = (a: number): string => AMT_NAMES[a] ?? (a >= 9 ? 'manufacturer' : 'reserved');
