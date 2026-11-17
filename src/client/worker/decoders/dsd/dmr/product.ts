// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir rust/onair_dmr/src/product.rs (bptc196_encode, bptc196_decode,
// emb_lc_encode, emb_lc_decode, short_lc_encode, short_lc_decode, cach_encode, cach_decode, trellis34_encode,
// trellis34_decode, rate1_encode, rate1_decode, symbol_to_dibit, dibit_to_symbol), https://github.com/adswill/OnAir;
// see third_party/onair.
// Changes: the matrices are flat typed arrays; decoders return their result with the decoded data instead of writing
// through out parameters.
//
// DMR block product codes and interleavers (ETSI TS 102 361-1 annex B): BPTC (196,96) of control blocks and rate 1/2
// data (B.1.1), the variable length BPTC of the embedded link control (B.2.1), the short LC in the CACH (B.2.3), the
// CACH burst with its TACT (B.4.1), the rate 3/4 trellis code (B.2.4) and rate 1 data (B.2.5).
import {
	bitsToBytes,
	bytesToBits,
	checksum5,
	crc8Short,
	getBits,
	Hamming,
	hamming743Decode,
	hamming743Parity,
	hammingCorrect,
	hammingParity,
} from './codes';

/** Positions (row * 15 + column) of I(95)..I(0) in the nine information rows: row 0 has three reserved bits in front. */
const BPTC_INFO = (() => {
	const out: number[] = [];
	for (let r = 0; r < 9; r++) for (let c = r === 0 ? 3 : 0; c < 11; c++) out.push(r * 15 + c);
	return out;
})();
/** Transmit position of matrix element (row r, column c): sequential number 1 + r*15 + c, times 181 modulo 196. */
const BPTC_TX = Uint8Array.from({ length: 195 }, (_, i) => ((i + 1) * 181) % 196);

/** 4FSK symbol (+3, +1, -1, -3) to dibit (table 10.3). */
export const symbolToDibit = (s: number) => (s === 3 ? 1 : s === 1 ? 0 : s === -1 ? 2 : 3);
/** Dibit to 4FSK symbol: 01 -> +3, 00 -> +1, 10 -> -1, 11 -> -3. */
export const dibitToSymbol = (d: number) => (d === 1 ? 3 : d === 0 ? 1 : d === 2 ? -1 : -3);

/** BPTC (196,96) encoder: info96[0] is I(95); returns the 196 bits in transmit order. */
export function bptc196Encode(info96: ArrayLike<number>): Uint8Array {
	const m = new Uint8Array(13 * 15);
	for (let i = 0; i < 96; i++) m[BPTC_INFO[i]] = info96[i] & 1;
	for (let r = 0; r < 9; r++) {
		const p = hammingParity(Hamming.H15113, getBits(m, r * 15, 11));
		for (let j = 0; j < 4; j++) m[r * 15 + 11 + j] = (p >> (3 - j)) & 1;
	}
	for (let c = 0; c < 15; c++) {
		let w = 0;
		for (let r = 0; r < 9; r++) w = (w << 1) | m[r * 15 + c];
		const p = hammingParity(Hamming.H1393, w);
		for (let j = 0; j < 4; j++) m[(9 + j) * 15 + c] = (p >> (3 - j)) & 1;
	}
	const tx = new Uint8Array(196);
	for (let i = 0; i < 195; i++) tx[BPTC_TX[i]] = m[i];
	return tx;
}

