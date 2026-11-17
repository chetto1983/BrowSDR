// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/hfdig/hfdig_rtty.cpp (HfdigRtty::Impl: the spectrum and the
// pair search, lock, relink and unlock, the matched filters and ATC, start bit, bit sampling and stop bit check, ITA2,
// the quality figure; kRttyBaudTable and kRttyShiftTable of hfdig_rtty.h), https://github.com/adswill/OnAir; see
// third_party/onair. Changes: an 85 Hz shift is added at the end of the shift table (DWD on 147.3 kHz); the FFT is
// BrowSDR's (dab/ofdm/fft.ts); the settings are set directly (no thread hand-over) and each character also goes to a
// callback; the Auto analysis and its scheduling are in auto.ts and index.ts; the RTTY_* environment knobs are left at
// their defaults.

import { Fft } from '@/worker/decoders/dab/ofdm/fft';
import type { RttySettings, RttyStatus } from './types';

export const RTTY_RATE = 8000;
export const RTTY_BAUDS = [45.45, 50, 75, 100];
/** OnAir's five shifts, then 85 Hz (BrowSDR: the 50 Bd DWD broadcast on 147.3 kHz). */
export const RTTY_SHIFTS = [170, 200, 425, 450, 850, 85];
/** Characters of text kept. */
const TEXT_MAX = 8000;
const FFT = 2048;
const HOP = 1024;
const BIN_HZ = RTTY_RATE / FFT;
/** 300 .. 3300 Hz. */
const BIN_LO = 77;
const BIN_HI = 844;
/** Pair score against the noise floor: 24 dB to lock at once, 16 dB held for LOCK_FRAMES frames, 15 dB to keep. */
const LOCK_RATIO = 251;
const LOCK_RATIO_WEAK = 40;
const UNLOCK_RATIO = 30;
const HYST = 0.05;
const ATC_RATIO = 3;
const LOCK_FRAMES = 5;
const UNLOCK_FRAMES = 12;
const RELINK_FRAMES = 4;

/** ITA2 (US TTY figures), one character per code, NUL where nothing is printed. */
const LETTER_CHARS = '\x00E\nA SIU\rDRJNFCKTZLWHYPQOBG\x00MXV\x00';
const FIGURE_CHARS = '\x003\n- \'87\r$4\x00,!:(5")2#6019?&\x00./;\x00';
const table = (chars: string) => Array.from(chars, (c) => (c === '\x00' ? '' : c));
export const LETTERS = table(LETTER_CHARS);
export const FIGURES = table(FIGURE_CHARS);
export const FIGS_CODE = 27;
export const LTRS_CODE = 31;

const WINDOW = Float64Array.from({ length: FFT }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT));
let sharedFft: Fft | undefined;
const fftOf = () => (sharedFft ??= new Fft(FFT));

/**
 * ITA2 FSK decoder on 8 kHz audio: the pair of tones looked for in 300 .. 3300 Hz at the set shift, a matched filter
 * of one bit at each tone, ATC, then start bit, five data bits and the stop bit.
 */
export class RttyDecoder {
	baud = 45.45;
	shift = 170;
	rev = false;
	private uns = false;
	/** Audio samples fed; sample of the last character. */
	pos = 0;
	lastCharAt = 0;
	/** > 0: the pair is given (lower tone, Hz), no search. */
	fixedLo = 0;
	// spectrum
	private readonly ring = new Float64Array(FFT);
	private ringPos = 0;
	private sinceFrame = 0;
	private readonly pw = new Float64Array(FFT / 2);
	private readonly re = new Float64Array(FFT);
	private readonly im = new Float64Array(FFT);
	private readonly scratch = new Float64Array(BIN_HI - BIN_LO + 1);
	private frames = 0;
	// lock
	locked = false;
	loHz = 0;
	hiHz = 0;
	private weakFrames = 0;
	private relinkFrames = 0;
	private relinkLo = 0;
	private candLo = 0;
	private candFrames = 0;
	/** Pair score of the locked tones against the floor. */
	private ratio = 0;
	// demodulator
	private len = 176;
	private bitSamples = 176;
	private bMI = new Float64Array(176);
	private bMQ = new Float64Array(176);
	private bSI = new Float64Array(176);
	private bSQ = new Float64Array(176);
	private sMI = 0;
	private sMQ = 0;
	private sSI = 0;
	private sSQ = 0;
	private bIdx = 0;
	private phMr = 1;
	private phMi = 0;
	private phSr = 1;
	private phSi = 0;
	private stMr = 1;
	private stMi = 0;
	private stSr = 1;
	private stSi = 0;
	private renorm = 0;
	private maxM = 0;
	private maxS = 0;
	private mark = true;
	// framing
	private fsm = 0;
	private cnt = 0;
	private bit = 0;
	private code = 0;
	private soft = 0;
	private figs = false;
	private eye = 0.5;
	markHz = 0;
	spaceHz = 0;
	text = '';
	chars = 0;
	framingErrors = 0;

