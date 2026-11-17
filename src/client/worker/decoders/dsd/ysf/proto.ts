// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/fusion/fusion_proto.cpp and core/include/dect2/fusion/fusion_proto.h
// (syncLevels, crc16, golay24, golay24Decode, convEncode, convDecode, interleaveDibits, whiten, fichPack, fichUnpack,
// fichEncode, fichDecode, dchEncode, dchDecode, vd2VoiceEncode, vd2VoiceDecode, trimField, padField),
// https://github.com/adswill/OnAir; see third_party/onair.
// Changes: bits are Uint8Array (one per element) and results are returned instead of written through pointers;
// vd2VoiceDecode also counts the repeated bits whose three copies disagreed (for mbelib's error count). The whole-frame
// builder and parser are in frame.ts.
//
// Yaesu System Fusion (C4FM) air interface, written by OnAir from Yaesu's public "Amateur Radio Digital Specs"
// (revision 1.01), sections 3 and 4 and appendices A and B. A frame is 100 ms = 960 bits = 480 dibits at 4800 symbols/s:
// frame sync (40 bits, D471C9634D), the FICH (200 bits) and a 720 bit payload. Dibit to symbol (Table 3-1):
// 00 = +1, 01 = +3, 10 = -1, 11 = -3, the same mapping as BrowSDR's four-level slicer.
import type { YsfFich } from './types';

const SYNC_BYTES = [0xd4, 0x71, 0xc9, 0x63, 0x4d];
export const YSF_FRAME_BITS = 960;
export const YSF_FRAME_DIBITS = 480;
export const YSF_SYNC_DIBITS = 20;
export const YSF_FICH_DIBITS = 100;

export function dibitLevel(d: number): number {
	return d === 0 ? 1 : d === 1 ? 3 : d === 2 ? -1 : -3;
}

export function levelDibit(level: number): number {
	return level === 1 ? 0 : level === 3 ? 1 : level === -1 ? 2 : 3;
}

/** The 40 bits of the frame sync. */
export function syncBits(): Uint8Array {
	const bits = new Uint8Array(40);
	for (let i = 0; i < 40; i++) bits[i] = (SYNC_BYTES[i >> 3] >> (7 - (i & 7))) & 1;
	return bits;
}

/** The 20 symbol levels of the frame sync. */
export function syncLevels(): Int8Array {
	const bits = syncBits();
	return Int8Array.from({ length: YSF_SYNC_DIBITS }, (_, i) => dibitLevel(bits[2 * i] * 2 + bits[2 * i + 1]));
}

/** The frame sync as DSD's polarity string ('1' positive, '3' negative), optionally upside down. */
export function syncPolarity(inverted = false): string {
	return Array.from(syncLevels(), (level) => (level > 0 !== inverted ? '1' : '3')).join('');
}

/** CRC-16: x16+x12+x5+1, init 0, MSB first, result inverted. */
export function crc16(bits: ArrayLike<number>, n: number, start = 0): number {
	let c = 0;
	for (let i = 0; i < n; i++) {
		const feedback = ((c >> 15) & 1) ^ (bits[start + i] & 1);
		c = (c << 1) & 0xffff;
		if (feedback) c ^= 0x1021;
	}
	return ~c & 0xffff;
}

const GOLAY_GEN = 0xc75;

function popcount(v: number): number {
	let n = 0;
	for (let x = v >>> 0; x; x &= x - 1) n++;
	return n;
}

function golay23(d: number): number {
	let r = d << 11;
	for (let b = 22; b >= 11; b--) if (r & (1 << b)) r ^= GOLAY_GEN << (b - 11);
	return (d << 11) | (r & 0x7ff);
}

/** Golay (24,12,8) codeword with the data in the top 12 bits. */
export function golay24(data12: number): number {
	const c = golay23(data12 & 0xfff);
	return ((c << 1) | (popcount(c) & 1)) >>> 0;
}

let golayTable: Uint32Array | null = null;

/** Nearest codeword; ok when it is within three errors. */
export function golay24Decode(word: number): { data: number; errors: number; ok: boolean } {
	golayTable ??= Uint32Array.from({ length: 4096 }, (_, d) => golay24(d));
	let best = 99;
	let index = 0;
	for (let i = 0; i < 4096; i++) {
		const distance = popcount((word ^ golayTable[i]) & 0xffffff);
		if (distance < best) {
			best = distance;
			index = i;
		}
	}
	return { data: index, errors: best, ok: best <= 3 };
}

/** Rate 1/2, K=5, G1 = 1+x3+x4, G2 = 1+x+x2+x4, output G1 G2 alternately. */
export function convEncode(input: ArrayLike<number>): Uint8Array {
	const out = new Uint8Array(input.length * 2);
	const h = [0, 0, 0, 0, 0];
	for (let i = 0; i < input.length; i++) {
		h[0] = input[i] & 1;
		out[2 * i] = h[0] ^ h[3] ^ h[4];
		out[2 * i + 1] = h[0] ^ h[1] ^ h[2] ^ h[4];
		for (let k = 4; k > 0; k--) h[k] = h[k - 1];
	}
	return out;
}