/** One correction pass over the columns then the rows: [changed, failed]. */
function bptcPass(m: Uint8Array, fix: boolean): [number, boolean] {
	let corrected = 0;
	let failed = false;
	for (let c = 0; c < 15; c++) {
		let w = 0;
		for (let r = 0; r < 13; r++) w = (w << 1) | m[r * 15 + c];
		const [e, x] = fix ? hammingCorrect(Hamming.H1393, w) : [hammingParity(Hamming.H1393, w >> 4) === (w & 15) ? 0 : -1, w];
		if (e > 0) for (let r = 0; r < 13; r++) m[r * 15 + c] = (x >> (12 - r)) & 1;
		if (e > 0) corrected++;
		else if (e < 0) failed = true;
	}
	for (let r = 0; r < 9; r++) {
		const w = getBits(m, r * 15, 15);
		const [e, x] = fix ? hammingCorrect(Hamming.H15113, w) : [hammingParity(Hamming.H15113, w >> 4) === (w & 15) ? 0 : -1, w];
		if (e > 0) for (let c = 0; c < 15; c++) m[r * 15 + c] = (x >> (14 - c)) & 1;
		if (e > 0) corrected++;
		else if (e < 0) failed = true;
	}
	return [corrected, failed];
}

/** BPTC (196,96) decoder with up to six row / column correction passes: [bits corrected or -1 when the checks do not clear, info96]. */
export function bptc196Decode(tx: ArrayLike<number>): [number, Uint8Array] {
	const m = new Uint8Array(13 * 15);
	for (let i = 0; i < 195; i++) m[i] = tx[BPTC_TX[i]] & 1;
	let corrected = 0;
	let clean = false;
	for (let iter = 0; iter < 6 && !clean; iter++) {
		const [n, failed] = bptcPass(m, true);
		corrected += n;
		clean = n === 0 && !failed;
	}
	const info = new Uint8Array(96);
	// one last check, without correcting: the loop may have ended just after a successful pass
	if (!clean && bptcPass(m, false)[1]) return [-1, info];
	for (let i = 0; i < 96; i++) info[i] = m[BPTC_INFO[i]];
	return [corrected, info];
}

/** Embedded LC encoder (B.2.1): 72 bit link control + 5 bit checksum as an 8x16 matrix read column-wise into four 32 bit fragments. */
export function embLcEncode(lc: ArrayLike<number>): Uint8Array[] {
	const m = new Uint8Array(8 * 16);
	const lcBits = bytesToBits(Array.from({ length: 9 }, (_, i) => lc[i]));
	const cs = checksum5(lc);
	let k = 0;
	for (let r = 0; r < 7; r++) {
		const nInfo = r < 2 ? 11 : 10;
		for (let c = 0; c < nInfo; c++) m[r * 16 + c] = lcBits[k++];
		if (r >= 2) m[r * 16 + 10] = (cs >> (6 - r)) & 1; // CS(4) in row 2 down to CS(0) in row 6
		const p = hammingParity(Hamming.H16114, getBits(m, r * 16, 11));
		for (let j = 0; j < 5; j++) m[r * 16 + 11 + j] = (p >> (4 - j)) & 1;
	}
	for (let c = 0; c < 16; c++) {
		let x = 0;
		for (let r = 0; r < 7; r++) x ^= m[r * 16 + c];
		m[7 * 16 + c] = x;
	}
	// the columns are read top to bottom, left to right
	return [0, 1, 2, 3].map((f) => Uint8Array.from({ length: 32 }, (_, i) => m[((f * 32 + i) % 8) * 16 + Math.floor((f * 32 + i) / 8)]));
}

/** Row and column-parity passes over the embedded LC matrix: the bits corrected, or -1 for an uncorrectable row. */
function embLcCorrect(m: Uint8Array): number {
	let corrected = 0;
	for (let pass = 0; pass < 3; pass++) {
		let changed = false;
		for (let r = 0; r < 7; r++) {
			const [e, w] = hammingCorrect(Hamming.H16114, getBits(m, r * 16, 16));
			if (e < 0) return -1;
			if (e > 0) {
				for (let c = 0; c < 16; c++) m[r * 16 + c] = (w >> (15 - c)) & 1;
				corrected++;
				changed = true;
			}
		}
		// column parity: a single wrong bit in a column that rows could not see (a parity bit in the bottom row) is fixed here
		for (let c = 0; c < 16; c++) {
			let x = 0;
			for (let r = 0; r < 8; r++) x ^= m[r * 16 + c];
			if (x) {
				m[7 * 16 + c] ^= 1;
				corrected++;
				changed = true;
			}
		}
		if (!changed) break;
	}
	return corrected;
}

