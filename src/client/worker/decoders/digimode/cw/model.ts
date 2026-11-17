// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/cw/cw_decoder.cpp (FistDecoder::Impl, the sender model: the
// log-domain classes of dots, dashes and the three gaps, lpGauss with its broad tail, learnMark and learnGap, the
// windowed batch fits gmm, dashFit and fitGaps, twoMeans, relock, checkSpeed, fromBacklog, misfit; FistTune's
// defaults), https://github.com/adswill/OnAir; see third_party/onair. Changes: the model is a class of its own (the
// beam and the event handling are in beam.ts and fist.ts); numbers are doubles, not floats; the tuning knobs are
// constants.

import type { CwEv, FistClasses } from './types';

/** FistTune's shipped values. */
export const TUNE = {
	lmWeight: 0.4,
	wordWeight: 0.7,
	delay: 4,
	alphaL: 0.1,
	tailW: 0.003,
	tailMul: 3,
	tailBase: 0.15,
	alphaC: 0.04,
} as const;

export const FIST_BINS = 40;
const HIST_LO = -1.6;
const HIST_SPAN = 4.4;
const RING = 16;
const WM = 64;
const WG = 96;
const LN3 = 1.0986;
const LN7 = 1.9459;
const LN_TAIL = Math.log1p(-TUNE.tailW);
const LN_TAIL_W = Math.log(TUNE.tailW);

/** Log density: 99.7 % the class, 0.3 % a broad tail. */
export function lpGauss(x: number, mu: number, sg: number): number {
	const z = (x - mu) / sg;
	const a = -0.5 * z * z - Math.log(sg) + LN_TAIL;
	const sb = sg * TUNE.tailMul + TUNE.tailBase;
	const zb = (x - mu) / sb;
	const b = -0.5 * zb * zb - Math.log(sb) + LN_TAIL_W;
	const m = Math.max(a, b);
	return m + Math.log(Math.exp(a - m) + Math.exp(b - m));
}

const clipf = (v: number, lim: number) => (v > lim ? lim : v < -lim ? -lim : v);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Two clusters of values (a 2-means started at a quarter and three quarters of the range). */
export function twoMeans(v: ArrayLike<number>, m: number): { c1: number; c2: number; n1: number; n2: number; sig: number } {
	let [lo, hi] = [v[0], v[0]];
	for (let i = 1; i < m; i++) [lo, hi] = [Math.min(lo, v[i]), Math.max(hi, v[i])];
	let c1 = lo + 0.25 * (hi - lo);
	let c2 = lo + 0.75 * (hi - lo);
	let [n1, n2] = [0, 0];
	for (let it = 0; it < 15; it++) {
		let [s1, s2] = [0, 0];
		[n1, n2] = [0, 0];
		const mid = 0.5 * (c1 + c2);
		for (let i = 0; i < m; i++)
			if (v[i] < mid) [s1, n1] = [s1 + v[i], n1 + 1];
			else [s2, n2] = [s2 + v[i], n2 + 1];
		if (n1) c1 = s1 / n1;
		if (n2) c2 = s2 / n2;
	}
	const mid = 0.5 * (c1 + c2);
	let ss = 0;
	for (let i = 0; i < m; i++) ss += (v[i] - (v[i] < mid ? c1 : c2)) ** 2;
	return { c1, c2, n1, n2, sig: Math.sqrt(ss / Math.max(1, m - 2)) };
}

/**
 * A Gaussian mixture of K classes: fixed share priors, an outlier floor (junk, pauses), started at `init` or at
 * quantiles of the values by the priors. shared: one spread for all classes (the gaps: stops a class from collapsing
 * on a few odd values). False when the means do not come out in order.
 */
