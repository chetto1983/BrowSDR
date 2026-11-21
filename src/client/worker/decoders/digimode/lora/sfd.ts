// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/mesh/mesh_lora_demod.cpp (Demod::Impl::sfd: the first down-chirp
// after the preamble, the sync word check, and the fractional carrier and timing estimates from the preamble and the
// down-chirps), https://github.com/adswill/OnAir; see third_party/onair. The method follows gr-lora_sdr (Joachim Tapparel,
// EPFL, and contributors, GPL-3.0) frame_sync_impl.cc, as credited in OnAir. Changes: split into functions; for
// satellites, OnAir's carrier tracking start (cfoTrack: the preamble's ramp as a carrier drift) and, added in BrowSDR, any
// of the 256 sync words (the nibble bins scored at once), the carrier ambiguity resolved around the offset the orbit
// predicts (hintBins) and the predicted drift (hintRate) taken when the preamble agrees with it.

import { sfdExtraSymbols, syncSymbol } from './code';
import { argmax, DATA, type Demod } from './demod';
import type { ChanBuf } from './chips';
import type { SfdBest as Best, SfdCand as Cand, SfdPreamble as Preamble } from './types';

/** The spectra of the SFD search, kept per demodulator (made at its first preamble). */
const scratch = new WeakMap<Demod, { dacc: Float64Array; upW: Float64Array; dnW: Float64Array; w: Float64Array[] }>();
function buffers(d: Demod) {
	let s = scratch.get(d);
	if (!s) {
		const n = d.n;
		s = {
			dacc: new Float64Array(n),
			upW: new Float64Array(9 * n),
			dnW: new Float64Array(6 * n),
			w: [0, 1, 2, 3, 4].map(() => new Float64Array(n)),
		};
		scratch.set(d, s);
	}
	return s;
}

/** C round: halves away from zero. */
const cround = (x: number): number => Math.sign(x) * Math.round(Math.abs(x));

/** The strongest of three neighbouring bins. */
function near3(d: Demod, v: Float64Array, k: number): number {
	return Math.max(v[d.wrap(k)], v[d.wrap(k - 1)], v[d.wrap(k + 1)]);
}

/** The down-chirp's bin on the (unaligned) grid: every window that holds a part of the 2.25 down-chirps puts it in the same bin. */
function downChirpBin(d: Demod, e: number): number {
	const n = d.n;
	const dacc = buffers(d).dacc;
	dacc.fill(0);
	for (let v = e; v <= e + 3; v++) {
		if (!d.fetch(d.winChip(v), -1)) return -1;
		const mean = d.spectrum(false);
		for (let k = 0; k < n; k++) dacc[k] += d.pw[k] / mean;
	}
	let kDn = 0,
		bestDn = 0;
	for (let k = 0; k < n; k++) {
		const lo = dacc[d.wrap(k - 1)],
			hi = dacc[d.wrap(k + 1)];
		const q = dacc[k] + Math.max(lo, hi);
		if (q > bestDn) {
			bestDn = q;
			kDn = lo > hi && lo > dacc[k] ? d.wrap(k - 1) : k;
		}
	}
	// noise alone reaches about 14 at SF7, 20 at SF12
	return bestDn < 10 + d.sf ? -1 : kDn;
}

/**
 * The bins a sync word nibble can take (nibble << 3 as a signed 7-bit value), less nibble 0: a sync symbol in bin 0 looks
 * like one more preamble chirp, so with any sync word allowed the preamble's end would be ambiguous.
 */
const nibbleBins = (sf: number): number[] => Array.from({ length: 15 }, (_, v) => syncSymbol((v + 1) << 4, 0, sf));

/** The best nibble bin of a sync window (relative to cfo) by the score `at`, and that score. */
function bestNibble(sf: number, at: (k: number) => number): [bin: number, score: number] {
	let bin = 0,
		best = -1;
	for (const v of nibbleBins(sf)) {
		const q = at(v);
		if (q > best) [bin, best] = [v, q];
	}
	return [bin, best];
}

