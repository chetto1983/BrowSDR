// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/marine/marine_fax.cpp (FaxDecoder joined mid-picture: line
// rate search, levels, line start roll and slant follow-up), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the smoothed frequency is read once per search into an array (the same values); the pulse chain is
// cleared through a hook of the decoder.

import { FAX_BLACK_HZ, FAX_WHITE_HZ } from './front';
import { FaxCore, faxImageWidth } from './core';
import type { FaxCandidate } from './types';

/** Lines correlated by the search. */
const LINES = 6;
/** Slant follow-up: each row against the one REF_K lines above, ±REF_R samples around it. */
const REF_K = 8;
const REF_R = 8;

/**
 * Joined mid-picture (no start tone, no phasing): the line period is found by correlating the picture with itself one
 * line later, and refined as the picture comes in by correlating each row with the one REF_K lines above it (the slant).
 */
export abstract class FaxFreeRun extends FaxCore {
	/** History usable for the search starts here (after a stop tone, a reset). */
	protected freeFrom = 0;
	protected freeNext = 0;
	protected freeHits = 0;
	private freeLpm = 0;
	private refLag = 0;
	private readonly refAcc = new Float64Array(2 * REF_R + 1);
	private refRows = 0;
	private smooth = new Float64Array(0);

	/** The pulse detector's chain and list are dropped when a picture starts. */
	protected abstract clearPulses(): void;

	protected resetFree(): void {
		this.freeFrom = this.freeNext = 0;
		this.freeHits = this.freeLpm = 0;
		this.freeRun = false;
		this.refRows = 0;
		this.periodDirty = false;
	}

	/**
	 * A picture is a signal that repeats almost exactly one line later. Look for that at each line rate; the shortest
	 * period that correlates well is the line (a 120 lpm picture also matches two lines later at 60 lpm).
	 */
	protected freeSearch(chainLength: number): void {
		const front = this.front;
		this.freeNext = front.nAud + Math.trunc(front.fs * 0.5);
		if (chainLength >= 3) {
			this.freeHits = 0; // a phasing signal is coming in: the pulse chain locks on it
			return;
		}
		const from = Math.max(this.freeFrom, front.base);
		const cands: FaxCandidate[] = [];
		let rMax = 0;
		for (const lpm of [240, 120, 90, 60]) {
			if (this.lpmSet > 0 && lpm !== this.lpmSet) continue;
			const cand = this.candidate(lpm, from);
			if (!cand) continue;
			cands.push(cand);
			rMax = Math.max(rMax, cand.r);
		}
		// Highest line rate first.
		const best = cands.find((c) => c.r >= 0.3 && c.r >= 0.85 * rMax);
		if (!best) {
			this.freeHits = this.freeLpm = 0;
			return;
		}
		if (best.lpm !== this.freeLpm) {
			this.freeLpm = best.lpm;
			this.freeHits = 0;
		}
		if (++this.freeHits < 2) return; // seen twice, half a second apart
		this.startFree(best.lpm, best.P, Math.max(from, front.nAud - Math.trunc((LINES + 1) * best.P)));
	}

	/** Free-running picture: correlate the row just decoded with the one REF_K rows above; the picture is straightened with each new estimate. */
	protected refineRow(s: number): void {
		if (!this.autoSlant) return;
		const front = this.front;
		const s0 = Math.floor(s);
		const len = Math.trunc(this.Pnom);
		if (s0 - this.refLag - REF_R < front.base || s0 + len + front.smD > front.nAud) return;
		const mr = front.meanF(s0, s0 + len);
		const span = len + 2 * REF_R;
		const x = this.smoothed([s0, len], [s0 - this.refLag - REF_R, span]);
		for (let d = -REF_R; d <= REF_R; d++) {
			let acc = 0;
			// f(s0 + n - (refLag + d)) is entry n - d + REF_R of the second range.
			for (let n = 0, k = len - d + REF_R; n < len; n++, k++) acc += (x[n] - mr) * (x[k] - mr);
			this.refAcc[d + REF_R] += acc;
		}
		++this.refRows;
		if (this.refRows === 24 || this.refRows === 96) this.alignLines();
		if (this.refRows % 4 !== 0) return;
		const peak = this.peak(this.refAcc, REF_R, true);
		if (peak === null) return;
		const P = (this.refLag + peak.at) / REF_K;
		if (Math.abs(P / this.Pnom - 1) > 0.003) return;
		this.estPpm = (P / this.Pnom - 1) * 1e6;
		this.st.slantPpm = this.estPpm + this.manualPpm;
		this.periodDirty = true;
	}

