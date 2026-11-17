// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/aero/aero_phy.cpp and core/include/dect2/aero/aero_phy.h,
// https://github.com/adswill/OnAir; see third_party/onair. Changes: the Viterbi survivors are two 32-bit words per step;
// the frame encoder's filler for the unused bits of a 10500 bit/s frame is a function of the frame count.
//
// Inmarsat Aero P channel coding layer, between the demodulated bits and the signal-unit bytes: unique word, frame header,
// interleaver, rate 1/2 convolutional code, scrambler, byte packing. Every constant follows JAERO (Jonti Olds, MIT,
// github.com/jontio/JAERO: aerol.cpp, aerol.h, jconvolutionalcodec.cpp), the reference decoder for these channels; OnAir
// read the constants and re-implemented them.

import type { AeroDecodedFrame, AeroFrameFormat } from './types';

/** aerol.cpp: preambledetector.setPreamble(3780831379LL, 32); the most significant bit is sent first. */
export const AERO_UW = 0xe15ae893;
export const AERO_UW_BITS = 32;

const FORMATS: Record<number, AeroFrameFormat> = {
	600: { bitRate: 600, uwBits: 32, headerBits: 16, skipBits: 0, codedBits: 1152, cols: 6, blocks: 3 },
	1200: { bitRate: 1200, uwBits: 32, headerBits: 16, skipBits: 0, codedBits: 1152, cols: 9, blocks: 2 },
	10500: { bitRate: 10500, uwBits: 64, headerBits: 16, skipBits: 178, codedBits: 4992, cols: 78, blocks: 1 },
};
/** The frame of a P channel: 600 / 1200 bit/s 1200 bits (2 s / 1 s), 10500 bit/s 5250 bits (0.5 s); undefined for another rate. */
export const aeroFrameFormat = (bitRate: number): AeroFrameFormat | undefined => FORMATS[bitRate];
export const totalBits = (f: AeroFrameFormat): number => f.uwBits + f.headerBits + f.skipBits + f.codedBits;
export const blockBits = (f: AeroFrameFormat): number => 64 * f.cols;
export const infoBytes = (f: AeroFrameFormat): number => f.codedBits / 16;
export const isOqpsk = (f: AeroFrameFormat): boolean => f.bitRate === 10500;

/** Header (aerol.cpp Decode): format id (must be 1), superframe marker, two frame counters; first bit most significant. */
export const aeroHeader = (formatId: number, superframe: number, count1: number, count2: number): number =>
	((formatId & 15) << 12) | ((superframe & 15) << 8) | ((count1 & 15) << 4) | (count2 & 15);

/** Scrambler (aerol.h AeroLScrambler): additive, 15-bit register, starts again at every frame; the first 5000 bits. */
export const SCRAMBLER = (() => {
	const s = [1, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 1, 0, 0, 1];
	const v = new Uint8Array(5000);
	for (let a = 0; a < 5000; a++) {
		const b = s[0] ^ s[14];
		v[a] = b;
		for (let i = 14; i > 0; i--) s[i] = s[i - 1];
		s[0] = b;
	}
	return v;
})();

/** Interleaver rows (aerol.cpp AeroLInterleaver): 64 rows, row permutation (i * 27) % 64. */
const PERM = new Uint8Array(64);
const DEPERM = new Uint8Array(64);
for (let i = 0; i < 64; i++) {
	PERM[(i * 27) % 64] = i;
	DEPERM[i] = (i * 27) % 64;
}

/** tx[i * cols + j] = coded[permute[i] + 64 j] */
export function aeroInterleave(coded: ArrayLike<number>, tx: Uint8Array, cols: number, from = 0): void {
	for (let i = 0; i < 64; i++) for (let j = 0; j < cols; j++) tx[i * cols + j] = coded[from + PERM[i] + 64 * j];
}

/** out[j * 64 + i] = rx[((i * 27) % 64) * cols + j] */
export function aeroDeinterleave(rx: Float32Array, out: Float32Array, cols: number, from = 0, to = 0): void {
	for (let j = 0; j < cols; j++) for (let i = 0; i < 64; i++) out[to + j * 64 + i] = rx[from + DEPERM[i] * cols + j];
}

const parity7 = (v: number): number => {
	let x = v & 0x7f;
	x ^= x >> 4;
	x ^= x >> 2;
	x ^= x >> 1;
	return x & 1;
};

/**
 * Convolutional code: rate 1/2, K = 7, polynomials 109 and 79 (aerol.cpp SetCode(2, 7, {109, 79}) handed to libcorrect,
 * which shifts the newest bit into the least significant end; the first coded bit of each pair uses 109).
 */
