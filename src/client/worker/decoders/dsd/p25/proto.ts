// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir rust/onair_p25/src/nid.rs (BCH (63,16) NID), golay.rs (Golay (24,12) and
// (18,6), Hamming (10,6)), trellis.rs (rate 1/2 trellis code, interleave, CRC-CCITT), msg.rs (data units, frame lengths,
// TSBK, link control, encryption sync, header, names, channel text), core/src/p25/p25_proto.cpp (kSync),
// core/src/p25/p25_proto_rs.cpp (nidDecodeKnownNac) and core/src/p25/p25_rx.cpp (mlHex: the soft hexbit decision),
// https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the NID decoder tries the site's NAC first (a codeword within 10 bit errors is the nearest, so the result is
// the full search's); TSBK arguments are a bigint; the Reed-Solomon code is p25p2/rs.ts (the same OnAir port).
//
// APCO Project 25 Phase 1 (TIA-102.BAAA): frame sync, NID, status symbols, the codes of the header, link control and
// encryption sync, the trellis code of TSBKs and PDU blocks, and their fields. Receive only.
import type { P25Crypto, P25Lc, P25Tsbk } from './types';

/** The 48-bit frame sync 0x5575F5FF77FF as C4FM levels. */
export const SYNC = [3, 3, 3, 3, 3, -3, 3, 3, -3, -3, 3, 3, -3, -3, -3, -3, 3, -3, 3, -3, -3, -3, -3, -3];
export const SYNC_SYM = 24;
export const STATUS_EVERY = 36;
/** Every 36th dibit of a frame (positions 35, 71, ...) is a status symbol. */
export const isStatusPos = (p: number): boolean => p % STATUS_EVERY === STATUS_EVERY - 1;

export const HDU = 0;
export const TDU = 3;
export const LDU1 = 5;
export const TSBK = 7;
export const LDU2 = 10;
export const PDU = 12;
export const TDULC = 15;
const DUID_NAMES: Record<number, string> = {
	[HDU]: 'HDU',
	[TDU]: 'TDU',
	[LDU1]: 'LDU1',
	[TSBK]: 'TSBK',
	[LDU2]: 'LDU2',
	[PDU]: 'PDU',
	[TDULC]: 'TDULC',
};
export const duidName = (d: number): string => DUID_NAMES[d] ?? '?';
/** Frame length in dibits (status symbols included); TSBK / PDU: up to three blocks; 0 for an unknown unit. */
export function frameLen(d: number): number {
	const len: Record<number, number> = { [HDU]: 396, [TDU]: 72, [LDU1]: 864, [LDU2]: 864, [TDULC]: 216, [TSBK]: 360, [PDU]: 360 };
	return len[d] ?? 0;
}

/** C4FM dibit to level: 01 +3, 00 +1, 10 -1, 11 -3. */
export const dibitToSym = (d: number): number => [1, 3, -1, -3][d & 3];
export const symToDibit = (s: number): number => (s === 3 ? 1 : s === 1 ? 0 : s === -1 ? 2 : 3);
export const nearestLevel = (v: number): number => (v >= 2 ? 3 : v >= 0 ? 1 : v >= -2 ? -1 : -3);
export const hardDibit = (x: number): number => symToDibit(nearestLevel(x));

const popcount = (v: number): number => {
	v -= (v >>> 1) & 0x55555555;
	v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
	return (Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24) & 0xff;
};

// ── NID: BCH (63,16,23) plus an overall parity bit ──

/** BCH (63,16) generator polynomial 6331 1413 6723 5453 (octal), degree 47. */
const GEN = 0o6331141367235453n;
function codeword(m: bigint): bigint {
	let r = m << 47n;
	for (let i = 62n; i >= 47n; i--) if ((r >> i) & 1n) r ^= GEN << (i - 47n);
	const c63 = (m << 47n) | r;
	let ones = 0;
	for (let v = c63; v; v &= v - 1n) ones++;
	return (c63 << 1n) | BigInt(ones & 1);
}
/** Codewords of the messages 0..255 and of the messages i << 8 as high and low 32-bit halves (the code is linear). */
const NID_T = (() => {
	const t = { lowHi: new Uint32Array(256), lowLo: new Uint32Array(256), highHi: new Uint32Array(256), highLo: new Uint32Array(256) };
	for (let i = 0; i < 256; i++) {
		const a = codeword(BigInt(i));
		const b = codeword(BigInt(i) << 8n);
		t.lowHi[i] = Number(a >> 32n);
		t.lowLo[i] = Number(a & 0xffffffffn);
		t.highHi[i] = Number(b >> 32n);
		t.highLo[i] = Number(b & 0xffffffffn);
	}
	return t;
})();

