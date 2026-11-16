// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/hfdig/hfdig_ftx.cpp (spec, ftxTones, addWaveIQ: the timing of
// the modes, the FT8 / FT4 tone sequences of WSJT-X's genft8.f90 / genft4.f90 and the GFSK waveform),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: only FT8, FT4 and WSPR; JavaScript has no erf, so
// the Gaussian pulse uses the erfc approximation of Numerical Recipes (fractional error below 1.2e-7); addWaveIQ takes
// the pulses of each sample position in a symbol from the first symbol and turns the phase as a phasor (a series for
// the small step of the deviation) instead of a cos and a sin per sample: the same waveform to about 1e-8.

import { encode174 } from './ldpc';
import { FT4_COSTAS, FT4_GRAY, FT4_RVEC, FT8_COSTAS, FT8_GRAY, LDPC_N } from './tables';
import type { FtxMode, FtxSpec } from './types';

export const FT8: FtxMode = 0;
export const FT4: FtxMode = 1;
export const WSPR: FtxMode = 3;

const SPECS: Record<FtxMode, FtxSpec> = {
	0: { name: 'FT8', period: 15, t0: 0.5, symSec: 0.16, spacing: 6.25, nn: 79, tones: 8, bt: 2 },
	1: { name: 'FT4', period: 7.5, t0: 0.5, symSec: 0.048, spacing: 12000 / 576, nn: 105, tones: 4, bt: 1 },
	3: { name: 'WSPR', period: 120, t0: 1, symSec: 8192 / 12000, spacing: 12000 / 8192, nn: 162, tones: 4, bt: 0 },
};

export const spec = (mode: FtxMode): FtxSpec => SPECS[mode];

