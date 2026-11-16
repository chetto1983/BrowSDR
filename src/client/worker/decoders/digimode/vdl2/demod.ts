// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/vdl2/vdl2_rx.cpp (lowpass, interp, demod),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: demod works on a segment the caller cut and is
// split into its steps (fine timing, training fit, symbol loop); complex values are written out as pairs.
//
// D8PSK symbols of one burst: the timing refined on the 16 training symbols, then a phase locked loop (coherent
// decisions, differential decoding through the Gray map) and a Gardner timing loop over the whole burst.

import { GRAY_BITS, PREAMBLE_PHASE, PREAMBLE_SYMS, VDL2_SYMBOL_RATE } from './bits';
import type { Vdl2Demod } from './types';

/** Windowed-sinc low-pass (Blackman), unity gain at 0 Hz; cutoff as a fraction of the sample rate. */
export function lowpass(taps: number, cutoff: number): Float64Array {
	const n = taps % 2 ? taps : taps + 1;
	const h = new Float64Array(n);
	const m = n >> 1;
	let sum = 0;
	for (let i = 0; i < n; i++) {
		const k = i - m;
		const s = k === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * k) / (Math.PI * k);
		const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1));
		h[i] = s * w;
		sum += s * w;
	}
	return h.map((v) => v / sum);
}

/** C's lround: halves away from zero. */
export const lround = (x: number): number => (x < 0 ? -Math.round(-x) : Math.round(x));

/** Cubic Lagrange interpolation of the complex samples `y` (interleaved) at the fractional index `t`. */
function interp(y: Float64Array, t: number): [number, number] {
	const i = Math.floor(t);
	const f = t - i;
	if (i < 1 || i + 2 >= y.length >> 1) return [0, 0];
	const c = [(-f * (f - 1) * (f - 2)) / 6, ((f + 1) * (f - 1) * (f - 2)) / 2, (-(f + 1) * f * (f - 2)) / 2, ((f + 1) * f * (f - 1)) / 6];
	let re = 0;
	let im = 0;
	for (let k = 0; k < 4; k++) {
		re += y[2 * (i - 1 + k)] * c[k];
		im += y[2 * (i - 1 + k) + 1] * c[k];
	}
	return [re, im];
}

/** The training symbols' conjugate phases: multiplying by these turns the sequence into a constant. */
const REF = PREAMBLE_PHASE.map((p) => [Math.cos((p * Math.PI) / 4), -Math.sin((p * Math.PI) / 4)]);

/** Timing (fractional sample index of the first training symbol) that best fits the training sequence, within 3 samples of `t0`. */
function fineTiming(y: Float64Array, t0: number, T: number): number {
	let bestT = t0;
	let bestV = -1;
	for (let d = -3.0; d <= 3.0001; d += 0.125) {
		let ar = 0;
		let ai = 0;
		for (let q = 0; q < PREAMBLE_SYMS; q++) {
			const [vr, vi] = interp(y, t0 + d + q * T);
			ar += vr * REF[q][0] - vi * REF[q][1];
			ai += vr * REF[q][1] + vi * REF[q][0];
		}
		const v = ar * ar + ai * ai;
		if (v > bestV) {
			bestV = v;
			bestT = t0 + d;
		}
	}
	return bestT;
}