export function gmm(
	v: ArrayLike<number>,
	m0: number,
	prior: number[],
	sigFloor: number,
	shared: boolean,
	out: { mu: number[]; sg: number[]; cnt: number[] },
	init?: number[],
): boolean {
	const m = Math.min(m0, 128);
	const K = prior.length;
	const srt = Array.from({ length: m }, (_, i) => v[i]).sort((a, b) => a - b);
	const { mu, sg } = out;
	let cum = 0;
	for (let k = 0; k < K; k++) {
		mu[k] = init ? init[k] : srt[Math.min(m - 1, Math.floor((cum + 0.5 * prior[k]) * m))];
		sg[k] = 0.25;
		cum += prior[k];
	}
	const pv = new Float64Array(m * K);
	for (let it = 0; it < 25; it++) gmmStep(v, m, prior, sigFloor, shared, out, pv);
	for (let k = 1; k < K; k++) if (mu[k] < mu[k - 1] + 0.1) return false;
	return true;
}

/** One EM step of gmm. */
function gmmStep(
	v: ArrayLike<number>,
	m: number,
	prior: number[],
	sigFloor: number,
	shared: boolean,
	{ mu, sg, cnt }: { mu: number[]; sg: number[]; cnt: number[] },
	pv: Float64Array,
): void {
	const K = prior.length;
	const nk = new Array<number>(K).fill(0);
	const sm = new Array<number>(K).fill(0);
	const outl = 0.02 / 4;
	for (let i = 0; i < m; i++) {
		let tot = outl;
		for (let k = 0; k < K; k++) {
			const z = (v[i] - mu[k]) / sg[k];
			pv[i * K + k] = (prior[k] * Math.exp(-0.5 * z * z)) / sg[k] / 2.5066;
			tot += pv[i * K + k];
		}
		for (let k = 0; k < K; k++) {
			pv[i * K + k] /= tot;
			nk[k] += pv[i * K + k];
			sm[k] += pv[i * K + k] * v[i];
		}
	}
	for (let k = 0; k < K; k++) if (nk[k] >= 1.5) mu[k] = sm[k] / nk[k];
	const sq = new Array<number>(K).fill(0);
	for (let i = 0; i < m; i++) for (let k = 0; k < K; k++) sq[k] += pv[i * K + k] * (v[i] - mu[k]) ** 2;
	const pooledSq = sq.reduce((a, b) => a + b, 0);
	const pooledN = nk.reduce((a, b) => a + b, 0);
	for (let k = 0; k < K; k++) {
		if (nk[k] >= 1.5) {
			const variance = shared ? pooledSq / Math.max(1, pooledN) : sq[k] / nk[k];
			sg[k] = Math.max(sigFloor, Math.min(0.5, Math.sqrt(Math.max(0, variance))));
		}
		cnt[k] = Math.round(nk[k]);
	}
}

/**
 * Dots and dashes from a set of marks (ln), anchored on the dashes: a 2-means in linear time (the dashes carry most of
 * the key-down time), then a mixture of noise blips, dots and dashes started from that dash length gives the dot, the
 * ratio and the spreads. Without the blip class the noise in the gaps of a weak signal pulled the dot down to it.
 */
export function dashFit(
	xs: ArrayLike<number>,
	m0: number,
	minCnt: number,
): { dotL: number; ratio: number; sdd: number; sDD: number } | null {
	if (m0 < 8) return null;
	const m = Math.min(m0, 128);
	const lin = Array.from({ length: m }, (_, i) => Math.exp(xs[i])).sort((a, b) => a - b);
	let c1 = lin[Math.floor(m / 4)];
	let c2 = lin[Math.floor((m * 9) / 10)];
	let n2 = 0;
	for (let it = 0; it < 12; it++) {
		let [s1, s2, n1] = [0, 0, 0];
		n2 = 0;
		const mid = 0.5 * (c1 + c2);
		for (const v of lin)
			if (v < mid) [s1, n1] = [s1 + v, n1 + 1];
			else [s2, n2] = [s2 + v, n2 + 1];
		if (n1) c1 = s1 / n1;
		if (n2) c2 = s2 / n2;
	}
	if (n2 < minCnt || c2 < 1.8 * c1) return null;
	const d = Math.log(c2);
	const g = { mu: [0, 0, 0], sg: [0, 0, 0], cnt: [0, 0, 0] };
	if (!gmm(xs, m, [0.12, 0.5, 0.38], 0.06, false, g, [d - 2.3, d - 1.1, d])) return null;
	const { mu, sg, cnt } = g;
	if (cnt[1] < minCnt || cnt[2] < minCnt || mu[2] - mu[1] < 0.5 || mu[2] - mu[1] > 1.7) return null;
	return { dotL: mu[1], ratio: mu[2] - mu[1], sdd: sg[1], sDD: sg[2] };
}

