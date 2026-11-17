// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir rust/onair_dmr/src/codes.rs (Golay (20,8), QR (16,7,6), Hamming (7,4), the
// Hamming codes of the block product codes, Reed-Solomon (12,9), CRC-CCITT, CRC-8, CRC-9, CRC-32, checksum5) and
// rust/onair_dmr/src/bits.rs (get_bits, bits_to_bytes, Out), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the codeword tables are built once at module load; bits are Uint8Array with one bit per element and the
// bit writer is a function that appends to a plain array.
//
// DMR short block codes and checksums of ETSI TS 102 361-1 annex B. The generator matrices are those of tables B.11 to
// B.17 (parity part of the systematic matrix, first information bit first, first parity column on top).

const GOLAY_ROWS = [0x3da, 0xd99, 0x6cd, 0x367, 0xdc6, 0xa97, 0x93e, 0x8eb]; // table B.11 (20,8)
const QR_ROWS = [0x04f, 0x11e, 0x1b7, 0x1e2, 0x1c9, 0x0e5, 0x073]; // table B.12 (16,7,6)
const HAM743_ROWS = [0x5, 0x7, 0x6, 0x3]; // table B.17
const HAM1393_ROWS = [0xf, 0xe, 0x7, 0xa, 0x5, 0xb, 0xc, 0x6, 0x3]; // table B.14
const HAM15113_ROWS = [0x9, 0xd, 0xf, 0xe, 0x7, 0xa, 0x5, 0xb, 0xc, 0x6, 0x3]; // table B.15
const HAM16114_ROWS = [0x13, 0x1a, 0x1f, 0x1c, 0x0e, 0x15, 0x0b, 0x16, 0x19, 0x0d, 0x07]; // table B.16
const HAM17123_ROWS = [0x1b, 0x1f, 0x1d, 0x1c, 0x0e, 0x07, 0x11, 0x1a, 0x0d, 0x14, 0x0a, 0x05]; // table B.13

// ── bit helpers (bits.rs) ─────────────────────────────────────────────

/** `n` bits (at most 32) of `b` from bit `pos`, first bit on top; bits past the end read as 0. */
export function getBits(b: ArrayLike<number>, pos: number, n: number): number {
	let v = 0;
	for (let i = 0; i < n; i++) v = v * 2 + (pos + i < b.length ? b[pos + i] & 1 : 0);
	return v;
}

/** Packs `nbits / 8` bytes out of `b` starting at bit `pos`. */
export function bitsToBytes(b: ArrayLike<number>, pos: number, nbits: number): Uint8Array {
	const out = new Uint8Array(nbits >> 3);
	for (let i = 0; i < out.length; i++) out[i] = getBits(b, pos + i * 8, 8);
	return out;
}

/** Appends the `n` low bits of `v` to `out`, most significant first. */
export function putBits(out: number[], v: number, n: number): void {
	for (let i = n - 1; i >= 0; i--) out.push(Math.floor(v / 2 ** i) & 1);
}

/** The bits of each byte of `d`, most significant first. */
export function bytesToBits(d: ArrayLike<number>): Uint8Array {
	const out = new Uint8Array(d.length * 8);
	for (let i = 0; i < out.length; i++) out[i] = (d[i >> 3] >> (7 - (i & 7))) & 1;
	return out;
}

export function popcount32(v: number): number {
	let n = 0;
	for (let x = v >>> 0; x; x &= x - 1) n++;
	return n;
}

// ── short codes ──────────────────────────────────────────────────────

/** Parity of `info` (k bits) under the parity rows of a code: XOR of the rows of the set information bits. */
function encodeRows(rows: readonly number[], k: number, info: number): number {
	let p = 0;
	for (let i = 0; i < k; i++) if ((info >> (k - 1 - i)) & 1) p ^= rows[i];
	return p;
}

/** All codewords `(info << p) | parity(info)` of a short code, indexed by the information word. */
function codeWords(rows: readonly number[], k: number, p: number): Uint32Array {
	const w = new Uint32Array(1 << k);
	for (let i = 0; i < w.length; i++) w[i] = (i << p) | encodeRows(rows, k, i);
	return w;
}

const GOLAY_WORDS = codeWords(GOLAY_ROWS, 8, 12);
const QR_WORDS = codeWords(QR_ROWS, 7, 9);
const HAM743_WORDS = codeWords(HAM743_ROWS, 4, 3);