/** The 64 NID bits (first sent first) of a NAC and DUID. */
export function nidEncode(nac: number, duid: number): Uint8Array {
	const m = ((nac & 0xfff) << 4) | (duid & 0xf);
	const hi = (NID_T.highHi[m >> 8] ^ NID_T.lowHi[m & 255]) >>> 0;
	const lo = (NID_T.highLo[m >> 8] ^ NID_T.lowLo[m & 255]) >>> 0;
	return Uint8Array.from({ length: 64 }, (_, i) => (i < 32 ? (hi >>> (31 - i)) & 1 : (lo >>> (63 - i)) & 1));
}

/** Bit errors between the received bits (as halves) and message m's codeword, its parity bit left out. */
function nidDistance(hi: number, lo: number, m: number): number {
	return (
		popcount((NID_T.highHi[m >> 8] ^ NID_T.lowHi[m & 255] ^ hi) >>> 0) + popcount((NID_T.highLo[m >> 8] ^ NID_T.lowLo[m & 255] ^ lo) & ~1)
	);
}

function halves(bits: ArrayLike<number>): [number, number] {
	let hi = 0;
	let lo = 0;
	for (let i = 0; i < 32; i++) hi = ((hi << 1) | (bits[i] & 1)) >>> 0;
	for (let i = 32; i < 64; i++) lo = ((lo << 1) | (bits[i] & 1)) >>> 0;
	return [hi, lo];
}

/** NAC and DUID of 64 bits, up to 10 bit errors (the nearest codeword); hint: the site's NAC, tried first. */
export function nidDecode(bits: ArrayLike<number>, hint = -1): { nac: number; duid: number; errs: number } | null {
	const [hi, lo] = halves(bits);
	if (hint >= 0)
		for (let duid = 0; duid < 16; duid++) {
			if (!frameLen(duid)) continue;
			const e = nidDistance(hi, lo, (hint << 4) | duid);
			if (e <= 10) return { nac: hint, duid, errs: e };
		}
	let best = 99;
	let bm = 0;
	for (let m = 0; m < 65536 && best; m++) {
		const d = nidDistance(hi, lo, m);
		if (d < best) {
			best = d;
			bm = m;
		}
	}
	return best <= 10 ? { nac: bm >> 4, duid: bm & 15, errs: best } : null;
}

/** With the site's NAC known only the frame types remain: the nearest, up to 16 bit errors and clearly nearer than the next. */
export function nidDecodeKnownNac(bits: ArrayLike<number>, nac: number): { duid: number; errs: number } | null {
	const [hi, lo] = halves(bits);
	let best = 99;
	let second = 99;
	let at = -1;
	for (let d = 0; d < 16; d++) {
		if (!frameLen(d)) continue;
		const e = nidDistance(hi, lo, (nac << 4) | d);
		if (e < best) {
			second = best;
			best = e;
			at = d;
		} else if (e < second) second = e;
	}
	return at < 0 || best > 16 || second - best < 8 ? null : { duid: at, errs: best };
}

// ── Golay (24,12) and (18,6), Hamming (10,6) ──

const GOLAY_GEN = 0xc75;
function golay24Of(d12: number): number {
	let r = (d12 & 0xfff) << 11;
	for (let i = 22; i >= 11; i--) if ((r >> i) & 1) r ^= GOLAY_GEN << (i - 11);
	const c23 = ((d12 & 0xfff) << 11) | r;
	return ((c23 << 1) | (popcount(c23) & 1)) >>> 0;
}
const GOLAY = Uint32Array.from({ length: 4096 }, (_, d) => golay24Of(d));
const HAM_PAR = [0xe, 0xd, 0xb, 0x7, 0x3, 0xc];