/** The sender: the dot length L (ln ms) and the classes as offsets from it, with their spreads. */
export class FistModel implements FistClasses {
	L = 0;
	ldr = LN3;
	gi = 0;
	gc = LN3;
	gw = LN7;
	sd = 0.2;
	sD = 0.25;
	si = 0.3;
	sc = 0.3;
	sw = 0.4;
	/** Events learned from since the lock. */
	n = 0;
	fit = 1;
	fitG = 1;
	badRun = 0;
	/** > 0: the dot length is fixed (ms). */
	manualDot = 0;
	readonly ring = new Float64Array(RING);
	ringN = 0;
	/** Recent durations relative to the dot at the time: the classes are re-fitted from them. */
	private readonly wm = new Float64Array(WM);
	private readonly wg = new Float64Array(WG);
	private nwm = 0;
	private nwg = 0;
	private sinceM = 0;
	private sinceG = 0;
	batchM = false;
	batchG = false;
	readonly hMarks = new Float64Array(FIST_BINS);
	readonly hGaps = new Float64Array(FIST_BINS);

	get dot(): number {
		return Math.exp(this.L);
	}

	/** The book's classes and spreads, nothing learned. */
	start(L: number, ldr: number): void {
		Object.assign(this, { L, ldr, gi: 0, gc: LN3, gw: LN7, sd: 0.2, sD: 0.25, si: 0.3, sc: 0.3, sw: 0.4 });
		this.n = this.badRun = this.ringN = 0;
		this.fit = this.fitG = 1;
		this.forgetWindows();
		this.sinceM = this.sinceG = 0;
		this.batchM = this.batchG = false;
	}

	reset(): void {
		this.start(0, LN3);
		this.hMarks.fill(0);
		this.hGaps.fill(0);
	}

	/** The windows hold an old speed. */
	forgetWindows(): void {
		this.nwm = this.nwg = 0;
	}

	classes(): FistClasses {
		const { L, ldr, gi, gc, gw, sd, sD, si, sc, sw } = this;
		return { L, ldr, gi, gc, gw, sd, sD, si, sc, sw };
	}

	clamp(): void {
		this.ldr = clamp(this.ldr, 0.64, 1.65);
		this.gi = clamp(this.gi, -1.2, 0.7);
		this.gc = clamp(this.gc, 0.5, 2.7); // up to 15 dots: Farnsworth spacing (20 / 10 WPM sends ~12)
		this.gw = clamp(this.gw, this.gc + 0.25, 3.7); // up to 40 dots
		this.sd = clamp(this.sd, 0.07, 0.5);
		this.sD = clamp(this.sD, 0.07, 0.5);
		this.si = clamp(this.si, 0.07, 0.5);
		this.sc = clamp(this.sc, 0.07, 0.6);
		this.sw = clamp(this.sw, 0.1, 0.7);
		this.L = clamp(this.L, Math.log(20), Math.log(260));
	}

	private rate(minRate: number): number {
		return Math.max(minRate, 1 / (this.n + 3));
	}

	private static binOf(rel: number): number {
		return Math.max(0, Math.min(FIST_BINS - 1, Math.trunc(((rel - HIST_LO) / HIST_SPAN) * FIST_BINS)));
	}

	/** Log likelihood of a mark: the better of dot and dash. */
	lMark(x: number): number {
		return Math.max(lpGauss(x, this.L, this.sd) - 0.6, lpGauss(x, this.L + this.ldr, this.sD) - 0.8);
	}

	/** Log likelihood of a gap: the best of its classes. */
	lGap(x: number, intraOnly: boolean): number {
		const li = lpGauss(x, this.L + this.gi, this.si) - 0.6;
		if (intraOnly) return li;
		const lc = lpGauss(x, this.L + this.gc, this.sc) - 1.05;
		const lw = lpGauss(Math.min(x, this.L + this.gw), this.L + this.gw, this.sw) - 2.3;
		return Math.max(li, lc, lw);
	}