/** The training sequence at the found timing: the rotation per symbol (residual carrier offset), the phase and amplitude at the first symbol. */
function trainingFit(y: Float64Array, t: number, T: number): { dr: number; phase: number; amp: number } | undefined {
	const z: Array<[number, number]> = [];
	let e = 0;
	for (let q = 0; q < PREAMBLE_SYMS; q++) {
		const [vr, vi] = interp(y, t + q * T);
		const zr = vr * REF[q][0] - vi * REF[q][1];
		const zi = vr * REF[q][1] + vi * REF[q][0];
		z.push([zr, zi]);
		e += zr * zr + zi * zi;
	}
	let dRe = 0;
	let dIm = 0;
	for (let q = 0; q + 1 < PREAMBLE_SYMS; q++) {
		dRe += z[q + 1][0] * z[q][0] + z[q + 1][1] * z[q][1];
		dIm += z[q + 1][1] * z[q][0] - z[q + 1][0] * z[q][1];
	}
	const dr = Math.atan2(dIm, dRe);
	let pRe = 0;
	let pIm = 0;
	for (let q = 0; q < PREAMBLE_SYMS; q++) {
		const [c, s] = [Math.cos(-dr * q), Math.sin(-dr * q)];
		pRe += z[q][0] * c - z[q][1] * s;
		pIm += z[q][0] * s + z[q][1] * c;
	}
	if (Math.hypot(dRe, dIm) < 0.5 * e) return undefined;
	return { dr, phase: Math.atan2(pIm, pRe), amp: Math.hypot(pRe, pIm) / PREAMBLE_SYMS };
}

/**
 * Demodulates `nSym` symbols after the training sequence from `y` (the channel-filtered burst, carrier offset `cfo`
 * taken out, the training sequence near sample `t0`); undefined when the training sequence does not fit well enough.
 */
export function demodulate(y: Float64Array, t0: number, T: number, nSym: number, cfo: number): Vdl2Demod | undefined {
	const bestT = fineTiming(y, t0, T);
	const fit = trainingFit(y, bestT, T);
	if (!fit) return undefined;
	const { dr, amp } = fit;
	// phase locked loop and timing loop over the whole burst
	let th = fit.phase;
	let om = dr;
	let tau = bestT;
	const [ka, kb, kt] = [0.12, 0.004, 0.02];
	let prevIdx = 0;
	let sig = 0;
	let err2 = 0;
	let prevS = interp(y, tau - T);
	const bits = new Uint8Array(nSym * 3);
	const total = PREAMBLE_SYMS + nSym;
	for (let q = 0; q < total; q++) {
		const tq = tau + q * T;
		const sv = interp(y, tq);
		const rr = sv[0] * Math.cos(th) + sv[1] * Math.sin(th);
		const ri = sv[1] * Math.cos(th) - sv[0] * Math.sin(th);
		const idx = q < PREAMBLE_SYMS ? ((PREAMBLE_PHASE[q] % 8) + 8) % 8 : ((lround(Math.atan2(ri, rr) / (Math.PI / 4)) % 8) + 8) % 8;
		const [dc, ds] = [Math.cos((idx * Math.PI) / 4), Math.sin((idx * Math.PI) / 4)];
		const pe = Math.atan2(ri * dc - rr * ds, rr * dc + ri * ds);
		om += kb * pe;
		th += om + ka * pe;
		sig += rr * rr + ri * ri;
		err2 += (rr - amp * dc) ** 2 + (ri - amp * ds) ** 2;
		// Gardner timing error (normalised)
		const mid = interp(y, tq - T * 0.5);
		const ge = (prevS[0] - sv[0]) * mid[0] + (prevS[1] - sv[1]) * mid[1];
		if (q > 2) tau += Math.max(-0.05, Math.min(0.05, (kt * ge) / Math.max(1e-12, amp * amp))) * T * 0.1;
		prevS = sv;
		if (q >= PREAMBLE_SYMS) {
			const b = GRAY_BITS[(((idx - prevIdx) % 8) + 8) % 8];
			const at = 3 * (q - PREAMBLE_SYMS);
			bits[at] = (b >> 2) & 1;
			bits[at + 1] = (b >> 1) & 1;
			bits[at + 2] = b & 1;
		}
		prevIdx = idx;
	}
	return {
		bits,
		snrDb: 10 * Math.log10(Math.max(1e-12, sig) / Math.max(1e-12, err2)),
		levelDb: 10 * Math.log10(Math.max(1e-20, amp * amp)),
		cfoHz: cfo + (dr * VDL2_SYMBOL_RATE) / (2 * Math.PI),
	};
}