/** Embedded LC decoder: [bits corrected, -1 for an uncorrectable matrix, -2 when the checksum is wrong; the nine LC octets]. */
export function embLcDecode(frag: Array<ArrayLike<number>>): [number, Uint8Array] {
	const m = new Uint8Array(8 * 16);
	for (let s = 0; s < 128; s++) m[(s % 8) * 16 + Math.floor(s / 8)] = frag[s >> 5][s & 31] & 1;
	const corrected = embLcCorrect(m);
	if (corrected < 0) return [-1, new Uint8Array(9)];
	const bits: number[] = [];
	for (let r = 0; r < 7; r++) for (let c = 0; c < (r < 2 ? 11 : 10); c++) bits.push(m[r * 16 + c]);
	const lc = bitsToBytes(bits, 0, 72);
	let cs = 0;
	for (let r = 2; r < 7; r++) cs = (cs << 1) | m[r * 16 + 10];
	return [cs === checksum5(lc) ? corrected : -2, lc];
}

/** Short LC encoder (B.2.3): 28 bits + CRC-8 as three (17,12) rows plus a parity row, read column-wise into four 17 bit pieces. */
export function shortLcEncode(lc28: number): Uint8Array[] {
	const all = (lc28 & 0x0fffffff) * 256 + crc8Short(lc28 & 0x0fffffff);
	const m = new Uint8Array(4 * 17);
	for (let r = 0; r < 3; r++) {
		const info = Math.floor(all / 2 ** (24 - 12 * r)) & 0xfff;
		const p = hammingParity(Hamming.H17123, info);
		for (let j = 0; j < 12; j++) m[r * 17 + j] = (info >> (11 - j)) & 1;
		for (let j = 0; j < 5; j++) m[r * 17 + 12 + j] = (p >> (4 - j)) & 1;
	}
	for (let c = 0; c < 17; c++) m[3 * 17 + c] = m[c] ^ m[17 + c] ^ m[34 + c];
	return [0, 1, 2, 3].map((f) => Uint8Array.from({ length: 17 }, (_, i) => m[((f * 17 + i) % 4) * 17 + Math.floor((f * 17 + i) / 4)]));
}

/** Short LC decoder: [bits corrected, -1 uncorrectable, -2 CRC mismatch; the 28 bits]. */
export function shortLcDecode(piece: Array<ArrayLike<number>>): [number, number] {
	const m = new Uint8Array(4 * 17);
	for (let s = 0; s < 68; s++) m[(s % 4) * 17 + Math.floor(s / 4)] = piece[Math.floor(s / 17)][s % 17] & 1;
	let corrected = 0;
	let all = 0;
	for (let r = 0; r < 3; r++) {
		const [e, w] = hammingCorrect(Hamming.H17123, getBits(m, r * 17, 17));
		if (e < 0) return [-1, 0];
		corrected += e;
		all = all * 4096 + (w >> 5);
	}
	const lc28 = Math.floor(all / 256) & 0x0fffffff;
	return [(all & 0xff) === crc8Short(lc28) ? corrected : -2, lc28];
}

/** Transmit order of the 24 CACH bits as [kind, index]: 0 AT, 1 TC, 2 LS1, 3 LS0, 4 parity bit H(index) (H(2) first), 5 payload bit P(index) (P(16) first). */
const CACH_ORDER: ReadonlyArray<readonly [number, number]> = [
	[0, 0],
	[5, 16],
	[5, 15],
	[5, 14],
	[1, 0],
	[5, 13],
	[5, 12],
	[5, 11],
	[2, 0],
	[5, 10],
	[5, 9],
	[5, 8],
	[3, 0],
	[5, 7],
	[4, 2],
	[5, 6],
	[5, 5],
	[5, 4],
	[4, 1],
	[5, 3],
	[5, 2],
	[5, 1],
	[4, 0],
	[5, 0],
];

