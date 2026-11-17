// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/hfdl/hfdl_rx.cpp (HfdlReceiver::Impl::burst, equaliser mode 2:
// the symbol timing fit over the probes and the gain interpolated between them), https://github.com/adswill/OnAir;
// see third_party/onair. Changes: the gain between two probes is found by walking forward (the symbols come in order)
// instead of searching from the first probe each time, which gives the same gains.
//
// Known symbols only, for weak bursts: decisions on a signal at about 0 dB per symbol are wrong too often for the
// decision-directed loops to hold the phase; the 15-symbol probes (a third of the burst) are always right. The complex
// gain is measured on the last 9 T probes of the preamble and on the probe after every block, and interpolated linearly
// across the data between them. A sample clock off by 100 ppm slips a symbol in 10000 and a long burst a quarter of one:
// the probes of every block give the timing offset (correlation at -1 / 0 / +1 half symbols, parabola), a weighted line
// through them gives offset and drift, and the symbols are taken again at the corrected times.

import type { HfdlSamples } from './front';
import { burstSamples } from './equalizer';
import { BLOCK_LEN, DATA_LEN, PRE_LEN, T_LEN, T_SEQ, TRAIN, hfdlRate, preambleRef } from './phy';
import type { HfdlBurstSamples, HfdlEqualised, HfdlPreamble } from './types';

/** The timing offset and drift (symbols, symbols per symbol) the probes give; undefined when they give none. */
function timingFit(u: HfdlBurstSamples, blocks: number): { off: number; slope: number } | undefined {
	let sw = 0;
	let sx = 0;
	let sy = 0;
	let sxx = 0;
	let sxy = 0;
	const c = new Float64Array(3);
	for (let b = 0; b < blocks; b++) {
		const i0 = PRE_LEN + b * BLOCK_LEN + DATA_LEN;
		for (let d = -1; d <= 1; d++) {
			let ar = 0;
			let ai = 0;
			for (let q = 0; q < T_LEN; q++) {
				const k = u.uoff + 2 * (i0 + q) + d;
				ar += u.re[k] * T_SEQ[q];
				ai += u.im[k] * T_SEQ[q];
			}
			c[d + 1] = Math.hypot(ar, ai);
		}
		const den = c[0] - 2 * c[1] + c[2];
		if (den >= 0 || c[1] < c[0] || c[1] < c[2]) continue;
		const tau = (0.25 * (c[0] - c[2])) / den;
		const w = c[1] * c[1];
		const x = i0 + 0.5 * T_LEN;
		sw += w;
		sx += w * x;
		sy += w * tau;
		sxx += w * x * x;
		sxy += w * x * tau;
	}
	const dd = sw * sxx - sx * sx;
	if (!(sw > 0 && dd > 1e-9 * sw * sw)) return undefined;
	const slope = (sw * sxy - sx * sy) / dd;
	const off = (sy - slope * sx) / sw;
	return Math.abs(slope) < 4e-4 && Math.abs(off) < 0.5 ? { off, slope } : undefined;
}

/** The gains on the preamble's training blocks and on the probe after every block, and the symbol at their centres. */
function probeGains(u: HfdlBurstSamples, ref: Float32Array, blocks: number): { gr: Float64Array; gi: Float64Array; ctr: Float64Array } {
	const gr = new Float64Array(blocks + 1);
	const gi = new Float64Array(blocks + 1);
	const ctr = new Float64Array(blocks + 1);
	const at = (i: number) => u.uoff + 2 * i;
	const t0 = PRE_LEN - TRAIN * T_LEN;
	for (let i = t0; i < PRE_LEN; i++) {
		gr[0] += u.re[at(i)] * ref[i];
		gi[0] += u.im[at(i)] * ref[i];
	}
	gr[0] /= PRE_LEN - t0;
	gi[0] /= PRE_LEN - t0;
	ctr[0] = 0.5 * (t0 + PRE_LEN);
	for (let b = 0; b < blocks; b++) {
		const i0 = PRE_LEN + b * BLOCK_LEN + DATA_LEN;
		for (let q = 0; q < T_LEN; q++) {
			gr[b + 1] += u.re[at(i0 + q)] * T_SEQ[q];
			gi[b + 1] += u.im[at(i0 + q)] * T_SEQ[q];
		}
		gr[b + 1] /= T_LEN;
		gi[b + 1] /= T_LEN;
		ctr[b + 1] = i0 + 0.5 * T_LEN;
	}
	return { gr, gi, ctr };
}

/** Mode 2: known symbols only. The burst samples may be taken again at corrected times. */
export function pilotsOnly(x: HfdlSamples, pre: HfdlPreamble, first: HfdlBurstSamples, scr: Int8Array): HfdlEqualised {
	const rate = hfdlRate(pre.m1);
	const nb = rate.blocks;
	const fit = timingFit(first, nb);
	const u = fit ? burstSamples(x, pre, fit.off, fit.slope) : first;
	const { gr, gi, ctr } = probeGains(u, preambleRef(pre.m1), nb);
	let k2 = 0;
	/** The symbol i equalised by the gain interpolated at i, into out. */
	const eq = (i: number, out: Float64Array): void => {
		while (k2 + 2 < gr.length && i > ctr[k2 + 1]) k2++;
		const f = (i - ctr[k2]) / (ctr[k2 + 1] - ctr[k2]);
		const hr = gr[k2] * (1 - f) + gr[k2 + 1] * f;
		const hi = gi[k2] * (1 - f) + gi[k2 + 1] * f;
		const n = hr * hr + hi * hi + 1e-12;
		const sr = u.re[u.uoff + 2 * i];
		const si = u.im[u.uoff + 2 * i];
		out[0] = (sr * hr + si * hi) / n;
		out[1] = (si * hr - sr * hi) / n;
	};
	const nd = nb * DATA_LEN;
	const re = new Float32Array(nd);
	const im = new Float32Array(nd);
	const probeErr = new Float64Array(nb + 1);
	const z = new Float64Array(2);
	let eAll = 0;
	let di = 0;
	for (let b = 0; b < nb; b++) {
		const i0 = PRE_LEN + b * BLOCK_LEN;
		for (let q = 0; q < DATA_LEN; q++, di++) {
			eq(i0 + q, z);
			re[di] = z[0] * scr[di];
			im[di] = z[1] * scr[di];
		}
		let e = 0;
		for (let q = 0; q < T_LEN; q++) {
			eq(i0 + DATA_LEN + q, z);
			e += (z[0] - T_SEQ[q]) ** 2 + z[1] ** 2;
		}
		probeErr[b + 1] = e / T_LEN;
		eAll += e;
	}
	probeErr[0] = nb > 0 ? probeErr[1] : 1;
	return { re, im, probeErr, sig2: Math.max(1e-4, eAll / Math.max(1, nb * T_LEN)) };
}
