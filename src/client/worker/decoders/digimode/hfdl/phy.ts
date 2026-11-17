// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir rust/onair_hfdl/src/phy.rs (rates, A and M sequences, preamble,
// scrambler, interleaver, convolutional code, Viterbi decoder, FCS), core/src/hfdl/hfdl_proto.cpp (pskPhase, pskLabel,
// PskTable, hfdlPsk, hfdlDecide, hfdlSoftBits, hfdlDecodeSoft) and the constants of
// core/include/dect2/hfdl/hfdl_proto.h, https://github.com/adswill/OnAir; see third_party/onair. Protocol facts as
// OnAir credits them: ARINC 635 / ICAO Doc 9741 as dumphfdl (szpajder, GPL-3.0) implements them, read for reference.
// Changes: the tables are built once and cached; the Viterbi decoder keeps its survivor choices in one reused byte
// array; the FCS is BrowSDR's CRC-16/X.25 of the VDL2 decoder (the same check sequence); the PSK points of every order
// are tabled (OnAir tables QPSK and 8PSK) and a symbol is passed as two numbers.
//
// The bit layers of an HFDL burst: 1800 symbols/s; prekey, A1 and A2 (the 127-symbol A sequence twice), M1 (one of 8
// cyclic shifts of an m-sequence: the rate and the interleaver), M2 (its first 15 symbols), 9 training blocks of 15,
// then per data block 30 data symbols and a 15-symbol probe. Data symbols are scrambled by a 15-bit m-sequence,
// interleaved in 40 rows, rate 1/2 K = 7 coded (generators 0x6D first, then 0x4F), and the PDU octets are sent least
// significant bit first. PSK maps: v holds bitsPerSym bits, the first bit sent in bit 0 (the most significant bit of
// the Gray label). BPSK +-1; QPSK and 8PSK at k * 360 / M degrees, k the Gray-decoded label (QPSK on the axes, as
// liquid-dsp's PSK4 / PSK8 that dumphfdl demodulates).

import { fcs } from '@/worker/decoders/digimode/vdl2/burst';
import type { HfdlRate } from './types';

export const HFDL_BAUD = 1800;
/** The carrier sits this far above the assigned (dial) frequency, upper sideband. */
export const HFDL_CARRIER_HZ = 1440;
export const PREKEY = 448;
export const A_LEN = 127;
export const M1_LEN = 127;
export const T_LEN = 15;
export const TRAIN = 9;
export const DATA_LEN = 30;
export const BLOCK_LEN = 45;
/** Symbols of the known part from A1 to the last training block (531). */
export const PRE_LEN = 2 * A_LEN + M1_LEN + 15 + TRAIN * T_LEN;
export const RRC_ALPHA = 0.35;
/** A TDMA frame of 13 slots. */
export const FRAME_SEC = 32;
export const SLOT_SEC = 32 / 13;

const r = (
	m1: number,
	bps: number,
	bitsPerSym: number,
	quarter: boolean,
	twoSlots: boolean,
	blocks: number,
	colShift: number,
): HfdlRate => ({
	m1,
	bps,
	bitsPerSym,
	quarter,
	twoSlots,
	blocks,
	colShift,
});
const RATES: readonly HfdlRate[] = [
	r(0, 300, 1, true, false, 72, 17),
	r(1, 600, 1, false, false, 72, 17),
	r(2, 1200, 2, false, false, 72, 17),
	r(3, 1800, 3, false, false, 72, 17),
	r(4, 300, 1, true, true, 168, 23),
	r(5, 600, 1, false, true, 168, 23),
	r(6, 1200, 2, false, true, 168, 23),
	r(7, 1800, 3, false, true, 168, 23),
];

const clamp7 = (m1: number): number => Math.max(0, Math.min(7, Math.trunc(m1)));

