// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/mesh/mesh_lora_demod.cpp (Demod: preamble search on de-chirped
// FFTs of the chip stream, the accurate resampler (windowed sinc with the carrier mixed out), symbol demodulation with
// soft bins and the timing loop for clock drift, CRC retries and sample-jump recovery), https://github.com/adswill/OnAir;
// see third_party/onair. The method follows gr-lora_sdr (Joachim Tapparel, EPFL, and contributors, GPL-3.0)
// frame_sync_impl.cc and fft_demod_impl.cc and the paper "An open-source LoRa physical layer prototype on GNU Radio"
// (Tapparel et al., 2020), as credited in OnAir. Changes: the SFD search and fine estimates are in sfd.ts; no carrier
// tracking through the frame (cfoTrack, for satellites) and no half-rate search stride; split typed arrays, BrowSDR's
// FFT (dab/ofdm/fft.ts) in double precision.

import { Fft } from '@/worker/decoders/dab/ofdm/fft';
import { ChipStream, type ChanBuf } from './chips';
import { recoverJumps } from './jumps';
import { FrameDecoder, MAX_SYMBOLS, SOFT_M } from './frame';
import { findSfd } from './sfd';
import type { LoraDemodStats, LoraFrame, LoraParams } from './types';

export const SEARCH = 0;
export const PREAMBLE = 1;
export const DATA = 2;
/** Windows a preamble must hold before the sync word is looked for. */
const MIN_PRE_WINS = 4;
/** Interpolator phases. */
const KP = 64;

export function besselI0(x: number, maxTerms = 60): number {
	let s = 1,
		t = 1;
	for (let k = 1; k < maxTerms; k++) {
		t *= (x / (2 * k)) * (x / (2 * k));
		s += t;
	}
	return s;
}

export const kaiserBeta = (a: number): number =>
	a > 50 ? 0.1102 * (a - 8.7) : a > 21 ? 0.5842 * Math.pow(a - 21, 0.4) + 0.07886 * (a - 21) : 0;

/** ln I0(x): the log-likelihood of a noncoherently detected bin (Abramowitz & Stegun 9.8.1, 9.8.2). */
function lnI0(x: number): number {
	if (x < 3.75) {
		const t = x / 3.75,
			t2 = t * t;
		return Math.log(1 + t2 * (3.5156229 + t2 * (3.0899424 + t2 * (1.2067492 + t2 * (0.2659732 + t2 * (0.0360768 + t2 * 0.0045813))))));
	}
	return x - 0.5 * Math.log(6.2831853 * x) + 0.125 / x;
}

/** Interpolator: windowed sinc with its -6 dB point at bw / 2, transition +-0.1 bw, 50 dB; KP + 1 phases of k taps. */
function sincTable(rho: number): { k: number; tab: Float64Array } {
	const fc = 0.5 / rho,
		df = 0.2 / rho;
	let k = Math.ceil((50 - 7.95) / (14.36 * df)) + 1;
	k = Math.max(8, (k + 1) & ~1);
	const tab = new Float64Array((KP + 1) * k);
	const beta = kaiserBeta(50),
		half = k / 2,
		i0b = besselI0(beta);
	for (let r = 0; r <= KP; r++) {
		const f = r / KP;
		let sum = 0;
		for (let j = 0; j < k; j++) {
			const d = f + half - 1 - j;
			const s = Math.abs(d) < 1e-12 ? 2 * fc : Math.sin(2 * Math.PI * fc * d) / (Math.PI * d);
			const rr = d / (half + 0.5);
			const w = besselI0(beta * Math.sqrt(Math.max(0, 1 - rr * rr))) / i0b;
			tab[r * k + j] = s * w;
			sum += s * w;
		}
		for (let j = 0; j < k; j++) tab[r * k + j] /= sum;
	}
	return { k, tab };
}

