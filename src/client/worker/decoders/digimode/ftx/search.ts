// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/hfdig/hfdig_ftx.cpp (SlotDecoder::bigFft, spectrogram,
// toneSums, score, candidates, nearDecoded: the sync search of a slot), https://github.com/adswill/OnAir; see
// third_party/onair. Changes: the large FFT of the slot is a real FFT (a complex FFT of half the size and the split of
// its even and odd parts), and the spectrogram transforms two frames at a time (one as the real, one as the imaginary
// input); only the bins below half the rate are kept. The results are those of OnAir's complex transforms. The WSPR
// score forms each frame's tone sums once per bin. The spectrogram and the candidate search run in steps (generators),
// so that a slot can be decoded a little at a time between blocks of audio.

import { Fft } from '@/worker/decoders/dab/ofdm/fft';
import type { FtxCand, FtxDecode, FtxJob, FtxLayout } from './types';
import { spec, WSPR } from './wave';

/** Lowest sync score of an FT8 / FT4 candidate. */
const SYNC_MIN = 1.45;
/** The search yields to the caller after this many spectrogram frames, or candidate bins. */
const STEP_FRAMES = 64;
const STEP_BINS = 256;

const ffts = new Map<number, Fft>();
/** FFTs up to this size are kept for the next slots. */
const KEEP_FFT = 1 << 17;

/** The FFT of size n: small ones kept for every decoder, larger ones in `keep` (a decoder's own, freed with it). */
export function fftOf(n: number, keep?: Map<number, Fft>): Fft {
	const cache = n <= KEEP_FFT ? ffts : keep;
	let f = cache?.get(n);
	if (!f) {
		f = new Fft(n);
		cache?.set(n, f);
	}
	return f;
}

/** The spectrum of a slot and its sync search. */
export class SlotSearch {
	/** Bins 0 .. nBig / 2 - 1 of the FFT of the whole slot (nBig samples, zero-padded). */
	Xr = new Float64Array(0);
	Xi = new Float64Array(0);
	nBig = 0;
	/** Hz per bin of the large FFT. */
	df = 0;
	/** Hz per bin of the spectrogram (half the tone spacing). */
	binHz = 0;
	bLo = 0;
	nb = 0;
	nf = 0;
	/** Power per frame and bin (bins from bLo). */
	P = new Float32Array(0);
	/** Sum over the tones of a candidate at each frame and bin: upright, mirrored. */
	private readonly A = [new Float32Array(0), new Float32Array(0)];
	/** The sync symbols and their tones. */
	private readonly syncK: Int32Array;
	private readonly syncT: Int32Array;
	/** WSPR: per frame of one bin, the four tones' alternating sum and their sum. */
	private colD = new Float64Array(0);
	private colS = new Float64Array(0);

	constructor(
		private readonly job: FtxJob,
		private readonly L: FtxLayout,
		readonly x: Float32Array,
		private readonly mirrored: boolean,
		private readonly bigFfts: Map<number, Fft>,
	) {
		this.syncK = Int32Array.from(L.sync, ([k]) => k);
		this.syncT = Int32Array.from(L.sync, ([, t]) => t);
	}

	/** The large FFT of the whole slot, kept for cutting out the candidates (in a few steps). */
	*bigFft(): Generator<void, void, void> {
		let n = 8;
		while (n < this.x.length) n <<= 1;
		this.nBig = n;
		const h = n >> 1;
		const fft = fftOf(h, this.bigFfts);
		yield;
		// the even samples as the real part, the odd ones as the imaginary part
		const zr = new Float64Array(h);
		const zi = new Float64Array(h);
		const x = this.x;
		for (let i = 0; 2 * i < x.length; i++) {
			zr[i] = x[2 * i];
			zi[i] = 2 * i + 1 < x.length ? x[2 * i + 1] : 0;
		}
		yield;
		fft.forward(zr, zi);
		yield;
		this.Xr = new Float64Array(h);
		this.Xi = new Float64Array(h);
		const sc = Math.cos((2 * Math.PI) / n);
		const ss = -Math.sin((2 * Math.PI) / n);
		let c = 1;
		let s = 0;
		for (let k = 0; k < h; k++) {
			// exp(-j 2 pi k / n), computed afresh every 1024 bins and turned in between
			if (!(k & 1023)) [c, s] = [Math.cos((2 * Math.PI * k) / n), -Math.sin((2 * Math.PI * k) / n)];
			const j = k ? h - k : 0;
			// even part E = (Z[k] + conj Z[h-k]) / 2, odd part O = (Z[k] - conj Z[h-k]) / 2j, X = E + exp(-j 2 pi k / n) O
			const er = 0.5 * (zr[k] + zr[j]);
			const ei = 0.5 * (zi[k] - zi[j]);
			const or = 0.5 * (zi[k] + zi[j]);
			const oi = -0.5 * (zr[k] - zr[j]);
			this.Xr[k] = er + c * or - s * oi;
			this.Xi[k] = ei + c * oi + s * or;
			const nc = c * sc - s * ss;
			s = c * ss + s * sc;
			c = nc;
		}
		this.df = this.L.rate / n;
	}