	/** A mark (ln ms) teaches the dot length, the ratio and the spreads. rSpike: the rate of noise in the gaps. */
	learnMark(x: number, rSpike: number): void {
		const { L, ldr, sd, sD } = this;
		for (let i = 0; i < FIST_BINS; i++) this.hMarks[i] *= 0.99;
		this.hMarks[FistModel.binOf(x - L)] += 1;
		const zd = (x - L) / sd;
		const zD = (x - L - ldr) / sD;
		const pd = (0.55 * Math.exp(-0.5 * zd * zd)) / sd;
		const pD = (0.45 * Math.exp(-0.5 * zD * zD)) / sD;
		const tot = pd + pD + 1e-12;
		const [rd, rD] = [pd / tot, pD / tot];
		const z2 = Math.min(zd * zd, zD * zD);
		this.ring[this.ringN % RING] = x; // the speed check sees every mark
		this.ringN++;
		// on a noisy signal a mark under half a dot is that noise, not a sign of a wrong model: it teaches nothing
		if (x < L - 0.7 && rSpike > 0.02) {
			this.n++;
			return;
		}
		this.fit += 0.08 * (Math.min(z2, 25) - this.fit);
		this.badRun = z2 > 9 ? this.badRun + 1 : 0;
		if (z2 > 16) {
			this.n++; // an outlier teaches nothing
			return;
		}
		const a = this.rate(TUNE.alphaC);
		const aL = this.rate(TUNE.alphaL);
		const [dd, dD] = [x - L, x - L - ldr];
		if (this.manualDot <= 0) this.L += clipf(aL * (rd * dd + 0.35 * rD * dD), 0.25);
		this.ldr += clipf(a * rD * dD, 0.2);
		if (!this.batchM) {
			this.sd = Math.sqrt(Math.max(0.0025, sd * sd + a * rd * (dd * dd - sd * sd)));
			this.sD = Math.sqrt(Math.max(0.0025, sD * sD + a * rD * (dD * dD - sD * sD)));
		}
		this.n++;
		if (this.nwm >= WM) {
			this.wm.copyWithin(0, 1);
			this.nwm = WM - 1;
		}
		this.wm[this.nwm++] = x - this.L;
		if (++this.sinceM >= 6 && this.nwm >= 16) {
			this.sinceM = 0;
			this.batchMarks();
		}
		this.clamp();
	}

	private batchMarks(): void {
		const f = dashFit(this.wm, this.nwm, 3);
		if (!f) return;
		if (this.manualDot <= 0) {
			this.L += f.dotL;
			for (let i = 0; i < this.nwm; i++) this.wm[i] -= f.dotL;
		}
		this.ldr = 0.5 * this.ldr + 0.5 * f.ratio;
		this.sd = 0.5 * this.sd + 0.5 * f.sdd;
		this.sD = 0.5 * this.sD + 0.5 * f.sDD;
		this.batchM = true;
	}