/** Demodulator of one spreading factor on one channel (samples at fs >= 2 x bandwidth with the channel at 0 Hz). */
export class Demod {
	readonly sf: number;
	readonly n: number;
	readonly rho: number;
	readonly k: number;
	readonly fft: Fft;
	/** conj(up-chirp): multiplying an up-chirp by it leaves a tone. */
	readonly dnRe: Float64Array;
	readonly dnIm: Float64Array;
	readonly re: Float64Array;
	readonly im: Float64Array;
	readonly pw: Float64Array;
	/** The last de-chirped symbol before its FFT. */
	readonly yRe: Float64Array;
	readonly yIm: Float64Array;
	private readonly sinc: Float64Array;
	private mre = new Float64Array(0);
	private mim = new Float64Array(0);
	readonly cs: ChipStream;
	readonly ownCs: boolean;
	st: LoraDemodStats = { preambles: 0, syncBad: 0, headerBad: 0, frames: 0, crcBad: 0, jumpFixed: 0 };
	state = SEARCH;
	/** Chip index of the search grid's origin (origin = ochip x rho). */
	ochip = 0;
	/** Channel sample of chip 0 of the search grid. */
	origin = 0;
	/** Next window of the grid. */
	win = 0;
	/** Power spectra of the last 3 windows (normalised to their mean) and their sum. */
	readonly hist: Float64Array[];
	readonly s3: Float64Array;
	/** Sum of the preamble's spectra. */
	readonly preAcc: Float64Array;
	histN = 0;
	kUp = 0;
	/** The preamble's level in its bins (smoothed). */
	preLevel = 0;
	preFirst = 0;
	preEnd = -1;
	/** Next symbol (channel samples), symbol and chip lengths. */
	posS = 0;
	perS = 0;
	chipS = 0;
	cfoBins = 0;
	drift = 0;
	loopInt = 0;
	/** The data start (a frame that fails its CRC is demodulated again from here). */
	posS0 = 0;
	retried = 0;
	snrLin = 0;
	levelLin = 0;
	/** A preamble peak's power in the spectrum's units (soft decoding). */
	sigPw = 0;
	frameStart = 0;
	syncSeen = 0;
	readonly fd = new FrameDecoder();
	/** +1 / -1: the samples in re / im already had the up-chirp / down-chirp removed. */
	fused = 0;
	private readonly tv = new Float64Array(SOFT_M);
	private readonly ti = new Int32Array(SOFT_M);

	constructor(
		readonly p: LoraParams,
		readonly fs: number,
		shared?: ChipStream,
	) {
		this.sf = p.sf;
		const n = (this.n = 1 << p.sf);
		this.rho = fs / p.bwHz;
		this.ownCs = !shared || Math.abs(shared.rho - this.rho) > 1e-9;
		this.cs = this.ownCs || !shared ? new ChipStream(this.rho) : shared;
		this.fft = new Fft(n);
		this.dnRe = new Float64Array(n);
		this.dnIm = new Float64Array(n);
		for (let i = 0; i < n; i++) {
			const ph = 2 * Math.PI * ((i * i) / (2 * n) - 0.5 * i);
			this.dnRe[i] = Math.cos(ph);
			this.dnIm[i] = -Math.sin(ph);
		}
		this.re = new Float64Array(n);
		this.im = new Float64Array(n);
		this.pw = new Float64Array(n);
		this.yRe = new Float64Array(n);
		this.yIm = new Float64Array(n);
		this.hist = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
		this.s3 = new Float64Array(n);
		this.preAcc = new Float64Array(n);
		const { k, tab } = sincTable(this.rho);
		this.k = k;
		this.sinc = tab;
	}

	startFd(): void {
		if (this.p.implicitHdr) this.fd.startImplicit(this.sf, this.p.ldro, this.p.implicitLen, this.p.cr, this.p.crc);
		else this.fd.start(this.sf, this.p.ldro);
	}

	/** Samples needed to extract a window that starts at sample t0 with chip spacing step. */
	lastSample(t0: number, step: number): number {
		return t0 + (this.n - 1) * step + this.k / 2 + 3;
	}
	firstSample(t0: number): number {
		return t0 - this.k / 2 - 2;
	}