	/** The spectrogram of the slot (power per frame and bin, one symbol per frame, frames every quarter symbol), in steps. */
	*spectrogram(): Generator<void, void, void> {
		const { nsps, rate, nt, sp } = this.L;
		const nfft = 2 * nsps;
		const hop = nsps / 4;
		this.binHz = rate / nfft;
		this.bLo = Math.floor(150 / this.binHz);
		const bHi = Math.ceil((3000 + nt * sp) / this.binHz);
		this.nb = bHi - this.bLo + 1;
		const x = this.x;
		this.nf = x.length >= nsps ? Math.floor((x.length - nsps) / hop) + 1 : 0;
		const { nb, nf, bLo } = this;
		this.P = new Float32Array(nf * nb);
		const fft = fftOf(nfft);
		const re = new Float64Array(nfft);
		const im = new Float64Array(nfft);
		for (let fr = 0; fr < nf; fr += 2) {
			if (fr % STEP_FRAMES === 0 && fr) yield;
			re.fill(0);
			im.fill(0);
			const two = fr + 1 < nf;
			for (let i = 0; i < nsps; i++) {
				re[i] = x[fr * hop + i];
				if (two) im[i] = x[(fr + 1) * hop + i];
			}
			fft.forward(re, im);
			for (let b = 0; b < nb; b++) {
				const k = bLo + b;
				const j = (nfft - k) % nfft;
				// frame fr: (Z[k] + conj Z[-k]) / 2, frame fr + 1: (Z[k] - conj Z[-k]) / 2j
				const ar = 0.5 * (re[k] + re[j]);
				const ai = 0.5 * (im[k] - im[j]);
				this.P[fr * nb + b] = ar * ar + ai * ai;
				if (!two) continue;
				const br = 0.5 * (im[k] + im[j]);
				const bi = 0.5 * (re[j] - re[k]);
				this.P[(fr + 1) * nb + b] = br * br + bi * bi;
			}
		}
		this.toneSums();
	}

	/** A[m][f][b] = sum over the tones t of P(f, b + s t), s = +-2 (upright / mirrored). */
	private toneSums(): void {
		const { nf, nb, P } = this;
		const nt = this.L.nt;
		for (let m = 0; m < 2; m++) {
			this.A[m] = new Float32Array(this.job.mode === WSPR || (m && !this.mirrored) ? 0 : nf * nb);
			if (!this.A[m].length) continue;
			const st = m ? -2 : 2;
			const out = this.A[m];
			for (let f = 0; f < nf; f++) {
				const row = f * nb;
				for (let b = 0; b < nb; b++) {
					let a = 0;
					for (let t = 0; t < nt; t++) {
						const bb = b + st * t;
						if (bb >= 0 && bb < nb) a += P[row + bb];
					}
					out[row + b] = a;
				}
			}
		}
	}

	/**
	 * WSPR: the share of the power in the tones of the sync vector's parity, for every start f0 .. f1 of bin b (into best
	 * and bestF where higher). The difference and the sum of the four tones of each frame are formed once per bin.
	 */
	private wsprColumn(b: number, s: number, f0: number, f1: number, best: Float64Array, bestF: Int32Array, at: number): void {
		const { nf, nb, P, syncK, syncT } = this;
		const D = this.colD;
		const S = this.colS;
		for (let f = f0; f < nf; f++) {
			let d = 0;
			let sum = 0;
			for (let t = 0; t < 4; t++) {
				const bb = b + t * s;
				const v = bb >= 0 && bb < nb ? P[f * nb + bb] : 0;
				d += t & 1 ? -v : v;
				sum += v;
			}
			D[f] = d;
			S[f] = sum;
		}
		for (let fr = f0; fr <= f1; fr++) {
			let good = 0;
			let all = 0;
			for (let i = 0; i < syncK.length; i++) {
				const f = fr + 4 * syncK[i];
				if (f >= nf) break;
				// tone 1: the odd tones are on
				good += syncT[i] ? -D[f] : D[f];
				all += S[f];
			}
			const sc = all > 0 ? good / all : 0;
			if (sc > best[at]) {
				best[at] = sc;
				bestF[at] = fr;
			}
		}
	}