	/**
	 * The three gap classes from a window of gaps (ln, relative to the dot), started from the data: the shortest
	 * quarter gives the gap inside a character, the median of the longer ones the character gap, their top the word gap.
	 * A fit with more word gaps than character gaps is not Morse spacing and is not taken. minCnt: the fewest gaps a
	 * class needs.
	 */
	fitGaps(v: ArrayLike<number>, m0: number, w: number, minCnt = 4): boolean {
		if (m0 < 4 * minCnt) return false;
		const m = Math.min(m0, 128);
		const srt = Array.from({ length: m }, (_, i) => v[i]).sort((a, b) => a - b);
		const init0 = srt[Math.floor(m / 4)];
		const rest = srt.filter((x) => x > init0 + 0.55);
		const nr = rest.length;
		if (nr < minCnt) return false;
		const init1 = rest[Math.floor(nr / 2)]; // most of the longer gaps end a character
		const init2 = Math.max(init1 + 0.6, rest[Math.min(nr - 1, Math.floor(0.92 * nr))]);
		const g = { mu: [0, 0, 0], sg: [0, 0, 0], cnt: [0, 0, 0] };
		const conv = gmm(v, m, [0.58, 0.34, 0.08], 0.07, true, g, [init0, init1, init2]);
		const { mu, sg, cnt } = g;
		if (!conv || cnt[0] < minCnt || cnt[1] < minCnt || mu[1] - mu[0] < 0.45 || cnt[1] + 1 < cnt[2]) return false;
		this.gi += w * (mu[0] - this.gi);
		this.gc += w * (mu[1] - this.gc);
		this.si += w * (sg[0] - this.si);
		this.sc += w * (sg[1] - this.sc);
		if (mu[2] - mu[1] > 0.35 && cnt[2] >= 2) {
			this.gw += w * (mu[2] - this.gw);
			this.sw += w * (sg[2] - this.sw);
		} else this.gw = Math.max(this.gw, this.gc + 0.6);
		return true;
	}

	/** A gap (ln ms) teaches the gap classes. */
	learnGap(x: number): void {
		const { L, gi, gc, gw, si, sc, sw } = this;
		for (let i = 0; i < FIST_BINS; i++) this.hGaps[i] *= 0.99;
		this.hGaps[FistModel.binOf(x - L)] += 1;
		if (x - L > 3.4) return; // a pause between transmissions teaches nothing
		const [zi, zc, zw] = [(x - L - gi) / si, (x - L - gc) / sc, (x - L - gw) / sw];
		const pi = (0.55 * Math.exp(-0.5 * zi * zi)) / si;
		const pc = (0.35 * Math.exp(-0.5 * zc * zc)) / sc;
		let pw = (0.1 * Math.exp(-0.5 * zw * zw)) / sw;
		if (x - L > gw) pw = Math.max(pw, 0.1 / sw); // longer than the word gap: a word gap
		const tot = pi + pc + pw + 1e-12;
		const zz = Math.min(25, zi * zi, zc * zc, x - L > gw ? 0 : zw * zw);
		this.fitG += 0.08 * (zz - this.fitG);
		const a = this.rate(TUNE.alphaC);
		const [di, dc, dw] = [x - L - gi, x - L - gc, x - L - gw];
		if (!this.batchG) {
			const [ri, rc, rw] = [pi / tot, pc / tot, pw / tot];
			this.gi += clipf(a * ri * di, 0.2);
			this.gc += clipf(a * rc * dc, 0.2);
			this.gw += clipf(a * rw * dw, 0.3);
			this.si = Math.sqrt(Math.max(0.0025, si * si + a * ri * (di * di - si * si)));
			this.sc = Math.sqrt(Math.max(0.0025, sc * sc + a * rc * (dc * dc - sc * sc)));
			this.sw = Math.sqrt(Math.max(0.01, sw * sw + a * rw * (dw * dw - sw * sw)));
		}
		if (this.nwg >= WG) {
			this.wg.copyWithin(0, 1);
			this.nwg = WG - 1;
		}
		this.wg[this.nwg++] = x - this.L;
		if (++this.sinceG >= 6 && this.nwg >= 24) {
			this.sinceG = 0;
			if (this.fitGaps(this.wg, this.nwg, 0.5)) this.batchG = true;
		}
		this.clamp();
	}

	/** The last `m` marks of the ring. */
	private lastMarks(m: number): number[] {
		return Array.from({ length: m }, (_, i) => this.ring[(this.ringN - m + i) % RING]);
	}