	/** The N chips from chip c0 of the chip stream; fuse +1 / -1 also removes an up-chirp / down-chirp. */
	fetch(c0: number, fuse: number): boolean {
		this.fused = 0;
		const cs = this.cs,
			n = this.n;
		if (c0 < cs.begin || c0 + n > cs.end) return false;
		const o = c0 - cs.base,
			sr = cs.re,
			si = cs.im,
			re = this.re,
			im = this.im;
		if (fuse) {
			const dr = this.dnRe,
				di = this.dnIm,
				sg = fuse < 0 ? -1 : 1;
			for (let i = 0; i < n; i++) {
				const vr = sr[o + i],
					vi = si[o + i],
					cr = dr[i],
					ci = sg * di[i];
				re[i] = vr * cr - vi * ci;
				im[i] = vr * ci + vi * cr;
			}
		} else
			for (let i = 0; i < n; i++) {
				re[i] = sr[o + i];
				im[i] = si[o + i];
			}
		this.fused = fuse;
		return true;
	}

	/** Accurate window: mix out cfo (bins), low-pass to the LoRa band and resample at t0 + i x step. */
	extract(b: ChanBuf, t0: number, step: number, cfo: number): boolean {
		const lo = Math.floor(this.firstSample(t0)),
			hi = Math.ceil(this.lastSample(t0, step));
		if (lo < b.begin || hi >= b.end) return false;
		const len = hi - lo + 1;
		if (this.mre.length < len) {
			this.mre = new Float64Array(len + 256);
			this.mim = new Float64Array(len + 256);
		}
		const mre = this.mre,
			mim = this.mim,
			xr = b.re,
			xi = b.im,
			x0 = lo - b.base;
		const w = (-2 * Math.PI * cfo) / (this.n * this.rho);
		// the phasor of sample k = 16 g + l: one sine per 16 samples
		const cw = Math.cos(w),
			sw = Math.sin(w);
		for (let k0 = 0; k0 < len; k0 += 16) {
			const a = (w * (lo + k0)) % (2 * Math.PI);
			let zr = Math.cos(a),
				zi = Math.sin(a);
			const cnt = Math.min(16, len - k0);
			for (let l = 0; l < cnt; l++) {
				const r = xr[x0 + k0 + l],
					i = xi[x0 + k0 + l];
				mre[k0 + l] = r * zr - i * zi;
				mim[k0 + l] = r * zi + i * zr;
				const t = zr * cw - zi * sw;
				zi = zr * sw + zi * cw;
				zr = t;
			}
		}
		const k = this.k,
			tab = this.sinc,
			re = this.re,
			im = this.im,
			half = k / 2;
		for (let i = 0; i < this.n; i++) {
			const t = t0 + i * step - lo;
			const n0 = Math.floor(t);
			const h = Math.round((t - n0) * KP) * k;
			const o = n0 - half + 1;
			let sr = 0,
				si = 0;
			for (let j = 0; j < k; j++) {
				const c = tab[h + j];
				sr += c * mre[o + j];
				si += c * mim[o + j];
			}
			re[i] = sr;
			im[i] = si;
		}
		return true;
	}

	/** De-chirp (up: remove an up-chirp; else a down-chirp) and FFT; fills pw, returns the mean power. */
	spectrum(up: boolean, keep = false): number {
		const n = this.n,
			re = this.re,
			im = this.im,
			pw = this.pw;
		if (this.fused !== (up ? 1 : -1)) {
			const dr = this.dnRe,
				dIm = this.dnIm,
				sg = up ? 1 : -1;
			for (let i = 0; i < n; i++) {
				const a = re[i],
					c = im[i],
					r = dr[i],
					q = sg * dIm[i];
				re[i] = a * r - c * q;
				im[i] = a * q + c * r;
			}
		}
		this.fused = 0;
		if (keep) {
			this.yRe.set(re);
			this.yIm.set(im);
		}
		this.fft.forward(re, im);
		let s = 0;
		for (let k = 0; k < n; k++) {
			const v = re[k] * re[k] + im[k] * im[k];
			pw[k] = v;
			s += v;
		}
		return s / n + 1e-30;
	}

	wrap(k: number): number {
		return ((k % this.n) + this.n) % this.n;
	}