/** A carrier bin 0..N-1 as a signed offset in bins: within half the band of the offset the orbit predicts, else of 0. */
function signedBin(d: Demod, k: number): number {
	const c = Number.isFinite(d.hintBins) ? d.hintBins : 0;
	const n = d.n;
	return c + ((((k - c + n / 2) % n) + n) % n) - n / 2;
}

/** Normalised spectrum of window o into out. */
function keep(d: Demod, out: Float64Array, o: number, mean: number): void {
	for (let k = 0; k < d.n; k++) out[o + k] = d.pw[k] / mean;
}

/**
 * Up-chirp bin = cfo - tau, down-chirp bin = cfo + tau (tau: where the symbols start, in chips, from the grid's windows); both
 * may be one off, so tau is tried two chips either side, and half a symbol away. Every candidate (tau, m) is scored on the
 * cheap chip-stream windows (9 up and 6 down windows per tau serve all m).
 */
function candidates(d: Demod, e: number, kDn: number, syncs: number[]): Cand[] {
	const n = d.n;
	const diff = d.wrap(kDn - d.kUp);
	const taus: number[] = [];
	for (let k = -2; k <= 2; k++) taus.push(d.wrap(Math.floor(diff / 2) + k), d.wrap(Math.floor(diff / 2) + k + n / 2));
	const { upW, dnW } = buffers(d);
	const upOk = new Uint8Array(9),
		dnOk = new Uint8Array(6);
	const any = d.p.anySync;
	const sw = syncs.map((s) => [syncSymbol(s, 0, d.sf), syncSymbol(s, 1, d.sf)]);
	const cands: Cand[] = [];
	const at = (w: Float64Array, idx: number, k: number) =>
		Math.max(w[idx * n + d.wrap(k)], w[idx * n + d.wrap(k - 1)], w[idx * n + d.wrap(k + 1)]);
	// the two sync symbols' windows: the wanted bins, or the best of the 16 nibble bins
	const sync = (idx: number, cfoC: number, want: number) =>
		any ? bestNibble(d.sf, (v) => at(upW, idx, cfoC + v))[1] : at(upW, idx, cfoC + want);
	for (const tau of taus) {
		const cfoC = d.wrap(d.kUp + tau);
		// up windows start at (e + j) N + tau for j = -4..4, down windows for j = -1..4
		for (let j = -4; j <= 4; j++) {
			upOk[j + 4] = d.fetch(d.ochip + (e + j) * n + tau, 1) ? 1 : 0;
			if (upOk[j + 4]) keep(d, upW, (j + 4) * n, d.spectrum(true));
		}
		for (let j = -1; j <= 4; j++) {
			dnOk[j + 1] = d.fetch(d.ochip + (e + j) * n + tau, -1) ? 1 : 0;
			if (dnOk[j + 1]) keep(d, dnW, (j + 1) * n, d.spectrum(false));
		}
		// first down-chirp at (e + m) N + tau: up windows at m-3, m-2, m-1, down windows at m, m+1
		for (let m = -1; m <= 3; m++) {
			if (!upOk[m + 1] || !upOk[m + 2] || !upOk[m + 3] || !dnOk[m + 1] || !dnOk[m + 2]) continue;
			for (let si = 0; si < (any ? 1 : syncs.length); si++) {
				const [sw1, sw2] = sw[si];
				const score = at(upW, m + 1, cfoC) + sync(m + 2, cfoC, sw1) + sync(m + 3, cfoC, sw2) + at(dnW, m + 1, cfoC) + at(dnW, m + 2, cfoC);
				cands.push({ score, tau, m, cfoC, si });
			}
		}
	}
	cands.sort((a, b) => b.score - a.score);
	return cands.slice(0, 2 + (any ? 1 : syncs.length));
}