/** The rate for `m1`, clamped into 0 .. 7. */
export const hfdlRate = (m1: number): HfdlRate => RATES[clamp7(m1)];
/** Symbols from A1 to the last probe (the prekey not counted). */
export const burstSyms = (m1: number): number => PRE_LEN + hfdlRate(m1).blocks * BLOCK_LEN;
/** Bits on the channel. */
export const codedBits = (m1: number): number => hfdlRate(m1).blocks * DATA_LEN * hfdlRate(m1).bitsPerSym;
/** Octets one burst carries. */
export const payloadOctets = (m1: number): number => {
	const info = codedBits(m1) / (hfdlRate(m1).quarter ? 4 : 2);
	return Math.trunc((info - 6) / 8);
};
/** Seconds on the air, prekey included. */
export const burstSeconds = (m1: number): number => (PREKEY + burstSyms(m1)) / HFDL_BAUD;

const A_OCT = [0x5b, 0xbc, 0x74, 0x57, 0x03, 0xd9, 0x89, 0x39, 0xf2, 0x08, 0xd5, 0x36, 0x94, 0x2c, 0x32, 0xfe];
const M_BASE =
	'0111011011110100010110010111110001000000110011011000111001110101110000100110000010101011010010010100111100100011010100001111111';
const M_SHIFT = [72, 82, 113, 123, 61, 103, 93, 9];
/** The probe / training symbols T, +-1. */
export const T_SEQ: readonly number[] = [1, 1, 1, -1, 1, 1, -1, -1, 1, -1, 1, -1, -1, -1, -1];

/** Bit `k` (0 .. 126) of the A sequence. */
export const aBit = (k: number): number => (A_OCT[(k >>> 3) & 15] >> (7 - (k & 7))) & 1;
/** Bit `k` of the M sequence with cyclic shift `shift` (0 .. 7). */
export const mBit = (shift: number, k: number): number => (M_BASE.charCodeAt((M_SHIFT[shift & 7] + (k % 127)) % 127) === 0x31 ? 1 : 0);

const preCache: Array<Float32Array | undefined> = [];
/** The 531 known symbols (+-1) from A1 to the last training block for rate `m1`. */
export function preambleRef(m1: number): Float32Array {
	const m = clamp7(m1);
	const cached = preCache[m];
	if (cached) return cached;
	const out = new Float32Array(PRE_LEN);
	let i = 0;
	for (let rep = 0; rep < 2; rep++) for (let k = 0; k < A_LEN; k++) out[i++] = aBit(k) ? -1 : 1;
	for (let k = 0; k < M1_LEN; k++) out[i++] = mBit(m, k) ? -1 : 1;
	for (let k = 0; k < 15; k++) out[i++] = mBit(m, k) ? -1 : 1;
	for (let rep = 0; rep < TRAIN; rep++) for (const t of T_SEQ) out[i++] = t;
	preCache[m] = out;
	return out;
}

const parity = (v: number): number => {
	let x = v;
	x ^= x >>> 16;
	x ^= x >>> 8;
	x ^= x >>> 4;
	x ^= x >>> 2;
	x ^= x >>> 1;
	return x & 1;
};

/**
 * The scrambler signs (+1 / -1) for `n` data symbols: a 15-bit m-sequence (new bit = parity of bits 14 and 0 of the
 * state, shifted in at bit 0, state 0x4D4B) restarted every 120 data symbols; a 1 turns the symbol by 180 degrees.
 */
export function scramblerSigns(n: number): Int8Array {
	const out = new Int8Array(Math.max(0, n));
	let st = 0x4d4b;
	for (let i = 0; i < out.length; i++) {
		if (i % 120 === 0) st = 0x4d4b;
		const b = parity(st & 0x4001);
		st = ((st << 1) | b) & 0x7fff;
		out[i] = b ? -1 : 1;
	}
	return out;
}

const ilCache: Array<Int32Array | undefined> = [];
/**
 * The interleaver for rate `m1`: `out[j]` is where the j-th decoder-order bit is sent, a permutation of 0 .. coded bits
 * - 1 (channel bits are written down the 40 rows, the column moving back by the shift after every bit and on by one
 * after each pass over the rows; the decoder reads them with a row step of 9, the column moving on after each pass).
 */