	/** Fractional peak position around bin k from the complex FFT (Candan's bias-corrected Jacobsen estimator). */
	frac(k: number): number {
		const a = this.wrap(k - 1),
			b = this.wrap(k),
			c = this.wrap(k + 1);
		const re = this.re,
			im = this.im;
		const dr = 2 * re[b] - re[a] - re[c],
			di = 2 * im[b] - im[a] - im[c];
		const den = dr * dr + di * di;
		if (Math.sqrt(den) < 1e-20) return 0;
		const nr = re[a] - re[c],
			ni = im[a] - im[c];
		const d = (((nr * dr + ni * di) / den) * Math.tan(Math.PI / this.n)) / (Math.PI / this.n);
		return Math.max(-0.5, Math.min(0.5, d));
	}

	toSearch(from: number): void {
		this.state = SEARCH;
		this.ochip = Math.ceil(from / this.rho - 1e-6);
		this.origin = this.ochip * this.rho;
		this.win = 0;
		this.histN = 0;
		this.preEnd = -1;
		this.s3.fill(0);
		for (const v of this.hist) v.fill(0);
	}

	winStart(w: number): number {
		return this.origin + w * this.n * this.rho;
	}
	winChip(w: number): number {
		return this.ochip + w * this.n;
	}

	reset(from: number): void {
		this.toSearch(from);
		this.st = { preambles: 0, syncBad: 0, headerBad: 0, frames: 0, crcBad: 0, jumpFixed: 0 };
	}

	/** Consumes what it can of the samples the channel buffer holds; appends finished frames. */
	process(b: ChanBuf, out: LoraFrame[]): void {
		this.run(b, out);
		if (this.ownCs) this.cs.trimToSample(this.oldestNeeded());
	}

	get busy(): boolean {
		return this.state !== SEARCH;
	}

	/** In a frame past its sync word (demodulating the data). */
	get receiving(): boolean {
		return this.state === DATA;
	}

	/** The buffer must keep samples from here on. */
	oldestNeeded(): number {
		const k = this.k;
		if (this.state === DATA) return Math.floor(this.retried >= 2 ? this.posS : Math.min(this.posS, this.posS0 - 4 * this.rho)) - k - 8;
		// the SFD search and the fine estimates look back up to 13 windows
		return Math.floor(Math.max(this.winStart(this.win - 14), this.origin - 8)) - k - 8;
	}

	private run(b: ChanBuf, out: LoraFrame[]): void {
		if (this.ownCs) this.cs.extend(b);
		const n = this.n;
		for (let guard = 0; guard < 100000; guard++) {
			if (this.state === DATA) {
				if (Math.ceil(this.lastSample(this.posS, this.chipS)) + 1 >= b.end) return;
				this.dataSymbol(b, out);
				continue;
			}
			if (this.state === PREAMBLE && this.preEnd >= 0) {
				// the SFD search looks five windows past the end of the preamble
				if (this.winStart(this.preEnd + 6) + this.k + 4 >= b.end) return;
				if (!findSfd(this, b)) {
					this.st.syncBad++;
					this.toSearch(this.winStart(this.preEnd));
				}
				continue;
			}
			const c0 = this.winChip(this.win);
			if (c0 + n > this.cs.end) return;
			if (c0 < this.cs.begin) {
				this.win++; // history was dropped: skip
				continue;
			}
			this.fetch(c0, 1);
			const inv = 1 / this.spectrum(true);
			const h = this.hist[this.win % 3],
				sp = this.s3,
				pw = this.pw;
			for (let k = 0; k < n; k++) {
				const v = pw[k] * inv;
				sp[k] += v - h[k];
				h[k] = v;
			}
			this.histN++;
			if (this.state === SEARCH) {
				if (this.histN >= 3) this.searchPreamble();
			} else if (this.followPreamble(h)) continue;
			this.win++;
		}
	}