/** The best candidate scored again on windows resampled with their carrier offset mixed out (full sensitivity). */
function bestCandidate(d: Demod, b: ChanBuf, e: number, cands: Cand[], syncs: number[]): Best | undefined {
	const n = d.n,
		rho = d.rho;
	const w = buffers(d).w;
	let best: Best | undefined;
	for (const c of cands) {
		let sw1 = syncSymbol(syncs[c.si], 0, d.sf),
			sw2 = syncSymbol(syncs[c.si], 1, d.sf);
		// after mixing, the expected bins are relative to it
		const cfoMix = signedBin(d, c.cfoC);
		const s = (e + c.m) * n + c.tau;
		const starts = [s - 3 * n, s - 2 * n, s - n, s, s + n];
		let ok = true;
		for (let i = 0; i < 5 && ok; i++) {
			ok = d.extract(b, d.origin + starts[i] * rho, rho, cfoMix);
			if (ok) {
				const mean = d.spectrum(i < 3);
				for (let k = 0; k < n; k++) w[i][k] = d.pw[k] / mean;
			}
		}
		if (!ok) continue;
		if (d.p.anySync) {
			sw1 = bestNibble(d.sf, (v) => near3(d, w[1], v))[0];
			sw2 = bestNibble(d.sf, (v) => near3(d, w[2], v))[0];
		}
		const score = near3(d, w[0], 0) + near3(d, w[1], sw1) + near3(d, w[2], sw2) + near3(d, w[3], 0) + near3(d, w[4], 0);
		if (!best || score > best.score) best = { score, s, cfoC: c.cfoC, v1: argmax(w[1]), v2: argmax(w[2]), sw1, sw2 };
	}
	return best;
}

/** The bin of the strongest of bins -2..2 and its power. */
function peakNearZero(d: Demod): [number, number] {
	let k = 0,
		bp = 0;
	for (let dd = -2; dd <= 2; dd++) {
		const v = d.pw[d.wrap(dd)];
		if (v > bp) {
			bp = v;
			k = dd;
		}
	}
	return [k, bp];
}

/** The up-chirps of the preamble resampled with the carrier mixed out: their peaks, the phase step and the SNR. */
function preambleWindows(d: Demod, b: ChanBuf, s: number, cfo: number, J: number): Preamble {
	const n = d.n;
	const r: Preamble = {
		ej: new Float64Array(J + 1),
		okj: new Uint8Array(J + 1),
		wj: new Float64Array(J + 1),
		accR: 0,
		accI: 0,
		sig: 0,
		noi: 0,
		ns: 0,
	};
	const xr = new Float64Array((J + 1) * 5),
		xi = new Float64Array((J + 1) * 5);
	for (let j = J; j >= 1; j--) {
		if (!d.extract(b, d.origin + (s - (2 + j) * n) * d.rho, d.rho, cfo)) continue;
		const mean = d.spectrum(true);
		const [k, bp] = peakNearZero(d);
		r.ej[j] = k + d.frac(k);
		r.okj[j] = 1;
		r.wj[j] = bp;
		for (let dd = -2; dd <= 2; dd++) {
			xr[j * 5 + dd + 2] = d.re[d.wrap(dd)];
			xi[j * 5 + dd + 2] = d.im[d.wrap(dd)];
		}
		// noise from the bins far from the peak (the band edges of the filter spread a little energy around it)
		let nf = 0,
			nn = 0;
		for (let dd = n / 8; dd <= n - n / 8; dd++) {
			nf += d.pw[d.wrap(k + dd)];
			nn++;
		}
		nf /= Math.max(1, nn);
		r.sig += Math.max(0, mean * n - nf * n);
		r.noi += nf;
		r.ns++;
	}
	// the phase of one bin advances by 2 pi times the carrier offset from window to window
	let kb = 0,
		bp = -1;
	for (let dd = 0; dd < 5; dd++) {
		let en = 0;
		for (let j = 1; j <= J; j++) en += xr[j * 5 + dd] ** 2 + xi[j * 5 + dd] ** 2;
		if (en > bp) {
			bp = en;
			kb = dd;
		}
	}
	for (let j = J; j >= 2; j--) {
		if (!r.okj[j] || !r.okj[j - 1]) continue;
		const ar = xr[(j - 1) * 5 + kb],
			ai = xi[(j - 1) * 5 + kb],
			br = xr[j * 5 + kb],
			bi = xi[j * 5 + kb];
		r.accR += ar * br + ai * bi;
		r.accI += ai * br - ar * bi;
	}
	return r;
}