const POLY0 = 109;
const POLY1 = 79;
const OUT0 = Uint8Array.from({ length: 128 }, (_, sr) => parity7(sr & POLY0));
const OUT1 = Uint8Array.from({ length: 128 }, (_, sr) => parity7(sr & POLY1));

export class AeroConvEncoder {
	private sr = 0;
	reset(): void {
		this.sr = 0;
	}
	/** The two coded bits of `bit`. */
	encode(bit: number): [number, number] {
		this.sr = ((this.sr << 1) | (bit & 1)) & 0x7f;
		return [OUT0[this.sr], OUT1[this.sr]];
	}
}

/**
 * Soft Viterbi decoder that carries its path metrics from one call to the next (like JAERO's Decode_Continuous); a call
 * is decided at its own end from the best state. Soft input: positive = 1, magnitude = confidence.
 */
export class AeroViterbi {
	private pm = new Float64Array(64);
	private nm = new Float64Array(64);
	private decLo = new Uint32Array(0);
	private decHi = new Uint32Array(0);

	/** Forget the past: every state equally likely. */
	reset(): void {
		this.pm.fill(0);
	}

	/** 2 n soft values to n bits. */
	decode(soft: Float32Array, n: number, bits: Uint8Array): void {
		if (this.decLo.length < n) {
			this.decLo = new Uint32Array(n);
			this.decHi = new Uint32Array(n);
		}
		for (let t = 0; t < n; t++) this.step(soft[2 * t], soft[2 * t + 1], t);
		let s = 0;
		for (let k = 1; k < 64; k++) if (this.pm[k] > this.pm[s]) s = k;
		for (let t = n - 1; t >= 0; t--) {
			bits[t] = s & 1;
			const x = s < 32 ? (this.decLo[t] >>> s) & 1 : (this.decHi[t] >>> (s - 32)) & 1;
			s = (s >> 1) | (x << 5);
		}
	}

	private step(s0: number, s1: number, t: number): void {
		const bm0 = -s0 - s1,
			bm1 = -s0 + s1,
			bm2 = s0 - s1,
			bm3 = s0 + s1;
		const pm = this.pm,
			nm = this.nm;
		let lo = 0,
			hi = 0;
		let best = -1e30;
		for (let ns = 0; ns < 64; ns++) {
			// register (x << 6) | ns: the oldest bit x leaves, the predecessor state is (ns >> 1) | (x << 5)
			const a = ns,
				b = 64 | ns;
			const ia = OUT0[a] * 2 + OUT1[a],
				ib = OUT0[b] * 2 + OUT1[b];
			const m0 = pm[ns >> 1] + (ia === 0 ? bm0 : ia === 1 ? bm1 : ia === 2 ? bm2 : bm3);
			const m1 = pm[(ns >> 1) | 32] + (ib === 0 ? bm0 : ib === 1 ? bm1 : ib === 2 ? bm2 : bm3);
			let m = m0;
			if (m1 > m0) {
				m = m1;
				if (ns < 32) lo |= 1 << ns;
				else hi |= 1 << (ns - 32);
			}
			nm[ns] = m;
			if (m > best) best = m;
		}
		for (let s = 0; s < 64; s++) pm[s] = nm[s] - best; // keep the numbers small
		this.decLo[t] = lo;
		this.decHi[t] = hi;
	}
}

/** SU check (aerol.h AeroLcrc16): CRC-16/X-25, reflected 0x8408, start 0xFFFF, inverted. */
export function aeroCrc16(p: ArrayLike<number>, n = p.length, from = 0): number {
	let c = 0xffff;
	for (let i = 0; i < n; i++) {
		c ^= p[from + i];
		for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x8408 : c >>> 1;
	}
	return ~c & 0xffff;
}

/** The CRC of bytes 0..9 of the SU at `from`, sent low byte first in bytes 10 and 11; JAERO takes an all-zero SU as good. */
export function aeroSuCrcOk(su: ArrayLike<number>, from = 0): boolean {
	const rec = su[from + 10] | (su[from + 11] << 8);
	if (aeroCrc16(su, 10, from) === rec) return true;
	if (rec) return false;
	for (let i = 0; i < 10; i++) if (su[from + i]) return false;
	return true;
}

export function aeroSuSetCrc(su: Uint8Array, from = 0): void {
	const c = aeroCrc16(su, 10, from);
	su[from + 10] = c & 0xff;
	su[from + 11] = c >> 8;
}

