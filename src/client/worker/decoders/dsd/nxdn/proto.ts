// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir rust/onair_nxdn/src/lich.rs (pn9, Lich encode / decode), crc.rs (crc6,
// crc12, crc16), chan.rs (channel specs, conv_encode, viterbi, perm, encode, decode), msg.rs (message types, build,
// parse, msg_name, call_type_name), core/src/nxdn/nxdn_proto.cpp (kFsw) and core/include/dect2/nxdn/nxdn_proto.h
// (frame geometry, dibitToSym, locSystem, locSite), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: bits are typed arrays, one per element; decode returns null when its CRC fails; the frame sync check of the
// 4800 symbols/s chain (nxdnSyncAt) is BrowSDR's.
//
// NXDN common air interface (NXDN TS 1-A): a frame is 192 four-level symbols: the 10-symbol frame sync word (FSW), then
// 182 symbols scrambled by PN9 (a 1 inverts the symbol): the 8-symbol LICH (one bit per symbol) and 174 symbols of
// channels, protected by the K=5 convolutional code (G1 = 1 + D^3 + D^4, G2 = 1 + D + D^2 + D^4), punctured and block
// interleaved: SACCH 26 bits (+ CRC-6) -> 60 on air, FACCH1 80 (+ CRC-12) -> 144, CAC 155 (+ CRC-16) -> 300.
import type { NxdnLich, NxdnMsg, NxdnMsgNumber } from './types';

export const FRAME_SYM = 192;
export const FSW_SYM = 10;
export const PAYLOAD_SYM = 182;
/** What the 4800 symbols/s chain reads after its 18-dibit sync (FSW and LICH): the 174 channel symbols. */
export const NXDN96_READ = PAYLOAD_SYM - 8;
/** -3 +1 -3 +3 -3 -3 +3 +3 -1 +3 (0xCDF59). */
export const FSW = [-3, 1, -3, 3, -3, -3, 3, 3, -1, 3];
export const RCCH = 0;
export const RTCH = 1;
export const RDCH = 2;
export const FCT_CAC = 0;
export const FCT_SACCH_NS = 0;
export const FCT_SACCH_SF = 2;

/** 01 +3, 00 +1, 10 -1, 11 -3. */
export function dibitToSym(d: number): number {
	return d === 1 ? 3 : d === 0 ? 1 : d === 2 ? -1 : -3;
}

/** The scrambler bits (x^9 + x^5 + 1, seed 0xE4) for the symbols after the FSW. */
export function pn9(n: number): Uint8Array {
	const out = new Uint8Array(n);
	let r = 0xe4;
	for (let i = 0; i < n; i++) {
		out[i] = r & 1;
		const b = ((r >> 4) ^ r) & 1;
		r = (r >> 1) | (b << 8);
	}
	return out;
}
export const PN9 = pn9(PAYLOAD_SYM);

/** Even parity over the four channel type bits (bits 6..3 of the 7-bit value). */
const lichParity = (v: number): number => ((v >> 6) ^ (v >> 5) ^ (v >> 4) ^ (v >> 3)) & 1;

/** The 8 LICH bits as a byte, MSB first, parity last. */
export function lichEncode(l: NxdnLich): number {
	const v = ((l.rfct & 3) << 5) | ((l.fct & 3) << 3) | ((l.opt & 3) << 1) | (l.dir & 1);
	return (v << 1) | lichParity(v);
}

/** A LICH byte; null when its parity is wrong. */
export function lichDecode(x: number): NxdnLich | null {
	const v = x >> 1;
	if (lichParity(v) !== (x & 1)) return null;
	return { rfct: (v >> 5) & 3, fct: (v >> 3) & 3, opt: (v >> 1) & 3, dir: v & 1 };
}