	constructor(private readonly onChar?: (ch: string) => void) {
		this.configure({ baudIdx: 0, shiftIdx: 0, reverse: false });
	}

	/** Speed, shift and polarity (OnAir's applyConfig): the lock starts again. */
	configure(s: RttySettings): void {
		this.baud = RTTY_BAUDS[Math.max(0, Math.min(RTTY_BAUDS.length - 1, s.baudIdx))];
		this.shift = RTTY_SHIFTS[Math.max(0, Math.min(RTTY_SHIFTS.length - 1, s.shiftIdx))];
		this.rev = s.reverse;
		this.uns = s.unshift ?? false;
		this.bitSamples = RTTY_RATE / this.baud;
		this.len = Math.max(2, Math.round(this.bitSamples));
		this.bMI = new Float64Array(this.len);
		this.bMQ = new Float64Array(this.len);
		this.bSI = new Float64Array(this.len);
		this.bSQ = new Float64Array(this.len);
		this.unlock();
	}

	/** After a gap in the audio (OnAir's resetAll): the text stays. */
	reset(): void {
		this.pos = this.lastCharAt = 0;
		this.ring.fill(0);
		this.pw.fill(0);
		this.ringPos = this.sinceFrame = this.frames = 0;
		this.figs = false;
		this.eye = 0.5;
		this.unlock();
	}

	run(x: Float32Array | Float64Array): void {
		const fx = this.fixedLo;
		if (fx > 0 && (!this.locked || this.loHz !== fx)) {
			this.locked = true;
			this.loHz = fx;
			this.hiHz = fx + this.shift;
			this.weakFrames = this.relinkFrames = 0;
			this.ratio = 1000;
			this.clearDemod();
			this.setTones();
		}
		for (let i = 0; i < x.length; i++) {
			if (fx <= 0) {
				this.ring[this.ringPos] = x[i];
				if (++this.ringPos >= FFT) this.ringPos = 0;
				if (++this.sinceFrame >= HOP) {
					this.sinceFrame = 0;
					this.frame();
				}
			}
			this.pos++;
			if (this.locked) this.demod(x[i]);
		}
	}

	status(): RttyStatus {
		const state = !this.locked ? 0 : this.pos - this.lastCharAt < 3 * RTTY_RATE && this.lastCharAt > 0 ? 2 : 1;
		let quality = 0;
		if (this.locked) {
			const snr = 10 * Math.log10(Math.max(1, this.ratio));
			const specQ = Math.max(0, Math.min(1, (snr - 20) / 25));
			quality = specQ * (0.3 + 0.7 * this.eye);
		}
		return {
			state,
			markHz: this.locked ? this.markHz : 0,
			spaceHz: this.locked ? this.spaceHz : 0,
			baud: this.baud,
			shiftHz: this.shift,
			reverse: this.rev,
			quality,
			chars: this.chars,
			framingErrors: this.framingErrors,
		};
	}

	private unlock(): void {
		this.locked = false;
		this.loHz = this.hiHz = 0;
		this.weakFrames = this.relinkFrames = 0;
		this.ratio = 0;
		this.clearDemod();
	}

	private clearDemod(): void {
		this.bMI.fill(0);
		this.bMQ.fill(0);
		this.bSI.fill(0);
		this.bSQ.fill(0);
		this.sMI = this.sMQ = this.sSI = this.sSQ = 0;
		this.bIdx = 0;
		this.maxM = this.maxS = 0;
		this.mark = true;
		this.fsm = this.code = this.bit = 0;
	}

	/** The oscillators follow the tones of the pair. */
	private setTones(): void {
		const mk = this.rev ? this.hiHz : this.loHz;
		const sp = this.rev ? this.loHz : this.hiHz;
		const wm = (-2 * Math.PI * mk) / RTTY_RATE;
		const ws = (-2 * Math.PI * sp) / RTTY_RATE;
		this.stMr = Math.cos(wm);
		this.stMi = Math.sin(wm);
		this.stSr = Math.cos(ws);
		this.stSi = Math.sin(ws);
		this.markHz = mk;
		this.spaceHz = sp;
	}

	// ------------------------------------------------------------------ spectrum and pair search
	private binPeak(k: number): number {
		return Math.max(this.pw[k - 1], this.pw[k], this.pw[k + 1]);
	}

	private floorLevel(): number {
		this.scratch.set(this.pw.subarray(BIN_LO, BIN_HI + 1));
		this.scratch.sort();
		return Math.max(1e-12, this.scratch[this.scratch.length >> 1]);
	}

