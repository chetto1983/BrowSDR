// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/mesh/mesh_lora_code.cpp (autoLdro, syncSymbol, whitening, Hamming
// code, header checksum, payload CRC, Gray mapping, data symbol count, air time, interleaver and encode) and
// core/include/dect2/mesh/mesh_lora.h (sfdExtraSymbols, headerSfApp), https://github.com/adswill/OnAir; see
// third_party/onair. LoRa facts as credited there: gr-lora_sdr (Joachim Tapparel, EPFL, and contributors, GPL-3.0):
// tables.h (whitening), hamming_enc_impl.cc, interleaver_impl.cc, gray_demap_impl.cc, header_impl.cc, add_crc_impl.cc;
// the air time formula and the 16 ms low data rate rule from the Semtech SX1261/2 datasheet (6.1.4) and RadioLib.
// Changes: tables are built once at module load; the encoder returns a Uint16Array; loraParams has the satellite
// settings (carrierHz, cfoTrack) and anySync.

import type { LoraParams } from './types';

/** The default settings of a demodulator (OnAir lora::Params). */
export function loraParams(over: Partial<LoraParams> = {}): LoraParams {
	return {
		sf: 11,
		bwHz: 250000,
		cr: 5,
		preamble: 16,
		syncWord: 0x2b,
		moreSync: [],
		ldro: false,
		crc: true,
		implicitHdr: false,
		implicitLen: 0,
		jumpChips: 11.7,
		carrierHz: 0,
		cfoTrack: 0,
		anySync: false,
		...over,
	};
}

export const symbolSeconds = (sf: number, bwHz: number): number => (1 << sf) / bwHz;
/** RadioLib turns the low data rate optimisation on when a symbol lasts 16 ms or more (SX126x autoLDRO). */
export const autoLdro = (sf: number, bwHz: number): boolean => symbolSeconds(sf, bwHz) >= 0.016 - 1e-9;
/** SF5 and SF6: two more symbols between the SFD and the data. */
export const sfdExtraSymbols = (sf: number): number => (sf < 7 ? 2 : 0);
/** Codewords of the header block: sf at the full rate for SF5 / 6, else sf - 2 at the reduced rate. */
export const headerSfApp = (sf: number): number => (sf < 7 ? sf : sf - 2);

/** FFT bin of sync word symbol 0 (high nibble) or 1 (low nibble): nibble << 3 sent as a signed 7-bit value. */
export function syncSymbol(syncWord: number, index: number, sf: number): number {
	let v = ((index === 0 ? syncWord >> 4 : syncWord) & 0xf) << 3;
	if (v >= 64) v -= 128;
	return v & ((1 << sf) - 1);
}

const popcount8 = (x: number): number => {
	let n = 0;
	for (let v = x & 0xff; v; v &= v - 1) n++;
	return n;
};

/** The 8-bit LFSR x^8 + x^6 + x^5 + x^4 + 1 from 0xFF: gr-lora_sdr's 255 whitening bytes. */
const WHITENING = (() => {
	const s = new Uint8Array(255);
	let r = 0xff;
	for (let i = 0; i < 255; i++) {
		s[i] = r;
		r = ((r << 1) | (popcount8(r & 0xb8) & 1)) & 0xff;
	}
	return s;
})();

export const whitening = (i: number): number => WHITENING[i % 255];

/** cr 5..8: a codeword of cr bits, first bit = bit 0 of the nibble. */
export function hammingEncode(nib: number, cr: number): number {
	const b0 = nib & 1,
		b1 = (nib >> 1) & 1,
		b2 = (nib >> 2) & 1,
		b3 = (nib >> 3) & 1;
	if (cr <= 5) return (b0 << 4) | (b1 << 3) | (b2 << 2) | (b3 << 1) | (b0 ^ b1 ^ b2 ^ b3);
	const p0 = b0 ^ b1 ^ b2,
		p1 = b1 ^ b2 ^ b3,
		p2 = b0 ^ b1 ^ b3,
		p3 = b0 ^ b2 ^ b3;
	const full = (b0 << 7) | (b1 << 6) | (b2 << 5) | (b3 << 4) | (p0 << 3) | (p1 << 2) | (p2 << 1) | p3;
	return full >> (8 - cr);
}

