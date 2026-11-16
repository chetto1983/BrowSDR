// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/hfdig/hfdig_ftx_tables.cpp (crc14, encode174, checkCrc,
// ldpcDecode, osdDecode: the CRC-14 and the (174,91) LDPC code of FT8 / FT4, after WSJT-X's crc14.cpp,
// encode174_91.f90 and the QEX paper), https://github.com/adswill/OnAir; see third_party/onair. Changes: OnAir's three
// 64-bit words of a codeword in ordered-statistics decoding are six 32-bit words here; belief propagation runs in double
// precision with tanh and atanh read from tables (within 1e-4 of the computed values; OnAir computes them in float), and
// also stops early by WSJT-X's own rule (bpdecode174_91.f90), which leaves out most of the iterations spent on noise.

import { LDPC_GEN, LDPC_K, LDPC_M, LDPC_MN, LDPC_N, LDPC_NM, LDPC_NUM_ROWS } from './tables';
import type { OsdStats } from './types';

/** A pure noise candidate stays near 40 unsatisfied checks: belief propagation gives up after this many iterations ... */
const BP_ABORT_IT = 10;
/** ... when this many checks are still wrong. */
const BP_ABORT_ERR = 33;
/** 32-bit words of a codeword bit set (174 bits). */
const WORDS = 6;

const genBit = (r: number, j: number): number => (LDPC_GEN[r * 12 + (j >> 3)] >> (7 - (j & 7))) & 1;

/** CRC-14 (polynomial 0x2757) of the 77 message bits, as WSJT-X: over 82 bits (the message and 5 zeros), augmented. */
export function crc14(bits77: ArrayLike<number>): number {
	let r = 0;
	for (let i = 0; i < 96; i++) {
		const bit = i < 77 ? bits77[i] & 1 : 0;
		const top = (r >> 13) & 1;
		r = ((r << 1) | bit) & 0x3fff;
		if (top) r ^= 0x2757;
	}
	return r;
}

/** 77 message bits -> the 174-bit codeword: message, CRC-14, 83 parity bits. */
export function encode174(bits77: ArrayLike<number>, cw: Uint8Array): void {
	for (let i = 0; i < 77; i++) cw[i] = bits77[i] & 1;
	const c = crc14(bits77);
	for (let i = 0; i < 14; i++) cw[77 + i] = (c >> (13 - i)) & 1;
	for (let r = 0; r < LDPC_M; r++) {
		let s = 0;
		for (let j = 0; j < LDPC_K; j++) if (genBit(r, j)) s ^= cw[j];
		cw[LDPC_K + r] = s;
	}
}

export function checkCrc(cw: Uint8Array): boolean {
	let got = 0;
	for (let i = 0; i < 14; i++) got = (got << 1) | cw[77 + i];
	return crc14(cw) === got;
}

/** The edges, check by check: the variable node of each and its message slot (variable * 3 + which of its three checks). */
const EDGES = (() => {
	const start = new Int32Array(LDPC_M + 1);
	const vars: number[] = [];
	const slots: number[] = [];
	for (let m = 0; m < LDPC_M; m++) {
		start[m] = vars.length;
		for (let k = 0; k < LDPC_NUM_ROWS[m]; k++) {
			const v = LDPC_NM[m * 7 + k] - 1;
			vars.push(v);
			for (let s = 0; s < 3; s++) if (LDPC_MN[v * 3 + s] - 1 === m) slots.push(v * 3 + s);
		}
	}
	start[LDPC_M] = vars.length;
	return { start, vars: Int32Array.from(vars), slots: Int32Array.from(slots) };
})();

/** tanh over 0 .. 7.5 (the messages are clamped to +-15 before halving), read with linear interpolation (error below 4e-7). */
const TANH_MAX = 7.5;
const TANH_SCALE = 4096 / TANH_MAX;
const TANH = Float64Array.from({ length: 4098 }, (_, i) => Math.tanh(i / TANH_SCALE));
/** 2 atanh(p) = log((1 + p) / (1 - p)) over 0 .. 0.995, read with linear interpolation (error below 1e-4); beyond, computed. */
const ATANH_MAX = 0.995;
const ATANH_SCALE = 8192 / ATANH_MAX;
const ATANH2 = Float64Array.from({ length: 8194 }, (_, i) => {
	const p = Math.min(0.999999, i / ATANH_SCALE);
	return Math.log((1 + p) / (1 - p));
});

const tov = new Float64Array(LDPC_N * 3);
const z = new Float64Array(LDPC_N);
const cur = new Uint8Array(LDPC_N);
/** tanh(-s / 2) of each edge's incoming message. */
const te = new Float64Array(EDGES.vars.length);
const pre = new Float64Array(8);

function unsatisfied(): number {
	const { start, vars } = EDGES;
	let e = 0;
	for (let m = 0; m < LDPC_M; m++) {
		let sx = 0;
		for (let k = start[m]; k < start[m + 1]; k++) sx ^= cur[vars[k]];
		e += sx;
	}
	return e;
}