/** Nearest codeword by exhaustive search (first of the minimum distance): [errors, information word], or null when farther than maxErr. */
function nearest(words: Uint32Array, w: number, maxErr: number): [number, number] | null {
	let best = 99;
	let bi = 0;
	for (let i = 0; i < words.length; i++) {
		const d = popcount32(words[i] ^ w);
		if (d < best) {
			best = d;
			bi = i;
		}
	}
	return best > maxErr ? null : [best, bi];
}

/** Slot type (B.3.1): 4 bit colour code and 4 bit data type -> 12 parity bits. */
export const golay2008Parity = (info8: number) => encodeRows(GOLAY_ROWS, 8, info8 & 0xff);
/** Nearest Golay (20,8) codeword within 3 bit errors: [errors, info], or null. */
export const golay2008Decode = (word20: number) => nearest(GOLAY_WORDS, word20 & 0xfffff, 3);
/** EMB (B.3.2): 4 bit colour code, PI, 2 bit LCSS -> 9 parity bits. */
export const qr1676Parity = (info7: number) => encodeRows(QR_ROWS, 7, info7 & 0x7f);
/** Nearest QR (16,7,6) codeword within 2 bit errors. */
export const qr1676Decode = (word16: number) => nearest(QR_WORDS, word16 & 0xffff, 2);
/** TACT (B.3.5): access type, channel, 2 bit LCSS -> 3 parity bits. */
export const hamming743Parity = (info4: number) => encodeRows(HAM743_ROWS, 4, info4 & 0xf);
/** Hamming (7,4) single error correction. */
export const hamming743Decode = (word7: number) => nearest(HAM743_WORDS, word7 & 0x7f, 1);

/** The Hamming codes of the block product codes: (13,9,3) BPTC columns, (15,11,3) BPTC rows, (16,11,4) embedded LC rows, (17,12,3) short LC. */
export const enum Hamming {
	H1393 = 0,
	H15113 = 1,
	H16114 = 2,
	H17123 = 3,
}

const HAMMING_ROWS = [HAM1393_ROWS, HAM15113_ROWS, HAM16114_ROWS, HAM17123_ROWS];
const HAMMING_PARITY_BITS = [4, 4, 5, 5];

/** Syndrome -> bit position (0 = first bit of the word) of a single error, -1 none. */
function syndromePositions(rows: readonly number[], p: number): Int8Array {
	const k = rows.length;
	const pos = new Int8Array(32).fill(-1);
	for (let j = 0; j < k + p; j++) pos[j < k ? rows[j] : 1 << (p - 1 - (j - k))] = j;
	return pos;
}
const POSITIONS = HAMMING_ROWS.map((rows, i) => syndromePositions(rows, HAMMING_PARITY_BITS[i]));

export const hammingInfoBits = (k: Hamming) => HAMMING_ROWS[k].length;
export const hammingParityBits = (k: Hamming) => HAMMING_PARITY_BITS[k];

/** Check bits of `info` for Hamming code `k`. */
export const hammingParity = (k: Hamming, info: number) => encodeRows(HAMMING_ROWS[k], HAMMING_ROWS[k].length, info);

/** Corrects a single bit error: [result, word] with result 0 clean, 1 one bit corrected, -1 not correctable (word untouched). */
export function hammingCorrect(kind: Hamming, word: number): [number, number] {
	const k = HAMMING_ROWS[kind].length;
	const p = HAMMING_PARITY_BITS[kind];
	const syn = hammingParity(kind, word >>> p) ^ (word & ((1 << p) - 1));
	if (!syn) return [0, word];
	const j = POSITIONS[kind][syn];
	if (j < 0) return [-1, word];
	return [1, word ^ (1 << (k + p - 1 - j))];
}

// ── Reed-Solomon (12,9) over GF(256), x^8 + x^4 + x^3 + x^2 + 1 ─────

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
	let x = 1;
	for (let i = 0; i < 255; i++) {
		GF_EXP[i] = x;
		GF_LOG[x] = i;
		x <<= 1;
		if (x & 0x100) x ^= 0x11d;
	}
	for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}
const mul = (a: number, b: number) => (a && b ? GF_EXP[GF_LOG[a] + GF_LOG[b]] : 0);
const RS_GEN = [0x0e, 0x38, 0x40]; // g(x) = x^3 + 0e x^2 + 38 x + 40 (B.10)

