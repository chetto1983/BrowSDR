// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/dab/dab_fec.cpp (freqInterleaver, phaseReference),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: the tables are built once into typed arrays, with the
// FFT bin of every carrier and the conjugated phase reference precomputed (dab_rx.cpp Impl constructor).

import { CARRIERS, TU } from '@/worker/decoders/dab/constants';

function buildInterleaver(): Int32Array {
	const perm = new Int32Array(TU);
	for (let i = 1; i < TU; i++) perm[i] = (13 * perm[i - 1] + 511) % TU;
	const out: number[] = [];
	for (let i = 0; i < TU; i++) {
		if (perm[i] === TU / 2 || perm[i] < TU / 2 - CARRIERS / 2 || perm[i] > TU / 2 + CARRIERS / 2) continue;
		out.push(perm[i] - TU / 2);
	}
	return Int32Array.from(out);
}

/** Carrier number (-768..768) of the n-th bit pair of an OFDM symbol (EN 300 401 clause 14.6.1). */
export const FREQ_INTERLEAVER = buildInterleaver();

/** FFT bin (k mod 2048) of the n-th bit pair. */
export const CARRIER_BIN = Int32Array.from(FREQ_INTERLEAVER, (k) => (k + TU) % TU);

const H = [
	[0, 2, 0, 0, 0, 0, 1, 1, 2, 0, 0, 0, 2, 2, 1, 1, 0, 2, 0, 0, 0, 0, 1, 1, 2, 0, 0, 0, 2, 2, 1, 1],
	[0, 3, 2, 3, 0, 1, 3, 0, 2, 1, 2, 3, 2, 3, 3, 0, 0, 3, 2, 3, 0, 1, 3, 0, 2, 1, 2, 3, 2, 3, 3, 0],
	[0, 0, 0, 2, 0, 2, 1, 3, 2, 2, 0, 2, 2, 0, 1, 3, 0, 0, 0, 2, 0, 2, 1, 3, 2, 2, 0, 2, 2, 0, 1, 3],
	[0, 1, 2, 1, 0, 3, 3, 2, 2, 3, 2, 1, 2, 1, 3, 2, 0, 1, 2, 1, 0, 3, 3, 2, 2, 3, 2, 1, 2, 1, 3, 2],
];
// EN 300 401 table 23: kmin, kmax, i, n
// prettier-ignore
const ROWS = [
	[-768, -737, 0, 1], [-736, -705, 1, 2], [-704, -673, 2, 0], [-672, -641, 3, 1], [-640, -609, 0, 3], [-608, -577, 1, 2],
	[-576, -545, 2, 2], [-544, -513, 3, 3], [-512, -481, 0, 2], [-480, -449, 1, 1], [-448, -417, 2, 2], [-416, -385, 3, 3],
	[-384, -353, 0, 1], [-352, -321, 1, 2], [-320, -289, 2, 3], [-288, -257, 3, 3], [-256, -225, 0, 2], [-224, -193, 1, 2],
	[-192, -161, 2, 2], [-160, -129, 3, 1], [-128, -97, 0, 1], [-96, -65, 1, 3], [-64, -33, 2, 1], [-32, -1, 3, 2],
	[1, 32, 0, 3], [33, 64, 3, 1], [65, 96, 2, 1], [97, 128, 1, 1], [129, 160, 0, 2], [161, 192, 3, 2],
	[193, 224, 2, 1], [225, 256, 1, 0], [257, 288, 0, 2], [289, 320, 3, 2], [321, 352, 2, 3], [353, 384, 1, 3],
	[385, 416, 0, 0], [417, 448, 3, 2], [449, 480, 2, 1], [481, 512, 1, 3], [513, 544, 0, 3], [545, 576, 3, 3],
	[577, 608, 2, 3], [609, 640, 1, 0], [641, 672, 0, 3], [673, 704, 3, 0], [705, 736, 2, 1], [737, 768, 1, 1],
];

function buildReference(): { re: Float64Array; im: Float64Array } {
	const re = new Float64Array(TU);
	const im = new Float64Array(TU);
	const rotRe = [1, 0, -1, 0];
	const rotIm = [0, 1, 0, -1];
	for (const [kmin, kmax, i, n] of ROWS) {
		for (let k = kmin; k <= kmax; k++) {
			const p = (H[i][k - kmin] + n) & 3;
			re[(k + TU) % TU] = rotRe[p];
			im[(k + TU) % TU] = rotIm[p];
		}
	}
	return { re, im };
}

/** Frequency-domain phase reference symbol, TU bins (bin = k mod TU). */
export const PHASE_REF = buildReference();

/** Its complex conjugate (the receiver correlates with it). */
export const PHASE_REF_CONJ = { re: PHASE_REF.re, im: PHASE_REF.im.map((v) => -v) };