/** ENC[cr * 16 + nibble]: the codeword table. */
export const ENC = (() => {
	const t = new Uint8Array(9 * 16);
	for (let cr = 5; cr <= 8; cr++) for (let v = 0; v < 16; v++) t[cr * 16 + v] = hammingEncode(v, cr);
	return t;
})();

/** VALID[cr * 256 + cw]: cw is a codeword of 4/cr (hammingDecode would report no error). */
const VALID = (() => {
	const t = new Uint8Array(9 * 256);
	for (let cr = 5; cr <= 8; cr++) for (let v = 0; v < 16; v++) t[cr * 256 + ENC[cr * 16 + v]] = 1;
	return t;
})();
export const isCodeword = (cw: number, cr: number): boolean => VALID[cr * 256 + (cw & 0xff)] === 1;

/** Errors of the last hammingDecode: 0, 1 (corrected), 2 (detected, not corrected). */
export const hamming = { errors: 0 };

/** Nearest of the 16 codewords; 4/7 and 4/8 correct one bit, 4/5 and 4/6 only detect. */
export function hammingDecode(cw: number, cr: number): number {
	let best = 0,
		bestD = 99,
		ties = 0;
	for (let v = 0; v < 16; v++) {
		const d = popcount8(ENC[cr * 16 + v] ^ cw);
		if (d < bestD) {
			bestD = d;
			best = v;
			ties = 0;
		} else if (d === bestD) ties++;
	}
	if (bestD === 0) {
		hamming.errors = 0;
		return best;
	}
	if (cr >= 7 && bestD === 1 && ties === 0) {
		hamming.errors = 1;
		return best;
	}
	hamming.errors = 2;
	const s = cr <= 5 ? 4 : cr - 1;
	return ((cw >> s) & 1) | (((cw >> (s - 1)) & 1) << 1) | (((cw >> (s - 2)) & 1) << 2) | (((cw >> (s - 3)) & 1) << 3);
}

/** gr-lora_sdr header_impl.cc: 5 bits over the three header nibbles. */
export function headerChecksum(n0: number, n1: number, n2: number): number {
	const b = (n: number, k: number) => (n >> k) & 1;
	const c4 = b(n0, 3) ^ b(n0, 2) ^ b(n0, 1) ^ b(n0, 0);
	const c3 = b(n0, 3) ^ b(n1, 3) ^ b(n1, 2) ^ b(n1, 1) ^ b(n2, 0);
	const c2 = b(n0, 2) ^ b(n1, 3) ^ b(n1, 0) ^ b(n2, 3) ^ b(n2, 1);
	const c1 = b(n0, 1) ^ b(n1, 2) ^ b(n1, 0) ^ b(n2, 2) ^ b(n2, 1) ^ b(n2, 0);
	const c0 = b(n0, 0) ^ b(n1, 1) ^ b(n2, 3) ^ b(n2, 2) ^ b(n2, 1) ^ b(n2, 0);
	return (c4 << 4) | (c3 << 3) | (c2 << 2) | (c1 << 1) | c0;
}

/** gr-lora_sdr add_crc_impl.cc: CRC-16 (0x1021, initial 0) over all but the last two bytes, then XOR with those two. */
export function payloadCrc(p: ArrayLike<number>, n: number): number {
	let crc = 0;
	for (let i = 0; i + 2 < n; i++) {
		let v = p[i];
		for (let k = 0; k < 8; k++) {
			crc = ((crc & 0x8000) >> 8) ^ (v & 0x80) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
			v = (v << 1) & 0xff;
		}
	}
	if (n >= 1) crc ^= p[n - 1];
	if (n >= 2) crc ^= p[n - 2] << 8;
	return crc;
}