function crcGen(bits: ArrayLike<number>, n: number, w: number, poly: number, init: number): number {
	const mask = (1 << w) - 1;
	let c = init & mask;
	for (let i = 0; i < n; i++) {
		const a = (bits[i] & 1) ^ (c >> (w - 1));
		c = (c << 1) & mask;
		if (a) c ^= poly;
	}
	return c;
}
/** CRC-6 (x^6 + x^5 + x^2 + x + 1), the SACCH check. */
export const crc6 = (b: ArrayLike<number>, n = b.length): number => crcGen(b, n, 6, 0x27, 0x3f);
/** CRC-12 (x^12 + x^11 + x^3 + x^2 + x + 1), the FACCH1 check. */
export const crc12 = (b: ArrayLike<number>, n = b.length): number => crcGen(b, n, 12, 0x80f, 0xfff);
/** CRC-16 (CCITT, start 0xFFFF), the CAC check. */
export const crc16 = (b: ArrayLike<number>, n = b.length): number => crcGen(b, n, 16, 0x1021, 0xffff);

export const SACCH = 0;
export const FACCH1 = 1;
export const CAC = 2;
const SPECS = [
	{ info: 26, crc: 6, rows: 12, cols: 5, punct: [1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0], check: crc6 },
	{ info: 80, crc: 12, rows: 16, cols: 9, punct: [1, 0, 1, 1], check: crc12 },
	{ info: 155, crc: 16, rows: 12, cols: 25, punct: [1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1], check: crc16 },
];

/** Information bits of a channel before its CRC (26, 80, 155) and its bits on the air (60, 144, 300). */
export const infoBits = (c: number): number => SPECS[c].info;
export const airBits = (c: number): number => SPECS[c].rows * SPECS[c].cols;

/** K=5 convolutional encoder: n bits in, 2n out. */
function convEncode(inp: ArrayLike<number>, n: number): Uint8Array {
	const out = new Uint8Array(2 * n);
	let s = 0;
	for (let i = 0; i < n; i++) {
		const b = inp[i] & 1;
		out[2 * i] = b ^ ((s >> 2) & 1) ^ ((s >> 3) & 1);
		out[2 * i + 1] = b ^ (s & 1) ^ ((s >> 1) & 1) ^ ((s >> 3) & 1);
		s = ((s << 1) | b) & 15;
	}
	return out;
}

/** Soft Viterbi over 2n soft values (positive = 1) for the K=5 code; the path ends in state 0. */
function viterbi(soft: ArrayLike<number>, n: number): Uint8Array {
	let pm = new Float32Array(16).fill(-1e9);
	pm[0] = 0;
	const dec = new Uint16Array(n);
	for (let i = 0; i < n; i++) {
		const a = soft[2 * i];
		const b = soft[2 * i + 1];
		const nm = new Float32Array(16);
		let d = 0;
		for (let ns = 0; ns < 16; ns++) {
			const bit = ns & 1;
			let best = -2e9;
			let bp = 0;
			for (let hi = 0; hi < 2; hi++) {
				const s = (ns >> 1) | (hi << 3);
				const g1 = bit ^ ((s >> 2) & 1) ^ ((s >> 3) & 1);
				const g2 = bit ^ (s & 1) ^ ((s >> 1) & 1) ^ ((s >> 3) & 1);
				const m = pm[s] + (g1 ? a : -a) + (g2 ? b : -b);
				if (m > best) {
					best = m;
					bp = hi;
				}
			}
			nm[ns] = best;
			if (bp) d |= 1 << ns;
		}
		dec[i] = d;
		pm = nm;
	}
	const out = new Uint8Array(n);
	let s = 0;
	for (let i = n - 1; i >= 0; i--) {
		out[i] = s & 1;
		s = (s >> 1) | (((dec[i] >> s) & 1) << 3);
	}
	return out;
}

/** Interleaver: air position k carries punctured bit perm(k). */
const perm = (c: number, k: number): number => Math.floor(k / SPECS[c].cols) + SPECS[c].rows * (k % SPECS[c].cols);