	/** Centre of the tone near bin k (power above the floor, five bins). */
	private centroid(k: number, fl: number): number {
		let kk = k;
		for (let d = -1; d <= 1; d++) if (this.pw[k + d] > this.pw[kk]) kk = k + d;
		let sw = 0;
		let sk = 0;
		for (let d = -2; d <= 2; d++) {
			const w = Math.max(0, this.pw[kk + d] - fl);
			sw += w;
			sk += w * (kk + d);
		}
		return (sw > 0 ? sk / sw : kk) * BIN_HZ;
	}

	private frame(): void {
		const { re, im, pw } = this;
		for (let i = 0; i < FFT; i++) {
			re[i] = this.ring[(this.ringPos + i) % FFT] * WINDOW[i];
			im[i] = 0;
		}
		fftOf().forward(re, im);
		for (let k = 0; k < FFT / 2; k++) {
			const p = re[k] * re[k] + im[k] * im[k];
			pw[k] = this.frames === 0 ? p : 0.65 * pw[k] + 0.35 * p;
		}
		if (++this.frames < 3) return;
		const fl = this.floorLevel();
		const ds = Math.round(this.shift / BIN_HZ);
		// best pair: the lower tone at bin k, the upper one ds bins above
		let best = 0;
		let bestA = 0;
		let bestB = 0;
		let bestK = -1;
		for (let k = BIN_LO; k + ds <= BIN_HI; k++) {
			const a = this.binPeak(k);
			const b = this.binPeak(k + ds);
			let sc = Math.sqrt(a) + Math.sqrt(b);
			sc *= sc;
			// an idle line sends mark alone: prefer the pair that has the mark where it is strongest
			if ((this.rev ? b : a) >= (this.rev ? a : b)) sc *= 1.2;
			if (sc > best) [best, bestK, bestA, bestB] = [sc, k, a, b];
		}
		if (bestK < 0) return;
		const top = Math.max(bestA, bestB);
		const hasA = bestA > 0.15 * top;
		const hasB = bestB > 0.15 * top;
		const fa = this.centroid(bestK, fl);
		const fb = this.centroid(bestK + ds, fl);
		let lo: number;
		if (hasA && hasB) lo = 0.5 * (fa + (fb - this.shift));
		else if (hasA) lo = fa;
		else lo = fb - this.shift;
		const candRatio = best / fl;
		if (!this.locked) this.tryLock(lo, candRatio);
		else this.follow(lo, candRatio, fl, hasA && hasB);
	}

	/** A strong pair locks at once; a weak one once it has stayed on the same tones for LOCK_FRAMES frames. */
	private tryLock(lo: number, candRatio: number): void {
		if (candRatio >= LOCK_RATIO_WEAK && Math.abs(lo - this.candLo) <= 6) this.candFrames++;
		else if (candRatio >= LOCK_RATIO_WEAK) {
			this.candLo = lo;
			this.candFrames = 1;
		} else this.candFrames = 0;
		if (candRatio >= LOCK_RATIO || this.candFrames >= LOCK_FRAMES) {
			this.candFrames = 0;
			this.locked = true;
			this.loHz = lo;
			this.hiHz = lo + this.shift;
			this.weakFrames = this.relinkFrames = 0;
			this.clearDemod();
			this.setTones();
		}
	}

	/** Locked: how strong is the current pair; follow it, move to a much stronger one, or let go. */
	private follow(lo: number, candRatio: number, fl: number, both: boolean): void {
		const kl = Math.round(this.loHz / BIN_HZ);
		const kh = Math.round(this.hiHz / BIN_HZ);
		if (kl < BIN_LO - 1 || kh > BIN_HI + 1) {
			this.unlock();
			return;
		}
		let cur = Math.sqrt(this.binPeak(kl)) + Math.sqrt(this.binPeak(kh));
		cur = (cur * cur) / fl;
		this.ratio = cur;
		if (cur < UNLOCK_RATIO) {
			if (++this.weakFrames >= UNLOCK_FRAMES) {
				this.unlock();
				return;
			}
		} else this.weakFrames = 0;
		if (Math.abs(lo - this.loHz) <= 12) {
			this.relinkFrames = 0;
			if (both && cur >= UNLOCK_RATIO) {
				this.loHz += 0.1 * (lo - this.loHz);
				this.hiHz = this.loHz + this.shift;
				this.setTones();
			}
		} else if (candRatio > 2 * Math.max(cur, 1) && candRatio >= LOCK_RATIO) {
			if (this.relinkFrames > 0 && Math.abs(lo - this.relinkLo) > 12) this.relinkFrames = 0;
			this.relinkLo = lo;
			if (++this.relinkFrames >= RELINK_FRAMES) {
				this.loHz = lo;
				this.hiHz = lo + this.shift;
				this.weakFrames = this.relinkFrames = 0;
				this.clearDemod();
				this.setTones();
			}
		} else this.relinkFrames = 0;
	}