	/** Sync score of a transmission starting at frame fr with tone 0 at bin b. */
	score(fr: number, b: number, mir: boolean): number {
		const s = mir ? -2 : 2;
		const A = this.A[mir ? 1 : 0];
		const { nf, nb, P, syncK, syncT } = this;
		let syn = 0;
		let all = 0;
		let n = 0;
		const inBand = b >= 0 && b < nb;
		for (let i = 0; i < syncK.length; i++) {
			const f = fr + 4 * syncK[i];
			if (f >= nf) continue;
			if (inBand) all += A[f * nb + b];
			const bb = b + s * syncT[i];
			if (f >= 0 && bb >= 0 && bb < nb) syn += P[f * nb + bb];
			n++;
		}
		if (n < syncK.length >> 1 || all <= syn) return 0;
		return syn / ((all - syn) / (this.L.nt - 1));
	}

	/** FT8 / FT4: the score of every start f0 .. f1 of bin b (into best and bestF where higher). */
	private ftxColumn(b: number, mir: boolean, f0: number, f1: number, best: Float64Array, bestF: Int32Array, at: number): void {
		for (let f = f0; f <= f1; f++) {
			const s = this.score(f, b, mir);
			if (s > best[at]) {
				best[at] = s;
				bestF[at] = f;
			}
		}
	}

	/** The best start of each bin, its peaks above the threshold, best first (in steps). */
	*candidates(mir: boolean): Generator<void, FtxCand[], void> {
		const L = this.L;
		const hop = L.nsps / 4;
		const tNom = spec(this.job.mode).t0 - this.job.x0;
		const f0 = Math.max(0, Math.floor(((tNom + this.job.dtMin) * L.rate) / hop));
		const f1 = Math.min(this.nf - 1, Math.ceil(((tNom + this.job.dtMax) * L.rate) / hop));
		const width = (L.nt - 1) * L.sp;
		const b0 = Math.max(0, Math.ceil((mir ? 200 + width : 200) / this.binHz) - this.bLo);
		const b1 = Math.min(this.nb - 1, Math.floor(3000 / this.binHz) - this.bLo);
		if (f1 < f0 || b1 < b0) return [];
		const best = new Float64Array(b1 - b0 + 1);
		const bestF = new Int32Array(b1 - b0 + 1).fill(f0);
		if (this.colD.length < this.nf) [this.colD, this.colS] = [new Float64Array(this.nf), new Float64Array(this.nf)];
		for (let b = b0; b <= b1; b++) {
			if ((b - b0) % STEP_BINS === 0 && b > b0) yield;
			if (this.job.mode === WSPR) this.wsprColumn(b, mir ? -2 : 2, f0, f1, best, bestF, b - b0);
			else this.ftxColumn(b, mir, f0, f1, best, bestF, b - b0);
		}
		return this.peaks(best, bestF, b0);
	}

	/** The bins whose best score is above the threshold and a peak within +-2 bins, best first, at most maxCand. */
	private peaks(best: Float64Array, bestF: Int32Array, b0: number): FtxCand[] {
		const sorted = Float64Array.from(best).sort();
		const med = sorted[sorted.length >> 1];
		const thr = this.job.mode === WSPR ? Math.max(0.12, med + 0.08) : Math.max(SYNC_MIN, med * 1.15);
		const c: FtxCand[] = [];
		for (let i = 0; i < best.length; i++) {
			const s = best[i];
			if (s < thr) continue;
			let peak = true;
			for (let d = -2; d <= 2 && peak; d++) {
				if (!d || i + d < 0 || i + d >= best.length) continue;
				const o = best[i + d];
				if (o > s || (o === s && d < 0)) peak = false;
			}
			if (peak) c.push({ frame: bestF[i], bin: i + b0 + this.bLo, score: s });
		}
		c.sort((a, b) => b.score - a.score);
		return c.slice(0, this.L.maxCand);
	}

	/** What is left of a decoded signal: not worth the deep search. */
	nearDecoded(c: FtxCand, mir: boolean, out: FtxDecode[]): boolean {
		const sp = spec(this.job.mode);
		const hz = c.bin * this.binHz;
		const dt = this.job.x0 + (c.frame * (this.L.nsps / 4)) / this.L.rate - sp.t0;
		return out.some((o) => o.mirrored === mir && Math.abs(o.hz - hz) < 0.75 * this.L.sp && Math.abs(o.dt - dt) < 1.5 * sp.symSec);
	}
}