	/** A run of marks the model cannot explain: the speed changed. The dot length from the last marks. */
	relock(): void {
		const m = Math.min(this.ringN, RING);
		if (m < 10) return;
		const v = this.lastMarks(m);
		const { c1, c2, n1, n2, sig } = twoMeans(v, m);
		if (c2 - c1 >= 0.5 && sig <= 0.5 && n1 >= 2 && n2 >= 2) {
			if (this.manualDot <= 0) this.L = c1;
			this.ldr = clamp(c2 - c1, 0.64, 1.65);
		} else {
			const mean = v.reduce((a, b) => a + b, 0) / m;
			const sdv = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / m);
			if (sdv > 0.35) return;
			if (this.manualDot <= 0) this.L = Math.abs(mean - this.L - this.ldr) < Math.abs(mean - this.L) ? mean - this.ldr : mean;
		}
		this.n = Math.min(this.n, 3);
		this.forgetWindows();
		this.badRun = 0;
		this.fit = 1;
		this.clamp();
	}

	/**
	 * Is the recent run of marks better explained by another speed? (A change of speed by a factor the classes cannot
	 * follow: slower dots look like dashes, and the model happily reads them so.)
	 */
	checkSpeed(): void {
		if (this.manualDot > 0) return;
		const v = this.lastMarks(RING);
		const { c1, c2, n1, n2, sig } = twoMeans(v, RING);
		if (c2 - c1 < 0.5 || n1 < 3 || n2 < 3 || sig > 0.4 || Math.abs(c1 - this.L) < 0.25) return;
		const nr = clamp(c2 - c1, 0.64, 1.65);
		let [cur, nw] = [0, 0];
		for (const x of v) {
			const [a, b] = [(x - this.L) / this.sd, (x - this.L - this.ldr) / this.sD];
			cur += Math.min(25, a * a, b * b);
			const [c, d] = [(x - c1) / this.sd, (x - c1 - nr) / this.sD];
			nw += Math.min(25, c * c, d * d);
		}
		if (nw > 0.5 * cur) return;
		this.L = c1;
		this.ldr = nr;
		this.n = Math.min(this.n, 3);
		this.forgetWindows();
		this.badRun = 0;
		this.fit = 1;
		this.clamp();
	}

	/** The first estimate of the classes from what was heard before the lock: marks in two clusters, gaps in three. */
	fromBacklog(xs: number[], back: CwEv[], from: number): void {
		const m = xs.length;
		const f = dashFit(xs, m, 2);
		if (f) {
			if (this.manualDot <= 0) this.L = f.dotL;
			this.ldr = clamp(f.ratio, 0.64, 1.65);
			this.sd = clamp(f.sdd, 0.1, 0.4);
			this.sD = clamp(f.sDD, 0.1, 0.4);
		} else if (m >= 8) {
			const { c1, c2, n1, n2 } = twoMeans(xs, m);
			if (c2 - c1 >= 0.52 && n1 >= 2 && n2 >= 2) {
				const mid = 0.5 * (c1 + c2);
				let [s1, s2] = [0, 0];
				for (const x of xs)
					if (x < mid) s1 += (x - c1) ** 2;
					else s2 += (x - c2) ** 2;
				if (this.manualDot <= 0) this.L = c1;
				this.ldr = clamp(c2 - c1, 0.64, 1.65);
				this.sd = clamp(Math.sqrt(s1 / n1), 0.1, 0.4);
				this.sD = clamp(Math.sqrt(s2 / n2), 0.1, 0.4);
			}
		}
		// the gap classes too, so a first transmission with wide spacing (Farnsworth) is not read as one letter a word
		const g: number[] = [];
		for (let i = Math.max(1, from); i < back.length; i++)
			if (!back[i].on && back[i].ms >= 10 && back[i - 1].on && back[i - 1].ms >= 18) {
				const r = Math.log(back[i].ms) - this.L;
				if (r < 3.4) g.push(r);
			}
		this.fitGaps(g, g.length, 1, 2);
		this.clamp();
	}

	/** How badly a dot length explains marks and gaps (ln ms). */
	misfit(l: number, xs: number[], gs: number[]): number {
		let e = 0;
		for (const x of xs) e += Math.min(25, ((x - l) / this.sd) ** 2, ((x - l - this.ldr) / this.sD) ** 2);
		for (const g of gs) {
			const c = g > l + this.gw ? 0 : (g - l - this.gw) / this.sw;
			e += Math.min(25, ((g - l - this.gi) / this.si) ** 2, ((g - l - this.gc) / this.sc) ** 2, c * c);
		}
		return e;
	}
}