/** Weighted line fit of the up-chirps' peaks against the window index: the clock drift per symbol (up to 250 ppm). */
function slopeOf(pre: Preamble, J: number, n: number): { slope: number; sw: number; sx: number; sy: number } {
	let sw = 0,
		sx = 0,
		sy = 0,
		sxx = 0,
		sxy = 0,
		cnt = 0;
	for (let j = 1; j <= J; j++) {
		if (!pre.okj[j]) continue;
		const w = pre.wj[j];
		sw += w;
		sx += w * j;
		sy += w * pre.ej[j];
		sxx += w * j * j;
		sxy += w * j * pre.ej[j];
		cnt++;
	}
	let slope = 0;
	if (cnt >= 4) {
		const den = sw * sxx - sx * sx;
		if (den > 0) slope = (sw * sxy - sx * sy) / den;
	}
	slope = Math.max(-2.5e-4 * n, Math.min(2.5e-4 * n, slope));
	return { slope, sw, sx, sy };
}

/** Fine estimates on accurately resampled windows, twice: carrier (bins), start (chips from the origin) and drift. */
function fineEstimates(d: Demod, b: ChanBuf, s0: number, cfo0: number, J: number): { s: number; cfo: number; slope: number } | undefined {
	const n = d.n;
	const track = d.p.cfoTrack > 0;
	let s = s0,
		cfo = cfo0,
		slope = 0;
	for (let it = 0; it < 2; it++) {
		const pre = preambleWindows(d, b, s, cfo, J);
		let epsDn = 0,
			wDn = 0;
		for (let k = 0; k < 2; k++) {
			if (!d.extract(b, d.origin + (s + k * n) * d.rho, d.rho, cfo)) return;
			d.spectrum(false);
			const [pk, bp] = peakNearZero(d);
			epsDn += (pk + d.frac(pk)) * bp;
			wDn += bp;
		}
		const fit = slopeOf(pre, J, n);
		if (fit.sw <= 0 || wDn <= 0) return;
		epsDn /= wDn;
		slope = fit.slope;
		// the up-chirps' peak taken where the down-chirps are (j = -2.5)
		const epsUp = (fit.sy - slope * fit.sx) / fit.sw + slope * -2.5;
		let dres = 0.5 * (epsUp + epsDn);
		// a drifting carrier: of the slope, only the stretched symbol clock moves the symbol start, the rest is the drift
		const clk = track ? stretchedClock(d, cfo) : slope;
		// at the first down-chirp (a frequency ramp does not move the symbol clock)
		const tres = 0.5 * (epsDn - epsUp) - 0.5 * clk;
		if (Math.hypot(pre.accR, pre.accI) > 0) {
			let ph = Math.atan2(pre.accI, pre.accR) / (2 * Math.PI);
			// a drifting carrier: the phase step measures the offset in the middle of the preamble, the estimate is wanted at the down-chirps
			if (track) ph += -(slope - clk) * ((J + 1) / 2 + 2.5);
			let dd = ph - dres;
			dd -= cround(dd);
			// a drifting carrier: the two estimates must agree before the finer one is taken
			if (!track || (it > 0 && Math.abs(dd) < 0.3)) dres += dd;
		}
		cfo += dres;
		s += tres;
		if (pre.ns > 0) {
			// SNR in the LoRa band from the preamble: peak bins against the mean (which is the noise per bin)
			const sMean = pre.sig / pre.ns,
				nMean = pre.noi / pre.ns;
			d.snrLin = Math.max(1e-4, sMean / (n * Math.max(nMean, 1e-30)));
			d.levelLin = sMean / (n * n);
			d.sigPw = sMean;
		}
	}
	return { s, cfo, slope };
}