/** info (infoBits bits) -> air bits: CRC, tail, convolutional code, puncturing, interleaving. */
export function encode(c: number, info: ArrayLike<number>): Uint8Array {
	const p = SPECS[c];
	const n = p.info + p.crc + 4;
	const u = new Uint8Array(n);
	for (let i = 0; i < p.info; i++) u[i] = info[i] & 1;
	const r = p.check(u, p.info);
	for (let i = 0; i < p.crc; i++) u[p.info + i] = (r >> (p.crc - 1 - i)) & 1;
	const cod = convEncode(u, n);
	const pun: number[] = [];
	for (let i = 0; i < 2 * n; i++) if (p.punct[i % p.punct.length]) pun.push(cod[i]);
	return Uint8Array.from({ length: airBits(c) }, (_, k) => pun[perm(c, k)]);
}

/** Air soft values (positive = 1) -> the information bits and the channel bits the code corrected; null: bad CRC. */
export function decode(c: number, soft: ArrayLike<number>): { info: Uint8Array; errors: number } | null {
	const p = SPECS[c];
	const l = airBits(c);
	const n = p.info + p.crc + 4;
	const pun = new Float32Array(l);
	for (let k = 0; k < l; k++) pun[perm(c, k)] = soft[k];
	const cod = new Float32Array(2 * n);
	for (let i = 0, j = 0; i < 2 * n; i++) if (p.punct[i % p.punct.length]) cod[i] = pun[j++];
	const u = viterbi(cod, n);
	let r = 0;
	for (let i = 0; i < p.crc; i++) r = (r << 1) | u[p.info + i];
	const info = u.slice(0, p.info);
	if (p.check(info) !== r) return null;
	const air = encode(c, info);
	let errors = 0;
	for (let k = 0; k < l; k++) if (soft[k] > 0 !== (air[k] !== 0)) errors++;
	return { info, errors };
}

// Layer 3 messages (NXDN TS 1-D): the first byte is 2 flag bits and the 6-bit message type.
export const VCALL = 0x01;
export const TX_REL = 0x08;
export const IDLE = 0x10;
export const SITE_INFO = 0x18;
export const SRV_INFO = 0x19;
export const STAT_REQ = 0x32;
export const SD_HEADER = 0x38;
export const SD_DATA = 0x39;

export function emptyMsg(type = -1): NxdnMsg {
	return {
		type,
		callType: 1,
		option: 0,
		src: 0,
		dst: 0,
		cipher: 0,
		keyId: 0,
		status: 0,
		block: 0,
		blocks: 0,
		text: '',
		location: 0,
		service: 0,
		channel: 0,
	};
}

/** Field widths of each message body after the type byte. */
const LAYOUTS: Record<number, Array<[NxdnMsgNumber, number]>> = {
	[VCALL]: [
		['callType', 3],
		['option', 5],
		['src', 16],
		['dst', 16],
		['cipher', 2],
		['keyId', 6],
	],
	[TX_REL]: [
		['callType', 3],
		['option', 5],
		['src', 16],
		['dst', 16],
		['cipher', 2],
		['keyId', 6],
	],
	[STAT_REQ]: [
		['callType', 3],
		['option', 5],
		['src', 16],
		['dst', 16],
		['status', 8],
	],
	[SD_HEADER]: [
		['callType', 3],
		['option', 5],
		['src', 16],
		['dst', 16],
		['blocks', 8],
	],
	[SITE_INFO]: [
		['location', 24],
		['channel', 16],
		['service', 16],
	],
	[SRV_INFO]: [
		['location', 24],
		['service', 16],
	],
};
/** Bits a body needs (type byte included). */
const NEEDS: Record<number, number> = {
	[VCALL]: 56,
	[TX_REL]: 56,
	[STAT_REQ]: 56,
	[SD_HEADER]: 56,
	[SD_DATA]: 80,
	[SITE_INFO]: 64,
	[SRV_INFO]: 48,
};

/** The message as bits (MSB first), maxBits long. */
export function buildMsg(m: NxdnMsg, maxBits: number): Uint8Array {
	const bits = new Uint8Array(maxBits);
	let n = 0;
	const put = (v: number, w: number) => {
		for (let i = w - 1; i >= 0; i--, n++) if (n < maxBits) bits[n] = Math.floor(v / 2 ** i) & 1;
	};
	put(m.type & 0x3f, 8);
	for (const [key, w] of LAYOUTS[m.type] ?? []) put(m[key], w);
	if (m.type === SD_DATA) {
		put(m.block, 8);
		for (let i = 0; i < 8; i++) put(i < m.text.length ? m.text.charCodeAt(i) & 0xff : 0, 8);
	}
	return bits;
}