/** CACH burst (B.4.1): TACT (access type, channel, LCSS, Hamming parity) interleaved with 17 payload bits. */
export function cachEncode(at: number, tc: number, lcss: number, payload17: number): Uint8Array {
	const info = ((at & 1) << 3) | ((tc & 1) << 2) | (lcss & 3);
	const par = hamming743Parity(info);
	return Uint8Array.from(CACH_ORDER, ([kind, idx]) =>
		kind < 4 ? (info >> (3 - kind)) & 1 : kind === 4 ? (par >> idx) & 1 : (payload17 >> idx) & 1,
	);
}

/** CACH decoder: the TACT fields (null when Hamming (7,4) fails) and the 17 payload bits. */
export function cachDecode(in24: ArrayLike<number>): { at: number; tc: number; lcss: number; errors: number; payload17: number } | null {
	let info = 0;
	let par = 0;
	let payload17 = 0;
	CACH_ORDER.forEach(([kind, idx], i) => {
		const v = in24[i] & 1;
		if (kind < 4) info |= v << (3 - kind);
		else if (kind === 4) par |= v << idx;
		else payload17 |= v << idx;
	});
	const fixed = hamming743Decode((info << 3) | par);
	if (!fixed) return null;
	const [errors, word] = fixed;
	return { at: (word >> 3) & 1, tc: (word >> 2) & 1, lcss: word & 3, errors, payload17 };
}

// table B.7: state, input tribit -> constellation point
const TRELLIS_NEXT = [
	[0, 8, 4, 12, 2, 10, 6, 14],
	[4, 12, 2, 10, 6, 14, 0, 8],
	[1, 9, 5, 13, 3, 11, 7, 15],
	[5, 13, 3, 11, 7, 15, 1, 9],
	[3, 11, 7, 15, 1, 9, 5, 13],
	[7, 15, 1, 9, 5, 13, 3, 11],
	[2, 10, 6, 14, 0, 8, 4, 12],
	[6, 14, 0, 8, 4, 12, 2, 10],
];
// table B.8: point -> first and second dibit as 4FSK symbols
const CONSTELLATION = [
	[1, -1],
	[-1, -1],
	[3, -3],
	[-3, -3],
	[-3, -1],
	[3, -1],
	[-1, -3],
	[1, -3],
	[-3, 3],
	[3, 3],
	[-1, 1],
	[1, 1],
	[1, 3],
	[-1, 3],
	[3, 1],
	[-3, 1],
];

/** Table B.9: transmit position k carries encoder dibit f(k): four runs of 26, 24, 24 and 24 positions. */
function trellisInterleave(k: number): number {
	const [base, j] = k < 26 ? [0, k] : k < 50 ? [2, k - 26] : k < 74 ? [4, k - 50] : [6, k - 74];
	return base + 8 * (j >> 1) + (j & 1);
}
const TRELLIS_ORDER = Uint8Array.from({ length: 98 }, (_, k) => trellisInterleave(k));

/** Rate 3/4 trellis encoder (B.2.4): 18 data bytes -> 98 dibits (196 bits) in transmit order. */
export function trellis34Encode(data: ArrayLike<number>): Uint8Array {
	const bits = bytesToBits(Array.from({ length: 18 }, (_, i) => data[i]));
	const sym = new Int8Array(98);
	let state = 0;
	for (let i = 0; i < 49; i++) {
		const t = i < 48 ? getBits(bits, i * 3, 3) : 0; // 48 tribits, then the flushing tribit 000
		const pt = TRELLIS_NEXT[state][t];
		state = t;
		sym[2 * i] = CONSTELLATION[pt][0];
		sym[2 * i + 1] = CONSTELLATION[pt][1];
	}
	const tx = new Uint8Array(196);
	for (let k = 0; k < 98; k++) {
		const d = symbolToDibit(sym[TRELLIS_ORDER[k]]);
		tx[2 * k] = d >> 1;
		tx[2 * k + 1] = d & 1;
	}
	return tx;
}