/**
 * The part of the preamble's ramp that is the symbol clock stretched by the Doppler shift (chips per symbol, the timing
 * loop's, not the carrier's): the shift's fraction of the carrier frequency; 0 when the carrier frequency is not known.
 */
function stretchedClock(d: Demod, cfoBins: number): number {
	const p = d.p;
	return p.carrierHz ? (-((cfoBins * p.bwHz) / d.n) / p.carrierHz) * d.n : 0;
}

/**
 * A carrier that drifts (cfoTrack > 0, a satellite's Doppler rate): what the preamble showed as a clock drift is a frequency
 * ramp, which the demodulator's carrier loop follows; the symbol clock stays at the nominal rate. The orbit's drift is taken
 * when the preamble's agrees with it.
 */
function startCarrierLoop(d: Demod, slope: number): void {
	const p = d.p;
	d.cfoRate = 0;
	d.thetaOk = false;
	d.lastAdj = 0;
	if (p.cfoTrack <= 0) return;
	const measured = -(slope - stretchedClock(d, d.cfoBins));
	const hint = d.hintRate;
	d.cfoRate = Number.isFinite(hint) && Math.abs(measured - hint) < 0.05 + 0.5 * Math.abs(hint) ? hint : measured;
	d.cfoBins += (1.75 + sfdExtraSymbols(d.sf)) * d.cfoRate; // the estimate is valid half a symbol into the down-chirps
	d.cfoStartBins = d.cfoBins;
	d.drift = 0;
}

/** Finds the first down-chirp after the preamble, checks the sync word and measures the carrier and timing offsets. */
export function findSfd(d: Demod, b: ChanBuf): boolean {
	const e = d.preEnd,
		n = d.n,
		p = d.p;
	const kDn = downChirpBin(d, e);
	if (kDn < 0) return false;
	const syncs = [p.syncWord];
	for (const s of p.moreSync) if (!syncs.includes(s)) syncs.push(s);
	const best = bestCandidate(d, b, e, candidates(d, e, kDn, syncs), syncs);
	if (!best || best.score < 15) return false;
	const close = (v: number, want: number) => {
		const k = d.wrap(v - want);
		return k <= 2 || k >= n - 2;
	};
	if (!close(best.v1, best.sw1) || !close(best.v2, best.sw2)) return false;
	d.syncSeen = ((((best.v1 + 4) >> 3) << 4) | (((best.v2 + 4) >> 3) & 0xf)) & 0xff;
	const J = Math.max(1, Math.min(12, e - d.preFirst - 2));
	const fine = fineEstimates(d, b, best.s, signedBin(d, best.cfoC), J);
	if (!fine) return false;
	d.cfoBins = fine.cfo;
	d.drift = fine.slope; // chips per symbol
	startCarrierLoop(d, fine.slope);
	d.chipS = d.rho * (1 + d.drift / n);
	d.perS = n * d.chipS;
	// the data start 2.25 symbols after the first down-chirp (and the clock error of 2.25 symbols later)
	d.posS = d.origin + (fine.s + (2.25 + sfdExtraSymbols(d.sf)) * (n + d.drift)) * d.rho;
	d.frameStart = d.origin + (fine.s - (2 + p.preamble) * n) * d.rho;
	d.loopInt = 0;
	d.posS0 = d.posS;
	d.retried = 0;
	d.startFd();
	d.state = DATA;
	return true;
}