export function interleave(m1: number): Int32Array {
	const m = clamp7(m1);
	const cached = ilCache[m];
	if (cached) return cached;
	const n = codedBits(m);
	const cols = n / 40;
	const sh = hfdlRate(m).colShift;
	const cell = new Int32Array(n);
	let row = 0;
	let col = 0;
	for (let i = 0; i < n; i++) {
		cell[row * cols + col] = i;
		row++;
		if (row === 40) {
			row = 0;
			col++;
		}
		col = (col + cols - (sh % cols)) % cols;
	}
	const tab = new Int32Array(n);
	row = 0;
	col = 0;
	for (let j = 0; j < n; j++) {
		tab[j] = cell[row * cols + col];
		row = (row + 9) % 40;
		if (row === 0) col++;
	}
	ilCache[m] = tab;
	return tab;
}

/** Rate 1/2 K = 7 convolutional encoder: two coded bits per input bit, the 0x6D output first, then 0x4F. */
export function convEncode(bits: ArrayLike<number>): Uint8Array {
	const out = new Uint8Array(2 * bits.length);
	let sr = 0;
	for (let i = 0; i < bits.length; i++) {
		sr = ((sr << 1) | (bits[i] & 1)) & 0x7f;
		out[2 * i] = parity(sr & 0x6d);
		out[2 * i + 1] = parity(sr & 0x4f);
	}
	return out;
}

const OUT0 = Uint8Array.from({ length: 128 }, (_, reg) => parity(reg & 0x6d));
const OUT1 = Uint8Array.from({ length: 128 }, (_, reg) => parity(reg & 0x4f));
let survivors = new Uint8Array(0);
const metric = new Float64Array(64);
const next = new Float64Array(64);

/** The index of the first largest value. */
function maxIndex(m: Float64Array): number {
	let bi = 0;
	for (let i = 1; i < 64; i++) if (m[bi] < m[i]) bi = i;
	return bi;
}

/** One trellis step: the new metrics from the two soft values; the survivor choices into `surv` at `at`. */
function step(s0: number, s1: number, surv: Uint8Array, at: number): void {
	for (let ns = 0; ns < 64; ns++) {
		const b = ns & 1;
		const p0 = ns >> 1;
		const p1 = p0 | 32;
		const r0 = ((p0 << 1) | b) & 0x7f;
		const r1 = ((p1 << 1) | b) & 0x7f;
		const v0 = metric[p0] + (OUT0[r0] ? -s0 : s0) + (OUT1[r0] ? -s1 : s1);
		const v1 = metric[p1] + (OUT0[r1] ? -s0 : s0) + (OUT1[r1] ? -s1 : s1);
		if (v1 > v0) {
			next[ns] = v1;
			surv[at + ns] = 1;
		} else {
			next[ns] = v0;
			surv[at + ns] = 0;
		}
	}
	const mx = next[maxIndex(next)];
	for (let s = 0; s < 64; s++) metric[s] = next[s] - mx;
}

/** Soft Viterbi decoder for the code above: `soft` holds two values per input bit (positive = 0); decodes `n` bits. */
export function viterbi(soft: ArrayLike<number>, n: number): Uint8Array {
	const cnt = Math.max(0, Math.min(n, soft.length >> 1));
	const out = new Uint8Array(Math.max(0, n));
	if (survivors.length < cnt * 64) survivors = new Uint8Array(cnt * 64);
	const surv = survivors;
	metric.fill(-1e30);
	metric[0] = 0;
	for (let t = 0; t < cnt; t++) step(soft[2 * t], soft[2 * t + 1], surv, t * 64);
	let s = maxIndex(metric);
	for (let t = cnt - 1; t >= 0; t--) {
		out[t] = s & 1;
		s = (s >> 1) | (surv[t * 64 + s] << 5);
	}
	return out;
}

/** The FCS of `p` (sent low octet first): CRC-16/X.25. */
export const hfdlFcs = (p: Uint8Array): number => fcs(p);

/** True when `p` ends with the FCS of everything before it (`p` = octets + 2 FCS octets). */
export function fcsOk(p: Uint8Array): boolean {
	if (p.length < 2) return false;
	const n = p.length - 2;
	const f = fcs(p.subarray(0, n));
	return p[n] === (f & 0xff) && p[n + 1] === f >> 8;
}