/** aerol.cpp packs the first decoded bit into bit 0 of a byte. */
export function aeroBitsToBytes(bits: Uint8Array, nBytes: number): Uint8Array {
	const out = new Uint8Array(nBytes);
	for (let i = 0; i < nBytes; i++) {
		let c = 0;
		for (let k = 0; k < 8; k++) c |= (bits[8 * i + k] & 1) << k;
		out[i] = c;
	}
	return out;
}

export function aeroBytesToBits(bytes: Uint8Array): Uint8Array {
	const bits = new Uint8Array(bytes.length * 8);
	for (let i = 0; i < bytes.length; i++) for (let k = 0; k < 8; k++) bits[8 * i + k] = (bytes[i] >> k) & 1;
	return bits;
}

/** Transmit side: the channel bits of one frame (UW, header, data) from its information bytes; the encoder runs on from frame to frame. */
export class AeroFrameEncoder {
	readonly fmt: AeroFrameFormat;
	private readonly enc = new AeroConvEncoder();
	private fill = 0x1234567;

	constructor(bitRate: number) {
		const f = aeroFrameFormat(bitRate);
		if (!f) throw new Error(`no Aero frame at ${bitRate} bit/s`);
		this.fmt = f;
	}

	frame(info: Uint8Array, header: number): Uint8Array {
		const f = this.fmt;
		const out: number[] = [];
		for (let i = 0; i < AERO_UW_BITS; i++) {
			const u = (AERO_UW >>> (AERO_UW_BITS - 1 - i)) & 1;
			out.push(u);
			if (isOqpsk(f)) out.push(u); // the same word on both arms
		}
		for (let i = 15; i >= 0; i--) out.push((header >> i) & 1);
		for (let i = 0; i < f.skipBits; i++) {
			// not data: what a real station puts here is not known, so filler without a line spectrum
			this.fill ^= this.fill << 13;
			this.fill ^= this.fill >>> 17;
			this.fill ^= this.fill << 5;
			out.push(this.fill & 1);
		}
		const bits = aeroBytesToBits(info.subarray(0, infoBytes(f)));
		const coded = new Uint8Array(2 * bits.length);
		for (let i = 0; i < bits.length; i++) [coded[2 * i], coded[2 * i + 1]] = this.enc.encode(bits[i] ^ SCRAMBLER[i]);
		const tx = new Uint8Array(blockBits(f));
		for (let b = 0; b < f.blocks; b++) {
			aeroInterleave(coded, tx, f.cols, b * blockBits(f));
			out.push(...tx);
		}
		return Uint8Array.from(out);
	}
}

/** Receive side, after the unique word: the soft data bits of one frame (channel order) to its information bytes. */
export class AeroFrameDecoder {
	readonly fmt: AeroFrameFormat;
	private readonly vit = new AeroViterbi();
	/** Re-encodes the decisions; it runs on from frame to frame, as the encoder does. */
	private readonly reenc = new AeroConvEncoder();
	private readonly deint: Float32Array;
	private readonly bits: Uint8Array;

	constructor(bitRate: number) {
		const f = aeroFrameFormat(bitRate);
		if (!f) throw new Error(`no Aero frame at ${bitRate} bit/s`);
		this.fmt = f;
		this.deint = new Float32Array(f.codedBits);
		this.bits = new Uint8Array(f.codedBits / 2);
	}

	reset(): void {
		this.vit.reset();
	}

	decode(coded: Float32Array, header: number): AeroDecodedFrame {
		const f = this.fmt;
		const bb = blockBits(f);
		for (let b = 0; b < f.blocks; b++) aeroDeinterleave(coded, this.deint, f.cols, b * bb, b * bb);
		// the blocks are one continuous code: one trellis over the frame, so the end of a block is decided with the next in view
		const n = f.codedBits / 2;
		this.vit.decode(this.deint, n, this.bits);
		let errs = 0;
		for (let i = 0; i < n; i++) {
			const [c0, c1] = this.reenc.encode(this.bits[i]);
			errs += Number(c0 !== Number(this.deint[2 * i] > 0)) + Number(c1 !== Number(this.deint[2 * i + 1] > 0));
		}
		for (let i = 0; i < n; i++) this.bits[i] ^= SCRAMBLER[i];
		const bytes = aeroBitsToBytes(this.bits, infoBytes(f));
		let susOk = 0;
		for (let k = 0; k + 12 <= bytes.length; k += 12) if (aeroSuCrcOk(bytes, k)) susOk++;
		return { header, bytes, susOk, susBad: bytes.length / 12 - susOk, channelBer: errs / f.codedBits };
	}
}