/** One round of check-node messages: prefix and suffix products of tanh, linear in the check degree. */
function checkMessages(): void {
	const { start, vars, slots } = EDGES;
	// tanh(-s / 2) of the message of each edge with the edge's own message left out, s clamped to +-15
	for (let e = 0; e < te.length; e++) {
		const s = z[vars[e]] - tov[slots[e]];
		let x = s < 0 ? -0.5 * s : 0.5 * s;
		if (x > TANH_MAX) x = TANH_MAX;
		const q = x * TANH_SCALE;
		const i = q | 0;
		const v = TANH[i] + (q - i) * (TANH[i + 1] - TANH[i]);
		te[e] = s > 0 ? -v : v;
	}
	for (let m = 0; m < LDPC_M; m++) {
		const e0 = start[m];
		const d = start[m + 1] - e0;
		pre[0] = 1;
		for (let k = 0; k < d; k++) pre[k + 1] = pre[k] * te[e0 + k];
		let suf = 1;
		for (let k = d - 1; k >= 0; k--) {
			const p = pre[k] * suf;
			suf *= te[e0 + k];
			let a = p < 0 ? -p : p;
			if (a > 0.999999) a = 0.999999;
			let v: number;
			if (a >= ATANH_MAX) v = Math.log((1 + a) / (1 - a));
			else {
				const q = a * ATANH_SCALE;
				const i = q | 0;
				v = ATANH2[i] + (q - i) * (ATANH2[i + 1] - ATANH2[i]);
			}
			tov[slots[e0 + k]] = p > 0 ? -v : v;
		}
	}
}

/** Belief propagation (sum-product). llr > 0 means 1. Returns the number of parity checks still wrong (0 = a codeword). */
export function ldpcDecode(llr: ArrayLike<number>, iters: number, cw: Uint8Array): number {
	tov.fill(0);
	let best = LDPC_M + 1;
	let last = LDPC_M + 1;
	let flat = 0;
	for (let it = 0; it <= iters; it++) {
		for (let n = 0; n < LDPC_N; n++) {
			z[n] = llr[n] + tov[n * 3] + tov[n * 3 + 1] + tov[n * 3 + 2];
			cur[n] = z[n] > 0 ? 1 : 0;
		}
		const e = unsatisfied();
		if (e < best) {
			best = e;
			cw.set(cur);
		}
		if (e === 0 || it === iters) break;
		if (it === BP_ABORT_IT && e >= BP_ABORT_ERR) break;
		// WSJT-X's own early stop (bpdecode174_91.f90): no fewer unsatisfied checks for 5 iterations, from iteration 10
		flat = it > 0 && e >= last ? flat + 1 : 0;
		last = e;
		if (flat >= 5 && it >= 10 && e > 15) break;
		checkMessages();
	}
	return best;
}

/** The codeword of each unit message: message bit j and the parity bits it feeds, as 6 words. */
const GEN_ROWS = (() => {
	const g = new Int32Array(LDPC_K * WORDS);
	for (let j = 0; j < LDPC_K; j++) {
		g[j * WORDS + (j >> 5)] |= 1 << (j & 31);
		for (let r = 0; r < LDPC_M; r++) if (genBit(r, j)) g[j * WORDS + ((LDPC_K + r) >> 5)] |= 1 << ((LDPC_K + r) & 31);
	}
	return g;
})();

const osdG = new Int32Array(LDPC_K * WORDS);
const piv = new Int32Array(LDPC_K);
const hard = new Int32Array(WORDS);
const c0 = new Int32Array(WORDS);
const d0 = new Int32Array(WORDS);
const best = new Int32Array(WORDS);
const abs = new Float64Array(LDPC_N);
const order = Array.from({ length: LDPC_N }, (_, i) => i);
/** Sum of |llr| over the bits of each value of each byte of a codeword (24 bytes of 256 values, bits past 173 count 0). */
const byteSums = new Float64Array(24 * 256);

const bitOf = (v: Int32Array, off: number, c: number): number => (v[off + (c >> 5)] >>> (c & 31)) & 1;

function popcount(x: number): number {
	let n = 0;
	for (let v = x >>> 0; v; v &= v - 1) n++;
	return n;
}

function fillByteSums(): void {
	for (let b = 0; b < 24; b++) {
		byteSums[b * 256] = 0;
		for (let v = 1; v < 256; v++) {
			const low = 31 - Math.clz32(v & -v);
			const i = 8 * b + low;
			byteSums[b * 256 + v] = byteSums[b * 256 + (v & (v - 1))] + (i < LDPC_N ? abs[i] : 0);
		}
	}
}

const byteSum = (o: number, x: number): number =>
	byteSums[o + (x & 255)] + byteSums[o + 256 + ((x >>> 8) & 255)] + byteSums[o + 512 + ((x >>> 16) & 255)] + byteSums[o + 768 + (x >>> 24)];