/** Golay (24,12): the data first (bit 23 sent first), the parity bit last. */
export const golay24Encode = (d12: number): number => GOLAY[d12 & 0xfff];
/** The nearest data word (-1 beyond three errors) and its distance. */
export function golay24Decode(cw: number): { data: number; errs: number } {
	let best = 99;
	let bd = 0;
	for (let d = 0; d < 4096 && best; d++) {
		const e = popcount((GOLAY[d] ^ cw) & 0xffffff);
		if (e < best) {
			best = e;
			bd = d;
		}
	}
	return { data: best <= 3 ? bd : -1, errs: best };
}
/** Shortened Golay (18,6) of a hexbit. */
export const golay18Encode = (hex: number): number => GOLAY[hex & 63] & 0x3ffff;
/** Hamming (10,6) of a hexbit: the hexbit in the top six bits (bit 9 sent first), four check bits. */
export function hamming10Encode(hex: number): number {
	let par = 0;
	for (let i = 0; i < 6; i++) if ((hex >> (5 - i)) & 1) par ^= HAM_PAR[i];
	return ((hex & 63) << 4) | par;
}
const HAM_CW = Uint32Array.from({ length: 64 }, (_, h) => hamming10Encode(h));
const GOLAY18_CW = Uint32Array.from({ length: 64 }, (_, h) => golay18Encode(h));

/**
 * Soft decision of an n-bit hexbit codeword (Hamming (10,6) or Golay (18,6)): the hexbit whose code word correlates best
 * with the soft values (> 0 a 1). Repairs most double errors a hard decoder gets wrong.
 */
function mlHex(sb: ArrayLike<number>, at: number, n: number, cw: Uint32Array): number {
	let best = 0;
	let bm = -1e30;
	for (let v = 0; v < 64; v++) {
		let m = 0;
		for (let k = 0; k < n; k++) m += (cw[v] >> (n - 1 - k)) & 1 ? sb[at + k] : -sb[at + k];
		if (m > bm) {
			bm = m;
			best = v;
		}
	}
	return best;
}
export const mlHamming = (sb: ArrayLike<number>, at: number): number => mlHex(sb, at, 10, HAM_CW);
export const mlGolay18 = (sb: ArrayLike<number>, at: number): number => mlHex(sb, at, 18, GOLAY18_CW);

/** Soft bits of data dibit levels (about +-1, +-3): two per dibit, > 0 a 1. */
export function softBits(dl: ArrayLike<number>, at: number, n: number): Float32Array {
	const sb = new Float32Array(2 * n);
	for (let i = 0; i < n; i++) {
		const x = dl[at + i];
		sb[2 * i] = -x;
		sb[2 * i + 1] = Math.abs(x) - 2;
	}
	return sb;
}

// ── Trellis code of TSBKs and PDU blocks, CRC-CCITT ──

const NEXT = [
	[0x2, 0xc, 0x1, 0xf],
	[0xe, 0x0, 0xd, 0x3],
	[0x9, 0x7, 0xa, 0x4],
	[0x5, 0xb, 0x6, 0x8],
];
/** Transmit position i carries encoder output dibit IL[i]. */
const IL = (() => {
	const t: number[] = [];
	for (let c = 0; c < 4; c++) for (let i = 2 * c; i < 98; i += 8) t.push(i, i + 1);
	return t;
})();

/** CRC-CCITT (0x1021, start 0, complemented) over bits. */
export function crcCcitt(bits: ArrayLike<number>, n: number): number {
	let c = 0;
	for (let i = 0; i < n; i++) {
		const fb = ((c >> 15) & 1) ^ (bits[i] & 1);
		c = (c << 1) & 0xffff;
		if (fb) c ^= 0x1021;
	}
	return ~c & 0xffff;
}

/** 96 bits -> the 98 interleaved dibits as sent. */
export function trellisEncode(bits: ArrayLike<number>): Uint8Array {
	const coded = new Uint8Array(98);
	let st = 0;
	for (let i = 0; i < 49; i++) {
		const inp = i < 48 ? ((bits[2 * i] & 1) << 1) | (bits[2 * i + 1] & 1) : 0;
		const o = NEXT[st][inp];
		coded[2 * i] = o >> 2;
		coded[2 * i + 1] = o & 3;
		st = inp;
	}
	return Uint8Array.from(IL, (k) => coded[k]);
}