export const gray = (x: number): number => (x ^ (x >>> 1)) >>> 0;
export function grayDecode(g: number): number {
	let x = g;
	for (let s = g >>> 1; s; s >>>= 1) x ^= s;
	return x >>> 0;
}

/** Symbols after the SFD of an explicit-header frame (SX1261/2 datasheet 6.1.4): 8 + ceil(...) (CR + 4). */
export function dataSymbols(p: Pick<LoraParams, 'sf' | 'ldro' | 'crc' | 'cr' | 'implicitHdr'>, len: number): number {
	const de = p.ldro ? 1 : 0,
		crc = p.crc ? 1 : 0;
	const num = 8 * len - 4 * p.sf + (p.sf < 7 ? 20 : 28) + 16 * crc - (p.implicitHdr ? 20 : 0);
	const den = 4 * (p.sf - 2 * de);
	const blocks = num > 0 ? Math.floor((num + den - 1) / den) : 0;
	return 8 + blocks * p.cr;
}

/** The whole frame: preamble + 4.25 + data symbols. */
export function airSeconds(p: LoraParams, len: number): number {
	return (p.preamble + 4.25 + sfdExtraSymbols(p.sf) + dataSymbols(p, len)) * symbolSeconds(p.sf, p.bwHz);
}

/** One interleaver block: sfApp codewords of cwLen bits to cwLen symbols (interleaver_impl.cc, gray_demap_impl.cc). */
function interleave(cw: Uint8Array, cwLen: number, sf: number, sfApp: number, reduced: boolean, out: number[]): void {
	const n = 1 << sf;
	for (let i = 0; i < cwLen; i++) {
		let v = 0;
		for (let j = 0; j < sfApp; j++) {
			const r = (((i - j - 1) % sfApp) + sfApp) % sfApp;
			v |= ((cw[r] >> (cwLen - 1 - i)) & 1) << (sfApp - 1 - j);
		}
		const s = reduced ? 4 * grayDecode(v) + 1 : grayDecode(v) + 1;
		out.push(s % n);
	}
}

/** The data symbols (FFT bins 0..2^sf - 1 after the SFD) of a frame. */
export function encode(p: LoraParams, payload: ArrayLike<number>, n: number): Uint16Array {
	const nib: number[] = [];
	const n0 = (n >> 4) & 0xf,
		n1 = n & 0xf,
		n2 = ((p.cr - 4) << 1) | (p.crc ? 1 : 0);
	const chk = headerChecksum(n0, n1, n2);
	if (!p.implicitHdr) nib.push(n0, n1, n2, chk >> 4, chk & 0xf);
	for (let i = 0; i < n; i++) {
		const w = payload[i] ^ whitening(i);
		nib.push(w & 0xf, w >> 4);
	}
	if (p.crc) {
		const c = payloadCrc(payload, n);
		nib.push(c & 0xf, (c >> 4) & 0xf, (c >> 8) & 0xf, c >> 12);
	}
	const out: number[] = [];
	const cw = new Uint8Array(12);
	let k = 0;
	// header block: sf - 2 codewords at 4/8, sent at the reduced rate (SF5 / 6: sf codewords at the full rate)
	const hApp = headerSfApp(p.sf);
	for (let r = 0; r < hApp; r++) cw[r] = hammingEncode(k < nib.length ? nib[k++] : 0, 8);
	interleave(cw, 8, p.sf, hApp, p.sf >= 7, out);
	const sfApp = p.ldro ? p.sf - 2 : p.sf;
	while (k < nib.length) {
		for (let r = 0; r < sfApp; r++) cw[r] = hammingEncode(k < nib.length ? nib[k++] : 0, p.cr);
		interleave(cw, p.cr, p.sf, sfApp, p.ldro, out);
	}
	return Uint16Array.from(out);
}
