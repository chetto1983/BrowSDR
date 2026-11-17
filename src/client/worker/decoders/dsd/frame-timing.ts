// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/p25/p25_rx.cpp (P25Receiver::Impl: lsFit, nearestLevel, the
// timing search of frame(): "the offset and slope with the cleanest decisions", and the decision-directed refit) and
// core/src/nxdn/nxdn_rx.cpp (decodeFrame: the same refit), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: OnAir samples its own symbol filter at its sync's timing; here a frame found on BrowSDR's 4800 symbols/s
// chain is re-sampled from the chain's RRC filter output: the clock recovery's symbol times are fitted with a line
// (smoothing the loop's wander and a clock error), then the shift and slope with the cleanest decisions are searched.
import type { DsdChain } from './types';

/** v = g * s + d */
export function lsFit(v: ArrayLike<number>, s: ArrayLike<number>, n: number): { g: number; d: number } {
	let ms = 0;
	let mv = 0;
	for (let i = 0; i < n; i++) {
		ms += s[i];
		mv += v[i];
	}
	ms /= n;
	mv /= n;
	let c = 0;
	let a = 0;
	for (let i = 0; i < n; i++) {
		c += (s[i] - ms) * (v[i] - mv);
		a += (s[i] - ms) * (s[i] - ms);
	}
	const g = a > 0 ? c / a : 0;
	return { g, d: mv - g * ms };
}

export function nearestLevel(v: number): number {
	return v >= 2 ? 3 : v >= 0 ? 1 : v >= -2 ? -1 : -3;
}

/**
 * The n symbols of a frame of the 4800 symbols/s chain from dibit index first, in level units (about +-1 and +-3, the
 * polarity of the known symbols), re-sampled at the timing with the cleanest decisions, and the level (negative: the
 * signal is inverted). known: the levels of the frame's first symbols (its sync word). Null when the chain's times do
 * not cover the frame.
 */
export function frameLevels(chain: DsdChain, first: number, n: number, known: ArrayLike<number>): { x: Float32Array; g: number } | null {
	// The clock recovery's symbol times, a least-squares line over the frame.
	let sk = 0;
	let st = 0;
	let skk = 0;
	let skt = 0;
	const t0 = chain.times[first & chain.mask];
	for (let k = 0; k < n; k++) {
		const t = chain.times[(first + k) & chain.mask] - t0;
		sk += k;
		st += t;
		skk += k * k;
		skt += k * t;
	}
	const slope = (n * skt - sk * st) / (n * skk - sk * sk);
	const base = t0 + (st - slope * sk) / n;
	if (!(slope > 5 && slope < 15) || chain.times[(first + n - 1) & chain.mask] < chain.times[first & chain.mask]) return null;
	const mask = chain.samples.length - 1;
	const at = (t: number) => {
		const i = Math.floor(t);
		const f = t - i;
		return chain.samples[i & mask] * (1 - f) + chain.samples[(i + 1) & mask] * f;
	};
	const value = (k: number, shift: number, sl: number) => at(base + shift + k * (slope + sl));
	const m = known.length;
	const sync = (shift: number, sl: number) =>
		lsFit(
			Float32Array.from({ length: m }, (_, k) => value(k, shift, sl)),
			known,
			m,
		);
	let { g, d } = sync(0, 0);
	if (!g) return null;
	// The offset and slope with the cleanest decisions (OnAir: a quarter sample, 0.0002 samples per symbol).
	let best = { e: Infinity, shift: 0, sl: 0 };
	for (let j = -4; j <= 4; j++)
		for (let q = -8; q <= 8; q++) {
			const shift = j * 0.25;
			const sl = q * 0.0002;
			let e = 0;
			for (let k = 0; k < n; k += 3) {
				const x = (value(k, shift, sl) - d) / g;
				e += (x - nearestLevel(x)) ** 2;
			}
			if (e < best.e) best = { e, shift, sl };
		}
	const v = Float32Array.from({ length: n }, (_, k) => value(k, best.shift, best.sl));
	({ g, d } = sync(best.shift, best.sl));
	const lv = Int8Array.from({ length: n }, (_, k) => (k < m ? known[k] : nearestLevel((v[k] - d) / g)));
	const fit = lsFit(v, lv, n);
	if (fit.g * g > 0 && Math.abs(fit.g) > 0.5 * Math.abs(g) && Math.abs(fit.g) < 2 * Math.abs(g)) ({ g, d } = fit);
	return { x: v.map((x) => (x - d) / g), g };
}