	/** One line rate: the correlation one line later, if the history looks like a picture and the peak stands out. */
	private candidate(lpm: number, from: number): FaxCandidate | null {
		const front = this.front;
		const smD = front.smD;
		const Pn = (front.fs * 60) / lpm;
		const len = Math.trunc(LINES * Pn);
		const L0 = Math.round(Pn);
		const R = Math.ceil(Pn * 0.003) + 1;
		const a = front.nAud - len - L0 - R - 1 - smD;
		if (a < from) return null;
		// The picture must have some contrast: a steady carrier, black or a tone is not one.
		const m = front.meanF(a, a + len);
		const sd = Math.sqrt(Math.max(0, front.meanF2(a, a + len) - m * m));
		if (sd < 60) return null;
		// And lie between black and white: noise, FSK (DSC, NAVTEX dot patterns repeat at every lag) and tones mostly do not.
		const x = this.smoothed([a, len + L0 + R + 1]);
		let inBand = 0;
		let total = 0;
		for (let n = 0; n + smD <= len; n += smD, total++) if (x[n] > 1350 && x[n] < 2450) inBand++;
		if (inBand < 0.6 * total) return null;
		const rr = new Float64Array(2 * R + 1);
		for (let d = -R; d <= R; d++) rr[d + R] = this.corrAt(x, len, L0 + d);
		const peak = this.peak(rr, R, false);
		if (peak === null) return null;
		const c = rr[peak.bi + R];
		const rOff = this.corrAt(x, len, Math.round(0.37 * Pn)); // no line structure there
		if (c - rOff < 0.15) return null;
		return { lpm, r: c, P: L0 + peak.at };
	}

	/**
	 * The maximum of `v` (index - R) and its interpolated position; null at the edge of the range, or when `curved` and the
	 * three values around it do not make a peak.
	 */
	private peak(v: Float64Array, R: number, curved: boolean) {
		let bi = -R;
		for (let d = -R; d <= R; d++) if (v[d + R] > v[bi + R]) bi = d;
		if (bi <= -R || bi >= R) return null; // the peak at the edge of the search: not this line rate
		const [l, c, h] = [v[bi + R - 1], v[bi + R], v[bi + R + 1]];
		const den = l - 2 * c + h;
		if (den < 0) return { bi, at: bi + Math.min(0.5, Math.max(-0.5, (0.5 * (l - h)) / den)) };
		return curved ? null : { bi, at: bi };
	}

	/** fAt over consecutive ranges [start, count], one after the other in a scratch array. */
	private smoothed(...ranges: Array<[start: number, count: number]>): Float64Array {
		const size = ranges.reduce((sum, [, count]) => sum + count, 0);
		if (this.smooth.length < size) this.smooth = new Float64Array(2 * size);
		let at = 0;
		for (const [start, count] of ranges) for (let n = 0; n < count; n++) this.smooth[at++] = this.front.fAt(start + n);
		return this.smooth;
	}

	/** Normalised correlation of f over [a, a + len) with f over [a + lag, a + lag + len) (x[0] = fAt(a)). */
	private corrAt(x: Float64Array, len: number, lag: number): number {
		let [sx, sy, sxx, syy, sxy] = [0, 0, 0, 0, 0];
		for (let n = 0; n < len; n++) {
			const u = x[n];
			const v = x[n + lag];
			sx += u;
			sy += v;
			sxx += u * u;
			syy += v * v;
			sxy += u * v;
		}
		const vx = sxx - (sx * sx) / len;
		const vy = syy - (sy * sy) / len;
		if (vx <= 0 || vy <= 0) return 0;
		return (sxy - (sx * sy) / len) / Math.sqrt(vx * vy);
	}