/** Viterbi over 98 received levels (about -3..3, as sent): the 96 bits, or null when no path ends in the zero state. */
export function trellisDecode(lv: ArrayLike<number>, at = 0): Uint8Array | null {
	const r = new Float32Array(98);
	for (let i = 0; i < 98; i++) r[IL[i]] = lv[at + i];
	let pm = [0, 1e9, 1e9, 1e9];
	const from = new Uint8Array(49 * 4);
	for (let s = 0; s < 49; s++) {
		const nm = [1e30, 1e30, 1e30, 1e30];
		for (let st = 0; st < 4; st++) {
			if (pm[st] >= 1e29) continue;
			for (let inp = 0; inp < (s === 48 ? 1 : 4); inp++) {
				const o = NEXT[st][inp];
				const a = r[2 * s] - dibitToSym(o >> 2);
				const b = r[2 * s + 1] - dibitToSym(o & 3);
				const m = pm[st] + a * a + b * b;
				if (m < nm[inp]) {
					nm[inp] = m;
					from[s * 4 + inp] = st;
				}
			}
		}
		pm = nm;
	}
	if (pm[0] >= 1e29) return null;
	const bits = new Uint8Array(96);
	let st = 0;
	for (let s = 48; s >= 0; s--) {
		if (s < 48) {
			bits[2 * s] = st >> 1;
			bits[2 * s + 1] = st & 1;
		}
		st = from[s * 4 + st];
	}
	return bits;
}

// ── Fields ──

const bitsOf = (v: bigint | number, n: number): number[] =>
	Array.from({ length: n }, (_, i) => Number((BigInt(v) >> BigInt(n - 1 - i)) & 1n));
function valueOf(b: ArrayLike<number>, at: number, n: number): number {
	let v = 0;
	for (let i = 0; i < n; i++) v = v * 2 + (b[at + i] & 1);
	return v;
}
function bigOf(b: ArrayLike<number>, at: number, n: number): bigint {
	let v = 0n;
	for (let i = 0; i < n; i++) v = (v << 1n) | BigInt(b[at + i] & 1);
	return v;
}
const hexToBits = (hex: ArrayLike<number>): number[] => Array.from(hex, (h) => bitsOf(h, 6)).flat();
const bitsToHex = (b: number[]): Uint8Array => Uint8Array.from({ length: b.length / 6 }, (_, i) => valueOf(b, 6 * i, 6));

/** The 96 bits of a TSBK with its CRC. */
export function tsbkBits(t: P25Tsbk): Uint8Array {
	const b = [Number(t.last), Number(t.prot), ...bitsOf(t.opcode, 6), ...bitsOf(t.mfid, 8), ...bitsOf(BigInt.asUintN(64, t.args), 64)];
	return Uint8Array.from([...b, ...bitsOf(crcCcitt(b, 80), 16)]);
}

/** A TSBK from 96 bits; null when its CRC does not match. */
export function tsbkParse(b: ArrayLike<number>): P25Tsbk | null {
	if (valueOf(b, 80, 16) !== crcCcitt(b, 80)) return null;
	return { last: !!b[0], prot: !!b[1], opcode: valueOf(b, 2, 6), mfid: valueOf(b, 8, 8), args: bigOf(b, 16, 64) };
}

export const LC_GROUP = 0x00;
export const LC_UNIT = 0x03;
export const LC_TERM = 0x0f;

/** The 12 hexbits of a link control word (group, unit to unit, terminator). */
export function lcHexbits(l: P25Lc): Uint8Array {
	const b = [Number(l.prot), 0, ...bitsOf(l.lco, 6), ...bitsOf(l.mfid, 8)];
	if (l.lco === LC_GROUP) b.push(...bitsOf(l.svcOpts, 8), ...bitsOf(0, 8), ...bitsOf(l.tg, 16), ...bitsOf(l.src, 24));
	else if (l.lco === LC_UNIT) b.push(...bitsOf(l.svcOpts, 8), ...bitsOf(l.dst, 24), ...bitsOf(l.src, 24));
	else b.push(...bitsOf(0, 32), ...bitsOf(Math.max(0, l.dst), 24));
	return bitsToHex(b);
}