/** Reed-Solomon (12,9) parity of 9 message bytes. */
export function rs129Parity(msg: ArrayLike<number>): [number, number, number] {
	const r = [0, 0, 0];
	for (let i = 0; i < 9; i++) {
		const fb = msg[i] ^ r[0];
		r[0] = r[1] ^ mul(fb, RS_GEN[0]);
		r[1] = r[2] ^ mul(fb, RS_GEN[1]);
		r[2] = mul(fb, RS_GEN[2]);
	}
	return [r[0], r[1], r[2]];
}

/** Corrects one wrong symbol of a (12,9) word in place (parity bytes unmasked): 0 clean, 1 corrected, -1 failed. */
export function rs129Correct(word: Uint8Array): number {
	const s = [0, 0, 0];
	for (let j = 1; j <= 3; j++) {
		let acc = 0;
		for (let i = 0; i < 12; i++) acc = mul(acc, GF_EXP[j]) ^ word[i];
		s[j - 1] = acc;
	}
	if (!s[0] && !s[1] && !s[2]) return 0;
	if (!s[0] || !s[1] || !s[2]) return -1;
	// one error of value e at power p: S1 = e a^p, S2 = e a^2p, S3 = e a^3p
	const p = (GF_LOG[s[1]] - GF_LOG[s[0]] + 255) % 255;
	if (p > 11) return -1;
	const e = GF_EXP[(GF_LOG[s[0]] - p + 255) % 255];
	if (mul(e, GF_EXP[(3 * p) % 255]) !== s[2]) return -1;
	word[11 - p] ^= e;
	return 1;
}

// ── checksums ────────────────────────────────────────────────────────

/** CRC-CCITT of B.3.8 with the final inversion (still to be masked per data type). */
export function crcCcitt(d: ArrayLike<number>, n = d.length): number {
	let c = 0;
	for (let i = 0; i < n; i++) {
		c ^= d[i] << 8;
		for (let b = 0; b < 8; b++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
	}
	return ~c & 0xffff;
}

/** CRC-8 of the short LC and hash (B.3.7), over `nbits` bits (28 for the short LC, 24 for an address hash). */
export function crc8Short(bits: number, nbits = 28): number {
	let c = 0;
	for (let i = nbits - 1; i >= 0; i--) {
		c = (c << 1) | (Math.floor(bits / 2 ** i) & 1);
		if (c & 0x100) c ^= 0x107;
	}
	for (let i = 0; i < 8; i++) {
		c <<= 1;
		if (c & 0x100) c ^= 0x107;
	}
	return c & 0xff;
}

/** CRC-9 of confirmed data blocks (B.3.10) before the data type mask: the data octets, then the 7 bit serial number. */
export function crc9(d: ArrayLike<number>, dbsn: number): number {
	let c = 0;
	const shift = (bit: number) => {
		const top = (c >> 8) & 1;
		c = ((c << 1) | bit) & 0x1ff;
		if (top) c ^= 0x059; // G9 = x^9 + x^6 + x^4 + x^3 + 1 (B.23)
	};
	for (let i = 0; i < d.length; i++) for (let b = 7; b >= 0; b--) shift((d[i] >> b) & 1);
	for (let b = 6; b >= 0; b--) shift((dbsn >> b) & 1);
	for (let i = 0; i < 9; i++) shift(0);
	return (c ^ 0x1ff) & 0x1ff;
}

/** Message CRC-32 of B.3.9 (octets of each 16-bit word least significant first, initial value 0, no inversion). */
export function crc32Msg(d: ArrayLike<number>, n = d.length): number {
	let c = 0;
	const feed = (b: number) => {
		c = (c ^ (b << 24)) >>> 0;
		for (let k = 0; k < 8; k++) c = c & 0x80000000 ? ((c << 1) ^ 0x04c11db7) >>> 0 : (c << 1) >>> 0;
	};
	let i = 0;
	for (; i + 1 < n; i += 2) {
		feed(d[i + 1]);
		feed(d[i]);
	}
	if (n & 1) feed(d[n - 1]);
	return c >>> 0;
}

/** Embedded LC checksum (B.3.11): the sum of the nine octets modulo 31. */
export function checksum5(lc: ArrayLike<number>): number {
	let s = 0;
	for (let i = 0; i < 9; i++) s += lc[i];
	return s % 31;
}