/** The reverse of the bit layers: data-symbol soft bits (channel order, positive = 0) to the burst's octets. */
export function decodeSoft(m1: number, chan: ArrayLike<number>): Uint8Array {
	const rate = hfdlRate(m1);
	const n = codedBits(m1);
	const pos = interleave(m1);
	let d = new Float32Array(n);
	for (let j = 0; j < n; j++) d[j] = chan[pos[j]];
	if (rate.quarter) {
		const h = new Float32Array(n >> 1);
		for (let j = 0; j < h.length; j++) h[j] = d[2 * j] + d[2 * j + 1];
		d = h;
	}
	const bits = viterbi(d, d.length >> 1);
	const o = new Uint8Array(payloadOctets(m1));
	for (let i = 0; i < o.length; i++) {
		let v = 0;
		for (let b = 0; b < 8; b++) v |= bits[i * 8 + b] << b;
		o[i] = v;
	}
	return o;
}

// ---------------------------------------------------------------- PSK maps

/** v (first bit sent in bit 0) -> the phase index k of k * 360 / M degrees. */
function pskPhase(bps: number, v: number): number {
	let g = 0;
	for (let q = 0; q < bps; q++) g |= ((v >> q) & 1) << (bps - 1 - q);
	let k = g;
	k ^= k >> 1;
	k ^= k >> 2;
	return k & ((1 << bps) - 1);
}

/** The phase index k -> v. */
function pskLabel(bps: number, k: number): number {
	const g = k ^ (k >> 1);
	let v = 0;
	for (let q = 0; q < bps; q++) v |= ((g >> (bps - 1 - q)) & 1) << q;
	return v;
}

/** PSK_RE[bps][v], PSK_IM[bps][v]: the points of BPSK (1), QPSK (2) and 8PSK (3). */
const PSK_RE: Float64Array[] = [];
const PSK_IM: Float64Array[] = [];
const LABEL: Uint8Array[] = [];
for (let bps = 1; bps <= 3; bps++) {
	const m = 1 << bps;
	PSK_RE[bps] = new Float64Array(m);
	PSK_IM[bps] = new Float64Array(m);
	LABEL[bps] = Uint8Array.from({ length: m }, (_, k) => pskLabel(bps, k));
	for (let v = 0; v < m; v++) {
		if (bps === 1) {
			PSK_RE[bps][v] = v & 1 ? -1 : 1;
			continue;
		}
		const ph = Math.fround((2 * Math.PI * pskPhase(bps, v)) / m);
		PSK_RE[bps][v] = Math.fround(Math.cos(ph));
		PSK_IM[bps][v] = Math.fround(Math.sin(ph));
	}
}

/** The point of label v, real part. */
export const pskRe = (bps: number, v: number): number => PSK_RE[bps][v & ((1 << bps) - 1)];
/** The point of label v, imaginary part. */
export const pskIm = (bps: number, v: number): number => PSK_IM[bps][v & ((1 << bps) - 1)];

/** The nearest label to the symbol (re, im). */
export function pskDecide(bps: number, re: number, im: number): number {
	if (bps === 1) return re < 0 ? 1 : 0;
	const m = 1 << bps;
	const x = Math.atan2(im, re) / ((2 * Math.PI) / m);
	let k = x < 0 ? -Math.round(-x) : Math.round(x);
	k = ((k % m) + m) % m;
	return LABEL[bps][k];
}

const dist = new Float64Array(8);

/** The soft bits of the symbol (re, im) into out[at ..], positive = 0, scaled by `scale`. */
export function pskSoftBits(bps: number, re: number, im: number, scale: number, out: Float32Array, at: number): void {
	if (bps === 1) {
		out[at] = re * scale;
		return;
	}
	const m = 1 << bps;
	const pr = PSK_RE[bps];
	const pi = PSK_IM[bps];
	for (let v = 0; v < m; v++) dist[v] = (re - pr[v]) ** 2 + (im - pi[v]) ** 2;
	for (let b = 0; b < bps; b++) {
		let m0 = 1e30;
		let m1 = 1e30;
		for (let v = 0; v < m; v++) {
			if ((v >> b) & 1) m1 = Math.min(m1, dist[v]);
			else m0 = Math.min(m0, dist[v]);
		}
		out[at + b] = (m1 - m0) * scale * 0.5;
	}
}