	// ------------------------------------------------------------------ characters
	private emit(c: number): void {
		if (c === FIGS_CODE) {
			this.figs = true;
			return;
		}
		if (c === LTRS_CODE) {
			this.figs = false;
			return;
		}
		const ch = this.figs ? FIGURES[c] : LETTERS[c];
		if (c === 4 && this.uns) this.figs = false;
		if (ch === '' || ch === '\r') return;
		this.text += ch;
		this.chars++;
		if (this.text.length > TEXT_MAX + 256) this.text = this.text.slice(this.text.length - TEXT_MAX);
		this.onChar?.(ch);
	}

	private sampleBit(x: number): void {
		const m = x > 0;
		this.soft += Math.min(1, Math.abs(x));
		if (this.bit === 0) {
			// start: must be space
			if (m) {
				this.fsm = 0;
				return;
			}
		} else if (this.bit <= 5) {
			if (m) this.code |= 1 << (this.bit - 1);
		} else {
			// stop: must be mark
			this.fsm = 0;
			const q = this.soft / 7;
			if (q < 0.3) return; // no signal behind these decisions (carrier gone, noise): not a framing error
			if (!m) {
				this.framingErrors++;
				return;
			}
			this.eye = 0.9 * this.eye + 0.1 * Math.min(1, q);
			this.lastCharAt = this.pos;
			this.emit(this.code);
			return;
		}
		this.bit++;
		this.cnt += this.bitSamples;
	}

	/** Mixes to zero at both tones and integrates over one bit; the ATC decision; the character framing. */
	private demod(v: number): void {
		const mr = this.phMr * this.stMr - this.phMi * this.stMi;
		this.phMi = this.phMr * this.stMi + this.phMi * this.stMr;
		this.phMr = mr;
		const sr = this.phSr * this.stSr - this.phSi * this.stSi;
		this.phSi = this.phSr * this.stSi + this.phSi * this.stSr;
		this.phSr = sr;
		if (++this.renorm >= 512) {
			this.renorm = 0;
			const am = Math.hypot(this.phMr, this.phMi);
			const as = Math.hypot(this.phSr, this.phSi);
			this.phMr /= am;
			this.phMi /= am;
			this.phSr /= as;
			this.phSi /= as;
		}
		const i = this.bIdx;
		const mi = v * this.phMr;
		const mq = v * this.phMi;
		const si = v * this.phSr;
		const sq = v * this.phSi;
		this.sMI += mi - this.bMI[i];
		this.bMI[i] = mi;
		this.sMQ += mq - this.bMQ[i];
		this.bMQ[i] = mq;
		this.sSI += si - this.bSI[i];
		this.bSI[i] = si;
		this.sSQ += sq - this.bSQ[i];
		this.bSQ[i] = sq;
		if (++this.bIdx >= this.len) this.bIdx = 0;
		const x = this.decision(Math.hypot(this.sMI, this.sMQ) / this.len, Math.hypot(this.sSI, this.sSQ) / this.len);
		const m = x > HYST ? true : x < -HYST ? false : this.mark;
		if (this.fsm === 0) {
			if (this.mark && !m) {
				this.fsm = 1;
				this.bit = this.code = 0;
				this.soft = 0;
				this.cnt = 0.5 * this.bitSamples;
			}
		} else if (--this.cnt <= 0) this.sampleBit(x);
		this.mark = m;
	}

	/**
	 * ATC: each tone against its own slowly decaying peak (the other tone's peak, scaled, as the floor: an idle line is
	 * mark alone). With the tones about as strong as each other the plain difference (scaled by their mean peak) is the
	 * better decision at weak signals; the per-tone ATC takes over when one tone has faded (peaks more than 3:1 apart).
	 */
	private decision(em: number, es: number): number {
		const dec = 1 - 1 / (0.6 * RTTY_RATE);
		this.maxM = Math.max(em, this.maxM * dec + em * (1 - dec));
		this.maxS = Math.max(es, this.maxS * dec + es * (1 - dec));
		const refM = Math.max(this.maxM, 0.3 * this.maxS, 1e-9);
		const refS = Math.max(this.maxS, 0.3 * this.maxM, 1e-9);
		const atc = Math.max(refM, refS) > ATC_RATIO * Math.min(refM, refS);
		return atc ? em / refM - es / refS : (2 * (em - es)) / (refM + refS);
	}
}