const UNREACHED = 1 << 20;

/** Hard decision Viterbi; the tail is part of the result. errors = the path metric. */
export function convDecode(coded: ArrayLike<number>): { bits: Uint8Array; errors: number } {
	const steps = coded.length >> 1;
	let pm = new Int32Array(16).fill(UNREACHED);
	let next = new Int32Array(16);
	pm[0] = 0;
	const from = new Uint8Array(steps * 16);
	const input = new Uint8Array(steps * 16);
	for (let t = 0; t < steps; t++) {
		next.fill(UNREACHED);
		const c1 = coded[2 * t] & 1;
		const c2 = coded[2 * t + 1] & 1;
		for (let s = 0; s < 16; s++) {
			if (pm[s] >= UNREACHED) continue;
			const h1 = s & 1;
			const h2 = (s >> 1) & 1;
			const h3 = (s >> 2) & 1;
			const h4 = (s >> 3) & 1;
			for (let u = 0; u < 2; u++) {
				const metric = pm[s] + Number((u ^ h3 ^ h4) !== c1) + Number((u ^ h1 ^ h2 ^ h4) !== c2);
				const ns = ((s << 1) | u) & 15;
				if (metric < next[ns]) {
					next[ns] = metric;
					from[t * 16 + ns] = s;
					input[t * 16 + ns] = u;
				}
			}
		}
		[pm, next] = [next, pm];
	}
	const bits = new Uint8Array(steps);
	let s = 0;
	for (let t = steps - 1; t >= 0; t--) {
		bits[t] = input[t * 16 + s];
		s = from[t * 16 + s];
	}
	return { bits, errors: pm[0] };
}

/** Block interleaver: items written in rows of rowLen, read by columns (inverse: the other way). */
export function interleave(bits: Uint8Array, rowLen: number, unit: number, inverse: boolean): Uint8Array {
	const items = Math.floor(bits.length / unit);
	if (rowLen <= 0 || items % rowLen !== 0) return bits.slice();
	const depth = items / rowLen;
	const out = new Uint8Array(bits.length);
	for (let k = 0; k < items; k++) {
		const src = (k % depth) * rowLen + Math.floor(k / depth);
		const a = inverse ? k : src;
		const b = inverse ? src : k;
		for (let u = 0; u < unit; u++) out[b * unit + u] = bits[a * unit + u];
	}
	return out;
}

export function interleaveDibits(bits: Uint8Array, rowDibits: number): Uint8Array {
	return interleave(bits, rowDibits, 2, false);
}

export function deinterleaveDibits(bits: Uint8Array, rowDibits: number): Uint8Array {
	return interleave(bits, rowDibits, 2, true);
}

/** PN(9,5) whitening, register 111001001, restarted per unit; its own inverse. */
export function whiten(bits: Uint8Array, n: number, start = 0): void {
	const s = [1, 0, 0, 1, 0, 0, 1, 1, 1];
	for (let i = 0; i < n; i++) {
		bits[start + i] ^= s[0];
		const feedback = s[0] ^ s[4];
		for (let k = 0; k < 8; k++) s[k] = s[k + 1];
		s[8] = feedback;
	}
}

export function putBits(out: number[], value: number, n: number): void {
	for (let b = n - 1; b >= 0; b--) out.push(Math.floor(value / 2 ** b) & 1);
}

export function getBits(bits: ArrayLike<number>, start: number, n: number): number {
	let v = 0;
	for (let i = 0; i < n; i++) v = v * 2 + (bits[start + i] & 1);
	return v;
}

export function bytesToBits(bytes: ArrayLike<number>, out: number[]): void {
	for (let i = 0; i < bytes.length; i++) for (let b = 7; b >= 0; b--) out.push((bytes[i] >> b) & 1);
}

export function bitsToBytes(bits: ArrayLike<number>, start: number, nbits: number): Uint8Array {
	const out = new Uint8Array((nbits + 7) >> 3);
	for (let i = 0; i < nbits; i++) if (bits[start + i]) out[i >> 3] |= 0x80 >> (i & 7);
	return out;
}

export function defaultFich(): YsfFich {
	return { fi: 1, cs: 2, cm: 0, bn: 0, bt: 0, fn: 0, ft: 0, mr: 0, voip: 0, dt: 0, sqlOff: 0, sqlCode: 0 };
}

export function fichPack(f: YsfFich): number {
	return (
		(((f.fi & 3) << 30) |
			((f.cs & 3) << 28) |
			((f.cm & 3) << 26) |
			((f.bn & 3) << 24) |
			((f.bt & 3) << 22) |
			((f.fn & 7) << 19) |
			((f.ft & 7) << 16) |
			((f.mr & 7) << 11) |
			((f.voip & 1) << 10) |
			((f.dt & 3) << 8) |
			((f.sqlOff & 1) << 7) |
			(f.sqlCode & 127)) >>>
		0
	);
}