/** A message from bits (one per element); null when the body is shorter than its type needs. */
export function parseMsg(bits: ArrayLike<number>, nBits: number): NxdnMsg | null {
	let p = 0;
	const get = (w: number) => {
		let v = 0;
		for (let i = 0; i < w; i++, p++) v = v * 2 + (p < nBits ? bits[p] & 1 : 0);
		return v;
	};
	const m = emptyMsg(get(8) & 0x3f);
	if (nBits < (NEEDS[m.type] ?? 0)) return null;
	for (const [key, w] of LAYOUTS[m.type] ?? []) m[key] = get(w);
	if (m.type === SD_DATA) {
		m.block = get(8);
		for (let i = 0; i < 8; i++) {
			const ch = get(8);
			if (ch) m.text += ch >= 32 && ch < 127 ? String.fromCharCode(ch) : '.';
		}
	}
	return m;
}

const MSG_NAMES: Record<number, string> = {
	[VCALL]: 'VCALL',
	[TX_REL]: 'TX_REL',
	[IDLE]: 'IDLE',
	[SITE_INFO]: 'SITE_INFO',
	[SRV_INFO]: 'SRV_INFO',
	[STAT_REQ]: 'STAT_REQ',
	[SD_HEADER]: 'SDCALL_HEADER',
	[SD_DATA]: 'SDCALL_DATA',
};
export const msgName = (t: number): string => MSG_NAMES[t] ?? 'other';
const CALL_TYPES: Record<number, string> = { 0: 'broadcast', 1: 'group', 4: 'individual', 6: 'interconnect' };
export const callTypeName = (t: number): string => CALL_TYPES[t] ?? 'other';
/** The location id as the regional category splits it. */
export const locSystem = (loc: number): number => (loc >> 10) & 0xfff;
export const locSite = (loc: number): number => loc & 0x3ff;

/** LICH values whose frames are decoded: outbound CAC; RTCH / RDCH with a SACCH (non-superframe, superframe, idle). */
const SYNC_LICH = (() => {
	const ok = new Uint8Array(256);
	for (let v = 0; v < 128; v++) {
		const l = { rfct: (v >> 5) & 3, fct: (v >> 3) & 3, opt: (v >> 1) & 3, dir: v & 1 };
		const cac = l.rfct === RCCH && l.fct === FCT_CAC && l.dir === 1;
		const traffic = (l.rfct === RTCH || l.rfct === RDCH) && l.fct !== 1;
		if (cac || traffic) ok[lichEncode(l)] = 1;
	}
	return ok;
})();
const FSW_POLARITY = FSW.map((s) => (s > 0 ? '1' : '3')).join('');

/**
 * The 4800 symbols/s chain's NXDN96 frame sync: the FSW's polarities and a LICH with a good parity that is decoded
 * here, in the last 18 dibits of the history ('1' positive, '3' negative after polarity collapse). 1: as sent, -1:
 * inverted, 0: none.
 */
export function nxdnSyncAt(history: string): number {
	const at = history.length - 18;
	if (at < 0) return 0;
	let same = 0;
	let inv = 0;
	for (let i = 0; i < FSW_SYM; i++) {
		const neg = history.charCodeAt(at + i) >= 0x32; // '2' or '3'
		if (neg === (FSW_POLARITY[i] === '3')) same++;
		else inv++;
		if (same && inv) return 0;
	}
	const pol = same ? 1 : -1;
	let lich = 0;
	for (let k = 0; k < 8; k++) {
		const neg = history.charCodeAt(at + FSW_SYM + k) >= 0x32;
		lich = (lich << 1) | (Number(neg !== pol < 0) ^ PN9[k]);
	}
	return SYNC_LICH[lich] ? pol : 0;
}