/** A link control word: group, unit and terminator fields for the standard and the 0x01 manufacturer ids. */
export function lcParse(hex: ArrayLike<number>): P25Lc {
	const b = hexToBits(hex);
	const l: P25Lc = { prot: !!b[0], lco: valueOf(b, 2, 6), mfid: valueOf(b, 8, 8), svcOpts: 0, tg: -1, src: -1, dst: -1 };
	if (l.mfid !== 0 && l.mfid !== 1) return l; // a manufacturer's own
	if (l.lco === LC_GROUP) Object.assign(l, { svcOpts: valueOf(b, 16, 8), tg: valueOf(b, 32, 16), src: valueOf(b, 48, 24) });
	else if (l.lco === LC_UNIT) Object.assign(l, { svcOpts: valueOf(b, 16, 8), dst: valueOf(b, 24, 24), src: valueOf(b, 48, 24) });
	else if (l.lco === LC_TERM) l.dst = valueOf(b, 48, 24);
	return l;
}

export const ALG_CLEAR = 0x80;
const ALG_NAMES: Record<number, string> = {
	0x80: 'clear',
	0x81: 'DES-OFB',
	0x83: 'triple DES',
	0x84: 'AES-256',
	0x85: 'AES-128',
	0x9f: 'DES-XL',
	0xaa: 'ADP (RC4)',
};
export const algName = (a: number): string => ALG_NAMES[a] ?? 'unknown algorithm';

const miText = (b: number[]): string =>
	Array.from({ length: 9 }, (_, i) =>
		valueOf(b, 8 * i, 8)
			.toString(16)
			.padStart(2, '0'),
	).join('');
const miBits = (mi: string): number[] =>
	Array.from({ length: 9 }, (_, i) => bitsOf(parseInt(mi.slice(2 * i, 2 * i + 2) || '0', 16), 8)).flat();

/** The 16 hexbits of an encryption sync (message indicator, algorithm, key). */
export const esHexbits = (c: P25Crypto): Uint8Array => bitsToHex([...miBits(c.mi), ...bitsOf(c.algId, 8), ...bitsOf(c.keyId, 16)]);
/** An encryption sync: message indicator, algorithm and key id (mfid and talkgroup are not in it). */
export function esParse(hex: ArrayLike<number>): P25Crypto {
	const b = hexToBits(hex);
	return { mi: miText(b), algId: valueOf(b, 72, 8), keyId: valueOf(b, 80, 16), mfid: 0, tg: -1 };
}
/** The 20 hexbits of a header word. */
export function hduHexbits(c: P25Crypto): Uint8Array {
	return bitsToHex([
		...miBits(c.mi),
		...bitsOf(c.mfid, 8),
		...bitsOf(c.algId, 8),
		...bitsOf(c.keyId, 16),
		...bitsOf(Math.max(0, c.tg), 16),
	]);
}
export function hduParse(hex: ArrayLike<number>): P25Crypto {
	const b = hexToBits(hex);
	return { mi: miText(b), mfid: valueOf(b, 72, 8), algId: valueOf(b, 80, 8), keyId: valueOf(b, 88, 16), tg: valueOf(b, 104, 16) };
}

export const OP_GRP_V_GRANT = 0x00;
export const OP_GRP_V_GRANT_UPD = 0x02;
export const OP_UU_V_GRANT = 0x04;
export const OP_IDEN_UP_TDMA = 0x33;
export const OP_IDEN_UP_VU = 0x34;
export const OP_RFSS_STS = 0x3a;
export const OP_NET_STS = 0x3b;
export const OP_ADJ_STS = 0x3c;
export const OP_IDEN_UP = 0x3d;
const OP_NAMES: Record<number, string> = {
	[OP_GRP_V_GRANT]: 'GRP_V_CH_GRANT',
	[OP_GRP_V_GRANT_UPD]: 'GRP_V_CH_GRANT_UPDT',
	[OP_UU_V_GRANT]: 'UU_V_CH_GRANT',
	[OP_IDEN_UP_TDMA]: 'IDEN_UP_TDMA',
	[OP_IDEN_UP_VU]: 'IDEN_UP_VU',
	[OP_RFSS_STS]: 'RFSS_STS_BCST',
	[OP_NET_STS]: 'NET_STS_BCST',
	[OP_ADJ_STS]: 'ADJ_STS_BCST',
	[OP_IDEN_UP]: 'IDEN_UP',
};
export const opcodeName = (op: number): string => OP_NAMES[op] ?? 'TSBK';
/** A channel number (4-bit identifier, 12-bit channel) as "id-channel". */
export const channelText = (ch: number): string => `${(ch >> 12) & 15}-${ch & 0xfff}`;