export function fichUnpack(w: number): YsfFich {
	return {
		fi: (w >>> 30) & 3,
		cs: (w >>> 28) & 3,
		cm: (w >>> 26) & 3,
		bn: (w >>> 24) & 3,
		bt: (w >>> 22) & 3,
		fn: (w >>> 19) & 7,
		ft: (w >>> 16) & 7,
		mr: (w >>> 11) & 7,
		voip: (w >>> 10) & 1,
		dt: (w >>> 8) & 3,
		sqlOff: (w >>> 7) & 1,
		sqlCode: w & 127,
	};
}

/** The 200 coded bits of a FICH. */
export function fichEncode(f: YsfFich): Uint8Array {
	const b: number[] = [];
	putBits(b, fichPack(f), 32);
	putBits(b, crc16(b, 32), 16);
	const g: number[] = [];
	for (let i = 0; i < 4; i++) putBits(g, golay24(getBits(b, 12 * i, 12)), 24);
	g.push(0, 0, 0, 0);
	return interleaveDibits(convEncode(g), 5);
}

/** null when the CRC fails; fixes = bits the coding corrected. */
export function fichDecode(bits200: Uint8Array): { fich: YsfFich; fixes: number } | null {
	const g = convDecode(deinterleaveDibits(bits200.subarray(0, 200), 5));
	let fixes = g.errors;
	const d: number[] = [];
	for (let i = 0; i < 4; i++) {
		const word = golay24Decode(getBits(g.bits, 24 * i, 24));
		if (!word.ok) return null;
		fixes += word.errors;
		putBits(d, word.data, 12);
	}
	if (crc16(d, 32) !== getBits(d, 32, 16)) return null;
	return { fich: fichUnpack(getBits(d, 0, 32)), fixes };
}

/** A DCH unit: 20 bytes -> 360 bits, 10 bytes (V/D mode 2) -> 200 bits. */
export function dchEncode(bytes: Uint8Array): Uint8Array {
	const b: number[] = [];
	bytesToBits(bytes, b);
	const data = Uint8Array.from(b);
	whiten(data, bytes.length * 8);
	const all = Array.from(data);
	putBits(all, crc16(data, bytes.length * 8), 16);
	all.push(0, 0, 0, 0);
	return interleaveDibits(convEncode(all), bytes.length === 20 ? 9 : 5);
}

/** null when the CRC fails. */
export function dchDecode(bits: Uint8Array): { bytes: Uint8Array; fixes: number } | null {
	const nbytes = bits.length === 360 ? 20 : 10;
	const d = convDecode(deinterleaveDibits(bits, nbytes === 20 ? 9 : 5));
	const n = nbytes * 8;
	if (crc16(d.bits, n) !== getBits(d.bits, n, 16)) return null;
	const w = d.bits.slice(0, n);
	whiten(w, n);
	return { bytes: bitsToBytes(w, 0, n), fixes: d.errors };
}

/** V/D mode 2 voice: 49 bits -> 104 bits (72 in the VCH, 32 in the VeCH). */
export function vd2VoiceEncode(v: ArrayLike<number>): Uint8Array {
	const b = new Uint8Array(104);
	let p = 0;
	for (let i = 0; i < 27; i++) for (let k = 0; k < 3; k++) b[p++] = v[i] & 1;
	for (let i = 27; i < 49; i++) b[p++] = v[i] & 1;
	whiten(b, 104);
	return interleave(b, 26, 1, false);
}

/** 104 bits -> 49 bits by majority vote; errors = repeated bits whose copies disagreed. */
export function vd2VoiceDecode(bits104: Uint8Array): { bits: Uint8Array; errors: number } {
	const b = interleave(bits104.subarray(0, 104), 26, 1, true);
	whiten(b, 104);
	const out = new Uint8Array(49);
	let errors = 0;
	for (let i = 0; i < 27; i++) {
		const sum = b[3 * i] + b[3 * i + 1] + b[3 * i + 2];
		out[i] = sum >= 2 ? 1 : 0;
		if (sum === 1 || sum === 2) errors++;
	}
	for (let i = 0; i < 22; i++) out[27 + i] = b[81 + i];
	return { bits: out, errors };
}

/** Printable ASCII, trailing spaces removed, NUL as space and others as '.'. */
export function trimField(p: ArrayLike<number>, start: number, n: number): string {
	let s = '';
	for (let i = 0; i < n; i++) {
		const c = p[start + i];
		s += c >= 32 && c < 127 ? String.fromCharCode(c) : c === 0 ? ' ' : '.';
	}
	return s.replace(/ +$/, '');
}

/** A field of n bytes padded with spaces. */
export function padField(s: string, n: number): Uint8Array {
	return Uint8Array.from({ length: n }, (_, i) => (i < s.length ? s.charCodeAt(i) & 0xff : 0x20));
}