/** Sum of |llr| over the set bits of a difference from the hard decisions (6 words). */
function distanceOf(w0: number, w1: number, w2: number, w3: number, w4: number, w5: number): number {
	return byteSum(0, w0) + byteSum(1024, w1) + byteSum(2048, w2) + byteSum(3072, w3) + byteSum(4096, w4) + byteSum(5120, w5);
}

/** The generator brought to systematic form on the most reliable independent bits; false when they do not span the code. */
function reduce(): boolean {
	// Array.prototype.sort is stable, as OnAir's std::stable_sort
	order.sort((a, b) => abs[b] - abs[a]);
	osdG.set(GEN_ROWS);
	let np = 0;
	for (let ci = 0; ci < LDPC_N && np < LDPC_K; ci++) {
		const c = order[ci];
		const cw = c >> 5;
		const cb = c & 31;
		let row = -1;
		for (let r = np; r < LDPC_K; r++)
			if ((osdG[r * WORDS + cw] >>> cb) & 1) {
				row = r;
				break;
			}
		if (row < 0) continue;
		for (let w = 0; w < WORDS; w++) {
			const tmp = osdG[row * WORDS + w];
			osdG[row * WORDS + w] = osdG[np * WORDS + w];
			osdG[np * WORDS + w] = tmp;
		}
		for (let r = 0; r < LDPC_K; r++)
			if (r !== np && (osdG[r * WORDS + cw] >>> cb) & 1) for (let w = 0; w < WORDS; w++) osdG[r * WORDS + w] ^= osdG[np * WORDS + w];
		piv[np++] = c;
	}
	return np === LDPC_K;
}

/**
 * Ordered-statistics decoding (order 1, plus order 2 on the nPair least reliable basis bits) when belief propagation
 * fails: true when the nearest codeword passes the CRC. The codeword nearest to the received bits (sum of |llr| over
 * the bits that differ) wins, and only then is its CRC checked, so a slot of noise passes about once in 2^14 tries.
 */
export function osdDecode(llr: ArrayLike<number>, nPair: number, cw: Uint8Array, st?: OsdStats): boolean {
	let tot = 0;
	hard.fill(0);
	for (let i = 0; i < LDPC_N; i++) {
		order[i] = i;
		abs[i] = Math.abs(llr[i]);
		tot += abs[i];
		if (llr[i] > 0) hard[i >> 5] |= 1 << (i & 31);
	}
	if (!reduce()) return false;
	fillByteSums();
	c0.fill(0);
	for (let p = 0; p < LDPC_K; p++) if (bitOf(hard, 0, piv[p])) for (let w = 0; w < WORDS; w++) c0[w] ^= osdG[p * WORDS + w];
	for (let w = 0; w < WORDS; w++) d0[w] = c0[w] ^ hard[w];
	// candidates as their difference from the hard decisions: d0 with one or two basis rows added
	let bestA = -1;
	let bestB = -1;
	let dBest = distanceOf(d0[0], d0[1], d0[2], d0[3], d0[4], d0[5]);
	let d2 = 1e30;
	const consider = (d: number, a: number, b: number): void => {
		if (d < dBest) {
			d2 = dBest;
			dBest = d;
			[bestA, bestB] = [a, b];
		} else if (d < d2) d2 = d;
	};
	const G = osdG;
	for (let p = 0; p < LDPC_K; p++) {
		const o = p * WORDS;
		consider(distanceOf(d0[0] ^ G[o], d0[1] ^ G[o + 1], d0[2] ^ G[o + 2], d0[3] ^ G[o + 3], d0[4] ^ G[o + 4], d0[5] ^ G[o + 5]), p, -1);
	}
	const pairs = Math.min(nPair, LDPC_K);
	for (let a = LDPC_K - pairs; a < LDPC_K; a++)
		for (let b = a + 1; b < LDPC_K; b++) {
			const [oa, ob] = [a * WORDS, b * WORDS];
			const d = distanceOf(
				d0[0] ^ G[oa] ^ G[ob],
				d0[1] ^ G[oa + 1] ^ G[ob + 1],
				d0[2] ^ G[oa + 2] ^ G[ob + 2],
				d0[3] ^ G[oa + 3] ^ G[ob + 3],
				d0[4] ^ G[oa + 4] ^ G[ob + 4],
				d0[5] ^ G[oa + 5] ^ G[ob + 5],
			);
			consider(d, a, b);
		}
	best.set(c0);
	for (const r of [bestA, bestB]) if (r >= 0) for (let w = 0; w < WORDS; w++) best[w] ^= G[r * WORDS + w];
	for (let i = 0; i < LDPC_N; i++) cw[i] = bitOf(best, 0, i);
	if (st) {
		let he = 0;
		for (let w = 0; w < WORDS; w++) he += popcount(best[w] ^ hard[w]);
		st.hardErrors = he;
		st.dist = dBest / Math.max(1e-30, tot);
		st.margin = (d2 - dBest) / Math.max(1e-30, tot);
	}
	return checkCrc(cw);
}