	/** Three windows in a row with their energy in the same pair of bins start a preamble. */
	private searchPreamble(): void {
		const n = this.n,
			sp = this.s3,
			mask = n - 1;
		let mq = 0;
		for (let k = 0; k < n - 1; k++) {
			const q = sp[k] + sp[k + 1];
			if (q > mq) mq = q;
		}
		if (sp[n - 1] + sp[0] > mq) mq = sp[n - 1] + sp[0];
		const bestQ = mq / 3;
		if (bestQ <= 7.5) return;
		let best = 0;
		for (let k = 0; k < n; k++)
			if ((sp[k] + sp[(k + 1) & mask]) / 3 >= mq / 3) {
				best = k;
				break;
			}
		for (const v of this.hist) {
			const a = v[best] + v[(best + 1) & mask],
				b = v[this.wrap(best - 1)] + v[best],
				c = v[(best + 1) & mask] + v[(best + 2) & mask];
			if (Math.max(a, b, c) <= 4) return;
		}
		this.state = PREAMBLE;
		this.st.preambles++;
		const acc = this.preAcc;
		acc.fill(0);
		for (const v of this.hist) for (let k = 0; k < n; k++) acc[k] += v[k];
		this.kUp = argmax(acc);
		this.preLevel = bestQ;
		this.preFirst = this.win - 2;
		this.preEnd = -1;
	}

	/**
	 * Still the preamble while the energy stays near kUp (followed bin by bin: a clock error moves it slowly), above a quarter
	 * of the preamble's level so far. Returns true when it went back to the search (the window is not counted).
	 */
	private followPreamble(h: Float64Array): boolean {
		let v = 0;
		for (let d = -2; d <= 2; d++) {
			const k = this.wrap(this.kUp + d);
			v = Math.max(v, h[k] + Math.max(h[this.wrap(k - 1)], h[this.wrap(k + 1)]));
		}
		const age = this.win - this.preFirst;
		if (v > Math.max(5, 0.25 * this.preLevel) && age < 80) {
			// the bin of the recent windows (forgetting the old ones follows a drift; one window alone is too noisy)
			const acc = this.preAcc;
			for (let k = 0; k < this.n; k++) acc[k] = 0.7 * acc[k] + h[k];
			this.kUp = argmax(acc);
			this.preLevel = 0.8 * this.preLevel + 0.2 * v;
			return false;
		}
		if (age >= 80 || age < MIN_PRE_WINS) {
			// a steady carrier, or three windows with nothing after them: not a frame
			this.toSearch(this.winStart(this.win));
			return true;
		}
		this.preEnd = this.win;
		return false;
	}

	/** The four strongest bins (ties: the lower bin first) and their noncoherent log-likelihoods into the frame decoder. */
	private softSymbol(mean: number): number {
		const n = this.n,
			pw = this.pw,
			tv = this.tv,
			ti = this.ti;
		let cnt = 0;
		for (let i = 0; i < n; i++) {
			const v = pw[i];
			if (cnt === SOFT_M && v <= tv[SOFT_M - 1]) continue;
			let pos = cnt < SOFT_M ? cnt++ : SOFT_M - 1;
			while (pos > 0 && tv[pos - 1] < v) {
				tv[pos] = tv[pos - 1];
				ti[pos] = ti[pos - 1];
				pos--;
			}
			tv[pos] = v;
			ti[pos] = i;
		}
		const fd = this.fd,
			at = fd.pushed;
		if (!(this.sigPw > 0) || at >= MAX_SYMBOLS) {
			fd.push(ti[0]);
			return ti[0];
		}
		const nz = Math.max(1e-30, (mean * n - tv[0]) / (n - 1));
		const sc = (2 * Math.sqrt(Math.max(this.sigPw, 1e-30))) / nz;
		const sym = fd.sym;
		for (let c = 0; c < cnt; c++) {
			sym.bin[at * SOFT_M + c] = ti[c];
			sym.m[at * SOFT_M + c] = lnI0(sc * Math.sqrt(tv[c]));
		}
		sym.n[at] = cnt;
		sym.floorM[at] = sym.m[at * SOFT_M + cnt - 1];
		fd.pushSoft();
		return ti[0];
	}