	private startFree(lpm: number, P0: number, histStart: number): void {
		this.curLpm = this.st.lpm = lpm;
		this.Pnom = (this.front.fs * 60) / lpm;
		if (this.iocSet > 0) this.st.ioc = this.iocSet;
		this.imgW = faxImageWidth(this.st.ioc) || faxImageWidth(576);
		this.fitP = P0;
		this.fitA = histStart;
		const m = this.manualPpm;
		this.estPpm = this.autoSlant ? (P0 / this.Pnom - 1) * 1e6 : 0;
		this.Puse = this.Pnom * (1 + (this.estPpm + m) * 1e-6);
		this.appliedManual = m;
		const d = this.whiteOffset(histStart);
		this.dHat = d;
		this.fbUse = FAX_BLACK_HZ + d;
		this.fwUse = FAX_WHITE_HZ + d;
		this.fbAvg = this.fbUse;
		this.imgStart = histStart;
		this.rowIdx = 0;
		this.st.state = 2;
		this.st.lines = this.st.phasingLines = 0;
		this.st.slantPpm = this.estPpm + m;
		this.freeRun = true;
		this.refLag = Math.round(REF_K * P0);
		this.refAcc.fill(0);
		this.refRows = 0;
		this.picture.start(this.imgW);
		this.clearPulses();
		this.imageLines();
	}

	/** Levels: a chart is mostly white background, so the commonest frequency is the white level; it also gives the mistuning. */
	private whiteOffset(histStart: number): number {
		const front = this.front;
		const hist = new Int32Array(131);
		const step = 4;
		for (let n = histStart; n + step < front.nAud; n += step) {
			const f = front.meanF(n, n + step);
			hist[Math.min(130, Math.max(0, Math.trunc((f - 1250) / 10)))]++;
		}
		let bk = 0;
		for (let k = 1; k < 131; k++) if (hist[k] > hist[bk]) bk = k;
		const mode = 1250 + 10 * bk + 5;
		return Math.abs(mode - FAX_WHITE_HZ) <= 130 ? mode - FAX_WHITE_HZ : 0;
	}

	/**
	 * Where does a line start? A chart is framed: a white margin with a dark frame line on either side runs down the whole
	 * picture at the line boundary. Look for the steady white band flanked by dark columns in the rows so far and roll the
	 * picture (and the line start) to put it at the edges. Nothing moves when no such band stands out.
	 */
	private alignLines(): void {
		const W = this.imgW;
		const n = Math.min(this.rowIdx, 96);
		if (W < 64 || n < 16) return;
		const mean = new Float64Array(W);
		const sd = new Float64Array(W);
		for (let r = this.rowIdx - n; r < this.rowIdx; r++) {
			const row = this.picture.row(r);
			for (let x = 0; x < W; x++) {
				mean[x] += row[x];
				sd[x] += row[x] * row[x];
			}
		}
		for (let x = 0; x < W; x++) {
			mean[x] /= n;
			sd[x] = Math.sqrt(Math.max(0, sd[x] / n - mean[x] * mean[x]));
		}
		const { bc, best, bestB, bestS } = bestMargin(mean, sd, W);
		if (bc <= 2 || bc >= W - 2 || best < 60 || bestB < 170 || bestS > 45) return; // in place already (a pixel either way is noise)
		this.picture.roll(this.rowIdx, bc); // every row left by bc pixels; later rows start bc pixels later
		this.imgStart += bc * (this.Puse / W);
	}
}

/** The column where a white band (mean B, spread S) flanked by dark columns scores best. */
function bestMargin(mean: Float64Array, sd: Float64Array, W: number) {
	const w = Math.max(4, Math.trunc(W / 113)); // 16 px of 1809: about 1 % of the line
	const at = (v: Float64Array, x: number) => v[((x % W) + W) % W];
	let [best, bestB, bestS, bc] = [-1e9, 0, 0, -1];
	for (let c = 0; c < W; c++) {
		let [B, S, L, R] = [0, 0, 1e9, 1e9];
		for (let k = Math.trunc(-w / 2); k < Math.trunc(w / 2); k++) {
			B += at(mean, c + k);
			S += at(sd, c + k);
		}
		B /= w;
		S /= w;
		for (let k = Math.trunc(w / 2); k < w; k++) {
			L = Math.min(L, at(mean, c - k - 1));
			R = Math.min(R, at(mean, c + k));
		}
		const score = B - 0.5 * (L + R) - S;
		if (score > best) [best, bc, bestB, bestS] = [score, c, B, S];
	}
	return { bc, best, bestB, bestS };
}