/** erf(x) from erfc of Numerical Recipes (Chebyshev fit, fractional error below 1.2e-7). */
export function erf(x: number): number {
	const z = Math.abs(x);
	const t = 1 / (1 + 0.5 * z);
	const r =
		t *
		Math.exp(
			-z * z -
				1.26551223 +
				t *
					(1.00002368 +
						t *
							(0.37409196 +
								t *
									(0.09678418 +
										t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
		);
	return x >= 0 ? 1 - r : r - 1;
}

/** The GFSK frequency pulse of bandwidth-time product bt at x symbols from its centre. */
export function gfskPulse(bt: number, x: number): number {
	const c = Math.PI * Math.sqrt(2 / Math.log(2));
	return 0.5 * (erf(c * bt * (x + 0.5)) - erf(c * bt * (x - 0.5)));
}

/** FT8 79 tones, FT4 103 tones (without the ramp symbols) from 77 message bits. */
export function ftxTones(mode: FtxMode, b77: ArrayLike<number>): number[] {
	const m = Uint8Array.from({ length: 77 }, (_, i) => b77[i] & 1);
	const cw = new Uint8Array(LDPC_N);
	if (mode === FT8) {
		encode174(m, cw);
		const t = new Array<number>(79).fill(0);
		for (let k = 0; k < 7; k++) t[k] = t[36 + k] = t[72 + k] = FT8_COSTAS[k];
		for (let j = 0; j < 58; j++) t[j < 29 ? 7 + j : 43 + j - 29] = FT8_GRAY[cw[3 * j] * 4 + cw[3 * j + 1] * 2 + cw[3 * j + 2]];
		return t;
	}
	for (let i = 0; i < 77; i++) m[i] ^= FT4_RVEC[i];
	encode174(m, cw);
	const t = new Array<number>(103).fill(0);
	for (let k = 0; k < 4; k++)
		[t[k], t[33 + k], t[66 + k], t[99 + k]] = [FT4_COSTAS[0][k], FT4_COSTAS[1][k], FT4_COSTAS[2][k], FT4_COSTAS[3][k]];
	for (let j = 0; j < 87; j++) t[j < 29 ? 4 + j : j < 58 ? 37 + j - 29 : 70 + j - 58] = FT4_GRAY[cw[2 * j] * 2 + cw[2 * j + 1]];
	return t;
}

/** The envelope at u symbols into a transmission of `total` symbols: FT8 ramps over an eighth of a symbol, FT4 over its ramp symbols. */
export function envelope(mode: FtxMode, u: number, total: number): number {
	if (mode === FT8) {
		const r = 1 / 8;
		if (u < r) return 0.5 * (1 - Math.cos((Math.PI * u) / r));
		if (u > total - r) return 0.5 * (1 - Math.cos((Math.PI * (total - u)) / r));
	} else if (mode === FT4) {
		if (u < 1) return 0.5 * (1 - Math.cos(Math.PI * u));
		if (u > total - 1) return 0.5 * (1 - Math.cos(Math.PI * (total - u)));
	}
	return 1;
}

/** Ramp symbols before (and after) the tones of a mode. */
export const leadOf = (mode: FtxMode): number => (mode === FT4 ? 1 : 0);

const TAB = 1 << 13;
const LIM = 3;
const pulseTables = new Map<number, Float64Array>();

/** The Gaussian pulse of a mode as a table over +-3 symbols, read with linear interpolation. */
function pulseTable(bt: number): Float64Array {
	let t = pulseTables.get(bt);
	if (!t) {
		t = Float64Array.from({ length: TAB + 2 }, (_, i) => gfskPulse(bt, -LIM + (2 * LIM * i) / TAB));
		pulseTables.set(bt, t);
	}
	return t;
}

/**
 * The Gaussian pulse of the five symbols around each of the `sps` samples of a symbol, the first sample `u0` symbols
 * into the transmission: p[j * 5 + d] for symbol floor(u_j) - 2 + d, k[j] = floor(u_j) - floor(u0) at sample j.
 */
function pulsesPerSample(bt: number, u0: number, invTr: number, sps: number): { p: Float64Array; k: Int32Array } {
	const tab = pulseTable(bt);
	const p = new Float64Array(sps * 5);
	const k = new Int32Array(sps);
	const base = Math.floor(u0);
	for (let j = 0; j < sps; j++) {
		const u = u0 + j * invTr;
		const k0 = Math.floor(u);
		k[j] = k0 - base;
		for (let d = 0; d < 5; d++) {
			const q = (u - (k0 - 2 + d) - 0.5 + LIM) * (TAB / (2 * LIM));
			const i = Math.floor(q);
			p[j * 5 + d] = tab[i] + (q - i) * (tab[i + 1] - tab[i]);
		}
	}
	return { p, k };
}

/**
 * The waveform of a transmission as cos and sin of its phase, amplitude 1 with the ramps, added to re / im from sample
 * `start` (may be negative or past the end): tone 0 at f0 Hz; mirrored: the tones go down from f0.
 */
export function addWaveIQ(
	mode: FtxMode,
	tones: number[],
	f0: number,
	rate: number,
	start: number,
	mirrored: boolean,
	re: Float64Array,
	im: Float64Array,
): void {
	const s = spec(mode);
	const lead = leadOf(mode);
	const nsym = tones.length;
	const total = nsym + 2 * lead;
	const sg = mirrored ? -1 : 1;
	const tv = Float64Array.from({ length: nsym + 8 }, (_, i) => tones[Math.max(0, Math.min(nsym - 1, i - 2 - lead))]);
	const n0 = Math.max(0, Math.ceil(start));
	const n1 = Math.min(re.length, Math.floor(start + total * s.symSec * rate));
	const invTr = 1 / (s.symSec * rate);
	const k2 = (2 * Math.PI) / rate;
	// the pulses of the five neighbouring symbols at each sample of a symbol (a symbol is a whole number of samples)
	const sps = Math.round(s.symSec * rate);
	const pulses = s.bt > 0 ? pulsesPerSample(s.bt, (n0 - start) * invTr, invTr, sps) : null;
	const base = Math.floor((n0 - start) * invTr);
	// the phase as a phasor: turned by the carrier's step and the deviation's (small) step, a fourth-order series
	const [c0, s0] = [Math.cos(k2 * f0), Math.sin(k2 * f0)];
	let pr = 1;
	let pi = 0;
	// sample n = n0 + r sps + jj
	for (let n = n0, jj = 0, r = 0; n < n1; n++) {
		const u = (n - start) * invTr;
		let dev = 0;
		if (!pulses) dev = tv[Math.floor(u) + 2];
		else {
			const kb = base + pulses.k[jj] + r;
			for (let d = 0; d < 5; d++) dev += tv[kb + d] * pulses.p[jj * 5 + d];
		}
		if (++jj === sps) [jj, r] = [0, r + 1];
		const env = envelope(mode, u, total);
		re[n] += env * pr;
		im[n] += env * pi;
		const d = k2 * sg * s.spacing * dev;
		const d2 = d * d;
		const cd = 1 - d2 / 2 + (d2 * d2) / 24;
		const sd = d * (1 - d2 / 6 + (d2 * d2) / 120);
		const cr = c0 * cd - s0 * sd;
		const ci = c0 * sd + s0 * cd;
		const npr = pr * cr - pi * ci;
		pi = pr * ci + pi * cr;
		pr = npr;
		if ((n & 1023) === 0) {
			const g = 1 / Math.hypot(pr, pi);
			pr *= g;
			pi *= g;
		}
	}
}