/** Viterbi search over the 49 tribits: the tribits of the best path ending in state 0, or null. */
function trellisSearch(enc: Float32Array): Uint8Array | null {
	let metric = Float64Array.from({ length: 8 }, (_, s) => (s ? 1e30 : 0));
	const from = new Uint8Array(49 * 8);
	for (let i = 0; i < 49; i++) {
		const nm = new Float64Array(8).fill(1e30);
		for (let s = 0; s < 8; s++) {
			if (metric[s] > 1e29) continue;
			for (let t = 0; t < (i === 48 ? 1 : 8); t++) {
				const pt = TRELLIS_NEXT[s][t]; // the last tribit is the zero flush
				const a = enc[2 * i] - CONSTELLATION[pt][0];
				const b = enc[2 * i + 1] - CONSTELLATION[pt][1];
				const m = metric[s] + a * a + b * b;
				if (m < nm[t]) {
					nm[t] = m;
					from[i * 8 + t] = s;
				}
			}
		}
		metric = nm;
	}
	if (metric[0] > 1e29) return null;
	const tri = new Uint8Array(49);
	for (let i = 48, st = 0; i >= 0; i--) {
		tri[i] = st;
		st = from[i * 8 + st];
	}
	return tri;
}

/**
 * Rate 3/4 trellis decoder: `symbols` are the 98 received 4-level amplitudes in transmit order (soft values fine).
 * Returns [dibits that differ from the best path's re-encoding or -1 when no path ends in the zero state, 18 data bytes].
 */
export function trellis34Decode(symbols: ArrayLike<number>): [number, Uint8Array] {
	const enc = new Float32Array(98);
	for (let k = 0; k < 98; k++) enc[TRELLIS_ORDER[k]] = symbols[k];
	const tri = trellisSearch(enc);
	if (!tri) return [-1, new Uint8Array(18)];
	const bits: number[] = [];
	for (let i = 0; i < 48; i++) bits.push((tri[i] >> 2) & 1, (tri[i] >> 1) & 1, tri[i] & 1);
	const data = bitsToBytes(bits, 0, 144);
	// how many dibits the winning path disagrees with, as a measure of the damage
	const re = trellis34Encode(data);
	let bad = 0;
	for (let k = 0; k < 98; k++) {
		const v = symbols[k];
		const hard = v >= 2 ? 3 : v >= 0 ? 1 : v >= -2 ? -1 : -3;
		if (symbolToDibit(hard) !== ((re[2 * k] << 1) | re[2 * k + 1])) bad++;
	}
	return [bad, data];
}

/** Rate 1 encoder (B.2.5): 192 data bits placed in 196 with four zero pad bits after the first 96. */
export function rate1Encode(data: ArrayLike<number>): Uint8Array {
	const d = bytesToBits(Array.from({ length: 24 }, (_, i) => data[i]));
	const tx = new Uint8Array(196);
	tx.set(d.subarray(0, 96), 0);
	tx.set(d.subarray(96), 100);
	return tx;
}

/** Rate 1 decoder: the 24 data bytes, and whether the four pad bits are zero. */
export function rate1Decode(tx: ArrayLike<number>): { data: Uint8Array; padOk: boolean } {
	const d = new Uint8Array(192);
	for (let i = 0; i < 96; i++) {
		d[i] = tx[i];
		d[96 + i] = tx[100 + i];
	}
	return { data: bitsToBytes(d, 0, 192), padOk: !(tx[96] | tx[97] | tx[98] | tx[99]) };
}