	/**
	 * Timing loop. The phase step where the chirp wraps measures a timing error: the de-chirped symbol's two parts (before and
	 * after the wrap at chip N - k) differ in phase by pi tau, tau = how late the symbol starts, in chips.
	 */
	private timing(k: number, q: number): number {
		const n = this.n;
		// wider loop for the first 40 symbols (the drift from a short preamble may be well off), then the narrow one
		const acq = this.fd.pushed <= 40;
		const kI = acq ? 0.3 : 0.02,
			kP = acq ? 0.8 : 0.3;
		const fold = (n - k) % n;
		const w = (4 * fold * (n - fold)) / (n * n);
		if (!(q > 8 && w > 0.25)) return this.loopInt;
		let s1r = 0,
			s1i = 0,
			s2r = 0,
			s2i = 0,
			rr = 1,
			ri = 0;
		const cr = Math.cos((-2 * Math.PI * k) / n),
			ci = Math.sin((-2 * Math.PI * k) / n);
		const yr = this.yRe,
			yi = this.yIm;
		for (let i = 0; i < n; i++) {
			const vr = yr[i] * rr - yi[i] * ri,
				vi = yr[i] * ri + yi[i] * rr;
			if (i < fold) {
				s1r += vr;
				s1i += vi;
			} else {
				s2r += vr;
				s2i += vi;
			}
			const t = rr * cr - ri * ci;
			ri = rr * ci + ri * cr;
			rr = t;
		}
		// arg(s2 conj(s1)) / pi
		const tau = Math.atan2(s2i * s1r - s2r * s1i, s2r * s1r + s2i * s1i) / Math.PI;
		const e = Math.max(-0.5, Math.min(0.5, tau)) * w;
		this.loopInt += kI * e;
		return kP * e + this.loopInt;
	}

	private dataSymbol(b: ChanBuf, out: LoraFrame[]): void {
		if (!this.extract(b, this.posS, this.chipS, this.cfoBins)) {
			this.toSearch(this.posS);
			return;
		}
		const mean = this.spectrum(true, true);
		const k = this.softSymbol(mean);
		const adj = this.timing(k, this.pw[k] / mean);
		this.posS += this.perS + adj * this.chipS;
		if (this.fd.pushed === 8 && !this.fd.header.ok) {
			this.st.headerBad++;
			this.toSearch(this.posS);
			return;
		}
		if (this.fd.done) this.finishFrame(out);
	}

	private finishFrame(out: LoraFrame[]): void {
		const p = this.p,
			fd = this.fd;
		const got = fd.finish();
		let payload = got?.payload ?? new Uint8Array(0);
		let crcOk = got?.crcOk ?? false;
		let jumpsFixed = 0;
		if (fd.header.crc && !crcOk && this.retried === 0 && !p.implicitHdr && p.jumpChips > 0) {
			// samples lost before the demodulator move every later symbol by the same amount
			const fixed = recoverJumps(this.sf, p.ldro, fd.bins.slice(0, fd.pushed), p.jumpChips);
			if (fixed) {
				payload = fixed.payload;
				crcOk = true;
				jumpsFixed = fixed.jumps;
				this.st.jumpFixed++;
			}
		}
		if (fd.header.crc && !crcOk && this.retried < 3) {
			// The loop's integral holds the rest of the clock drift a short preamble left: demodulate again from the start with it.
			this.retried++;
			const dd = this.loopInt;
			this.drift += dd;
			this.chipS = this.rho * (1 + this.drift / this.n);
			this.perS = this.n * this.chipS;
			this.posS0 += 1.75 * dd * this.rho;
			this.posS = this.posS0;
			this.loopInt = 0;
			this.startFd();
			return;
		}
		const hdr = { ...fd.header };
		out.push({
			payload,
			hdr,
			crcOk,
			corrected: got?.corrected ?? 0,
			cfoHz: (this.cfoBins * p.bwHz) / this.n,
			sfoPpm: ((this.drift + this.loopInt) / this.n) * 1e6,
			snrDb: 10 * Math.log10(this.snrLin),
			softFixed: fd.softFixed,
			jumpsFixed,
			levelDb: 10 * Math.log10(Math.max(this.levelLin, 1e-20)),
			startSample: this.frameStart,
			endSample: this.posS,
			syncWord: this.syncSeen,
		});
		this.st.frames++;
		if (hdr.crc && !crcOk) this.st.crcBad++;
		this.toSearch(this.posS);
	}
}

/** Index of the first maximum (std::max_element). */
export function argmax(v: Float64Array): number {
	let best = 0;
	for (let k = 1; k < v.length; k++) if (v[k] > v[best]) best = k;
	return best;
}
