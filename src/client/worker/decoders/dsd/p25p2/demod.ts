// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/p25p2/p25p2_rx.cpp (P25p2Receiver::Impl: moveLo, recentre,
// specPush, specEvaluate, initFilter, sample, commitSync, takeDibit, unlock and the ISCH part of processBurst),
// https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the input is the complex channel of BrowSDR's DSD stream at 48 kHz (BrowSDR's DDC mixes, decimates and filters
// the channel), so OnAir's mixer, CIC decimator and windowed-sinc resampler are left out and only the carrier correction
// (afcHz) is mixed here; the root raised cosine filter reads a doubled history instead of a ring; 40-bit registers are two
// 32-bit halves. The ISCH (sync word, I-ISCH: the slot of the superframe and the logical channel) is read here with the
// burst primitives of protocol.ts and the burst handed on with them; a sync word on the grid of the lock is reported as the confirmation BrowSDR's DSD decoder
// waits for before it shows the mode.
//
// The channel is root raised cosine filtered and every sample phase is differentially demodulated in parallel; the
// 40-bit sync word (also giving the carrier offset and the SNR) picks the sample phase and frames the 180-dibit bursts.
// While not locked the sync search also runs at carrier offsets of +-600 Hz steps to +-2.4 kHz, and a coarse look at the
// spectrum moves a carrier further out towards the middle.
import { fft } from '@/worker/decoders/digimode/tones/dsp';
import { DSD_IF_RATE } from '@/worker/decoders/dsd/constants';
import {
	DIBIT_STEP,
	ISCH_DIBITS,
	P25P2_BURST_DIBITS as BURST_DIBITS,
	P25P2_SYNC,
	ROLL_OFF,
	SLOTS_PER_SUPERFRAME,
	SYMBOL_RATE,
	ischDecode,
	ischSync,
	ischSyncDistance,
	popcount32,
	rrcImpulse,
	slotChannel,
} from './protocol';
import type { P25p2BurstSink, P25p2Counters } from './types';

/** Working rate: 8 samples per symbol. */
const FS = DSD_IF_RATE;
const SPS = 8;
/** The root raised cosine matched filter, +-4 symbols. */
const TAPS = 65;
const RING = 256;
const RMASK = RING - 1;
/** Bit errors allowed in the 40-bit sync word. */
const SYNC_MAX = 4;
/**
 * Carrier acquisition. The differential demodulator slices at +-pi/2 and pi: a carrier more than about 700 Hz off is read
 * as other dibits. While not locked the sync search therefore also runs at HYP offsets either side in steps of HYP_HZ (with
 * the stricter SYNC_MAX_HYP bit errors); the offset that finds the sync is then taken out at the front end (afcHz).
 */
const HYP = 4;
const HYP_HZ = 600;
const SYNC_MAX_HYP = 2;
const HYP_STEP = (2 * Math.PI * HYP_HZ) / SYMBOL_RATE;
const MAX_AFC_HZ = 7500;
/** Coarse carrier search by spectrum (the differential detector sees offsets modulo 6 kHz). */
const SPEC_N = 1024;
const SPEC_BLOCKS = 8;
const SPEC_WINDOW = Float64Array.from({ length: SPEC_N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / SPEC_N));
/** No sync word for two superframes: the lock is lost. */
const LOST_DIBITS = 2 * SLOTS_PER_SUPERFRAME * BURST_DIBITS;
const BURST_SAMPLES = BURST_DIBITS * SPS;
const SYNC_HI = Number(P25P2_SYNC >> 32n);
const SYNC_LO = Number(P25P2_SYNC & 0xffffffffn) | 0;
/** The phase step of each sync dibit (rad). */
const SYNC_STEPS = Float64Array.from(
	{ length: ISCH_DIBITS },
	(_, k) => (DIBIT_STEP[Number((P25P2_SYNC >> BigInt(38 - 2 * k)) & 3n)] * Math.PI) / 4,
);
const HALF_PI = Math.PI / 2;

function wrapPi(a: number): number {
	while (a > Math.PI) a -= 2 * Math.PI;
	while (a < -Math.PI) a += 2 * Math.PI;
	return a;
}

/** The dibit of a differential phase step: +3pi/4 01, +pi/4 00, -pi/4 10, -3pi/4 11. */
function slice(a: number): number {
	return a >= HALF_PI ? 1 : a >= 0 ? 0 : a >= -HALF_PI ? 2 : 3;
}

function rrcTaps(): Float32Array {
	const h = Float64Array.from({ length: TAPS }, (_, k) => rrcImpulse((k - (TAPS >> 1)) / SPS, ROLL_OFF));
	const sum = h.reduce((a, v) => a + v, 0);
	return Float32Array.from(h, (v) => v / sum);
}

/** H-DQPSK demodulator, sync search, symbol clock and burst framing of a P25 Phase 2 channel. */
export class P25p2Demod {
	private readonly h = rrcTaps();
	private zRe = new Float32Array(2 * TAPS);
	private zIm = new Float32Array(2 * TAPS);
	private zPos = 0;
	private yRe = new Float32Array(RING);
	private yIm = new Float32Array(RING);
	private angr = new Float32Array(RING);
	/** 40-bit registers of the 2 HYP + 1 carrier hypotheses (HYP: none) times 8 sample phases, top 8 and low 32 bits. */
	private regHi = new Int32Array((2 * HYP + 1) * SPS);
	private regLo = new Int32Array((2 * HYP + 1) * SPS);
	/** 48 kHz sample count. */
	private n = 0;
	/** Carrier offset still left after the front end's own move (rad per symbol). */
	private cfoStep = 0;
	private afcHz = 0;
	private loRe = 1;
	private loIm = 0;
	private stepRe = 1;
	private stepIm = 0;
	private loCount = 0;
	private specRe = new Float64Array(SPEC_N);
	private specIm = new Float64Array(SPEC_N);
	private specLen = 0;
	private specPow = new Float64Array(SPEC_N);
	private specBlocks = 0;
	/** The first look at the spectrum is done (the sync search at other offsets waits for it). */
	private specReady = false;
	private coarseHz = 0;
	private coarseAt = -1e9;
	private coarseOffUntil = -1e9;
	private win = false;
	private winHyp = 0;
	private winStart = 0;
	private winDist = new Int32Array(SPS);
	/** The lock: bursts of 180 dibits from the sync word on. */
	locked = false;
	private nextDibitN = 0;
	/** A sample at which a sync word ends, modulo one burst. */
	private syncEndPred = 0;
	private pendingShift = 0;
	/** An I-ISCH has said where in the superframe the lock is; until then the slot is a guess. */
	private slotKnown = false;
	/** The slot of the superframe (0..11) the burst being received is taken to be. */
	private slotIdx = 0;
	private slotPos = 0;
	private dibSinceSync = 0;
	private buf = new Uint8Array(BURST_DIBITS);
	private lastSync = -10;
	snrDb = 0;
	slotNow = -1;

	constructor(
		private sink: P25p2BurstSink,
		private counters: P25p2Counters,
	) {}

	/** Signal time (s). */
	get seconds(): number {
		return this.n / FS;
	}

	get cfoHz(): number {
		return (this.cfoStep * SYMBOL_RATE) / (2 * Math.PI) + this.afcHz;
	}

	reset(): void {
		this.zRe.fill(0);
		this.zIm.fill(0);
		this.zPos = 0;
		this.yRe.fill(0);
		this.yIm.fill(0);
		this.angr.fill(0);
		this.regHi.fill(0);
		this.regLo.fill(0);
		this.n = 0;
		this.cfoStep = 0;
		this.afcHz = 0;
		[this.loRe, this.loIm, this.stepRe, this.stepIm, this.loCount] = [1, 0, 1, 0, 0];
		this.specLen = 0;
		this.specPow.fill(0);
		this.specBlocks = 0;
		this.specReady = false;
		this.coarseHz = 0;
		this.coarseAt = this.coarseOffUntil = -1e9;
		this.win = false;
		this.winHyp = 0;
		this.locked = false;
		this.slotKnown = false;
		this.slotIdx = this.slotPos = this.dibSinceSync = 0;
		this.lastSync = -10;
		this.snrDb = 0;
		this.slotNow = -1;
	}

	/** Interleaved I/Q at 48 kHz. */
	process(iq: Float32Array): void {
		for (let i = 0; i + 1 < iq.length; i += 2) {
			let re = iq[i];
			let im = iq[i + 1];
			if (!Number.isFinite(re) || !Number.isFinite(im)) re = im = 0;
			if (this.afcHz !== 0) {
				const r = re * this.loRe - im * this.loIm;
				im = re * this.loIm + im * this.loRe;
				re = r;
				const lr = this.loRe * this.stepRe - this.loIm * this.stepIm;
				this.loIm = this.loRe * this.stepIm + this.loIm * this.stepRe;
				this.loRe = lr;
				if (++this.loCount >= 4096) {
					const m = Math.hypot(this.loRe, this.loIm);
					this.loRe /= m;
					this.loIm /= m;
					this.loCount = 0;
				}
			}
			this.sample(re, im);
		}
	}

	private moveLo(hz: number): void {
		if (Math.abs(this.afcHz + hz) > MAX_AFC_HZ) return;
		this.afcHz += hz;
		const w = (-2 * Math.PI * this.afcHz) / FS;
		this.stepRe = Math.cos(w);
		this.stepIm = Math.sin(w);
	}

	/** The whole carrier offset (cfoStep) moves into the front end. */
	private recentre(): void {
		const hz = (this.cfoStep * SYMBOL_RATE) / (2 * Math.PI);
		if (Math.abs(hz) < 150) return;
		const before = this.afcHz;
		this.moveLo(hz);
		if (this.afcHz !== before) this.cfoStep = 0;
	}

	private sample(re: number, im: number): void {
		this.specPush(re, im);
		const p = this.zPos;
		const { zRe, zIm, h } = this;
		zRe[p] = zRe[p + TAPS] = re;
		zIm[p] = zIm[p + TAPS] = im;
		this.zPos = p + 1 === TAPS ? 0 : p + 1;
		let yr = 0;
		let yi = 0;
		for (let k = 0; k < TAPS; k++) {
			yr += zRe[p + 1 + k] * h[k];
			yi += zIm[p + 1 + k] * h[k];
		}
		const n = this.n;
		const ri = n & RMASK;
		this.yRe[ri] = yr;
		this.yIm[ri] = yi;
		if (n >= SPS) {
			const pi = (n - SPS) & RMASK;
			const pr = this.yRe[pi];
			const pq = this.yIm[pi];
			const ang = Math.atan2(yi * pr - yr * pq, yr * pr + yi * pq);
			this.angr[ri] = ang;
			const dib = slice(wrapPi(ang - this.cfoStep));
			const ph = n & 7;
			this.search(HYP * SPS + ph, dib, 0, SYNC_MAX);
			if (!this.locked && this.specReady) this.searchOffsets(ang, ph);
			if (this.win && n >= this.winStart + SPS - 1) {
				this.commitSync();
				this.win = false;
			}
			if (this.locked && n === this.nextDibitN) {
				this.nextDibitN += SPS;
				this.takeDibit(dib);
			}
		}
		this.n = n + 1;
	}

	/** Shift a dibit into register idx and open (or fill) the sync window of hypothesis hyp. */
	private search(idx: number, dib: number, hyp: number, max: number): void {
		const hi = ((this.regHi[idx] << 2) | (this.regLo[idx] >>> 30)) & 0xff;
		const lo = (this.regLo[idx] << 2) | dib;
		this.regHi[idx] = hi;
		this.regLo[idx] = lo;
		const dist = popcount32(hi ^ SYNC_HI) + popcount32(lo ^ SYNC_LO);
		if (this.win) {
			if (this.winHyp === hyp) this.winDist[this.n - this.winStart] = dist;
		} else if (dist <= max) {
			this.win = true;
			this.winHyp = hyp;
			this.winStart = this.n;
			this.winDist.fill(99);
			this.winDist[0] = dist;
		}
	}

	/** The search at the other carrier offsets. */
	private searchOffsets(ang: number, ph: number): void {
		for (let hyp = -HYP; hyp <= HYP; hyp++) {
			if (hyp === 0) continue;
			const dib = slice(wrapPi(ang - (this.cfoStep + hyp * HYP_STEP)));
			this.search((hyp + HYP) * SPS + ph, dib, hyp, SYNC_MAX_HYP);
		}
	}

	/** The sync was seen between winStart and winStart + 7: the sample whose 20 residuals are the most alike is the symbol centre. */
	private bestPhase(): { at: number; vari: number; mean: number } | null {
		let best: { at: number; vari: number; mean: number } | null = null;
		const res = new Float64Array(ISCH_DIBITS);
		for (let j = 0; j < SPS; j++) {
			if (this.winDist[j] > SYNC_MAX) continue;
			const m = this.winStart + j;
			let sx = 0;
			let sy = 0;
			for (let k = 0; k < ISCH_DIBITS; k++) {
				res[k] = wrapPi(this.angr[(m - SPS * (ISCH_DIBITS - 1 - k)) & RMASK] - SYNC_STEPS[k]);
				sx += Math.cos(res[k]);
				sy += Math.sin(res[k]);
			}
			const mean = Math.atan2(sy, sx);
			let vari = 0;
			for (let k = 0; k < ISCH_DIBITS; k++) vari += wrapPi(res[k] - mean) ** 2;
			vari /= ISCH_DIBITS;
			if (!best || vari < best.vari) best = { at: m, vari, mean };
		}
		return best;
	}

	private commitSync(): void {
		const best = this.bestPhase();
		if (!best) return;
		let { mean } = best;
		// a carrier more than 3 kHz off turns more than half a circle a symbol: the residual angle only says the offset
		// modulo 6 kHz, the search offset that found the sync says which
		if (!this.locked && this.winHyp !== 0) {
			const ref = this.cfoStep + this.winHyp * HYP_STEP;
			mean = ref + wrapPi(mean - ref);
		}
		this.counters.syncs++;
		this.lastSync = this.seconds;
		this.coarseHz = 0;
		const snr = 10 * Math.log10(1 / Math.max(1e-4, best.vari));
		this.snrDb = this.snrDb === 0 ? snr : this.snrDb + 0.3 * (snr - this.snrDb);
		if (this.locked) {
			let shift = (((best.at - this.syncEndPred) % BURST_SAMPLES) + BURST_SAMPLES) % BURST_SAMPLES;
			if (shift > BURST_SAMPLES / 2) shift -= BURST_SAMPLES;
			if (Math.abs(shift) <= 3) {
				this.pendingShift += shift; // the symbol clock follows the sync, from the next burst on
				this.syncEndPred += shift;
				this.cfoStep += 0.5 * wrapPi(mean - this.cfoStep);
				if (Math.abs(this.cfoStep) > 0.2 * Math.PI) this.recentre(); // more than about 600 Hz drifted: back to the front end
				this.dibSinceSync = 0;
				this.sink.synced();
				return;
			}
			// a sync word off the burst boundary: the demodulator slipped and every burst since is misframed. Only an exact
			// one re-frames a running lock (a chance match in the payload is 2^-40 per position).
			if (this.winDist[best.at - this.winStart] !== 0) return;
			this.counters.realigns++;
			this.slotKnown = false;
		} else {
			this.cfoStep = mean;
			this.recentre();
		}
		this.locked = true;
		this.dibSinceSync = 0;
		this.slotPos = ISCH_DIBITS; // the slot counter runs on: the I-ISCH puts it right
		ischSync(this.buf);
		this.syncEndPred = best.at;
		this.pendingShift = 0;
		this.nextDibitN = best.at + SPS;
	}

	private takeDibit(dib: number): void {
		this.buf[this.slotPos++] = dib;
		this.dibSinceSync++;
		if (this.slotPos < BURST_DIBITS) return;
		this.processBurst();
		this.slotIdx = (this.slotIdx + 1) % SLOTS_PER_SUPERFRAME;
		this.slotPos = 0;
		this.nextDibitN += this.pendingShift;
		this.pendingShift = 0;
		if (this.dibSinceSync > LOST_DIBITS) this.unlock();
	}

	private unlock(): void {
		this.locked = false;
		this.counters.unlocks++;
		this.slotPos = 0;
		this.slotKnown = false;
	}

	/** The ISCH: the sync word (S-ISCH) or the I-ISCH with the logical channel and where in the superframe the burst is. */
	private processBurst(): void {
		const c = this.counters;
		c.slots++;
		let ch = slotChannel(this.slotIdx);
		if (ischSyncDistance(this.buf) > SYNC_MAX) {
			const isch = ischDecode(this.buf);
			if (!isch) c.ischBad++;
			else {
				if (isch.errors) c.ischCorrected++;
				else c.ischExact++;
				// I-ISCH in slots 0, 1 (location 0), 4, 5 (1) and 8, 9 (2), the channel bit giving the slot of the pair; the
				// sync word in the others
				if (isch.location < 3) {
					this.slotIdx = 4 * isch.location + (isch.channel & 1);
					this.slotKnown = true;
				}
				ch = isch.channel & 1;
			}
		}
		// the first burst(s) after a lock carry the sync word or an I-ISCH not yet read; the descrambler and the logical
		// channel depend on the slot, so a burst whose slot is a guess is dropped rather than read as garbage on a wrong slot
		if (!this.slotKnown) {
			c.slotsSkipped++;
			return;
		}
		this.slotNow = this.slotIdx;
		this.sink.burst(this.buf, this.slotIdx, ch);
	}

	private specPush(re: number, im: number): void {
		const w = SPEC_WINDOW[this.specLen];
		this.specRe[this.specLen] = re * w;
		this.specIm[this.specLen] = im * w;
		if (++this.specLen < SPEC_N) return;
		this.specLen = 0;
		fft(this.specRe, this.specIm);
		for (let i = 0; i < SPEC_N; i++) this.specPow[i] += this.specRe[i] ** 2 + this.specIm[i] ** 2;
		if (++this.specBlocks < SPEC_BLOCKS) return;
		this.specBlocks = 0;
		this.specEvaluate();
		this.specPow.fill(0);
	}

	private specEvaluate(): void {
		this.specReady = true;
		const now = this.seconds;
		if (!this.locked && this.coarseHz !== 0 && now - this.coarseAt > 1.5) {
			// moved, and still no sync: that was noise or a stray carrier; back
			this.moveLo(-this.coarseHz);
			this.coarseHz = 0;
			this.coarseOffUntil = now + 6;
			return;
		}
		if (!this.locked && (now - this.lastSync < 1 || now < this.coarseOffUntil || this.coarseHz !== 0)) return;
		const hz = this.specCentre();
		if (hz === null) return;
		const before = this.afcHz;
		if (this.locked) {
			// a lock on an alias (the detector sees offsets modulo 6 kHz): the power says the carrier is somewhere else
			if (Math.abs(hz) <= 2800) return;
			this.moveLo(hz);
			if (this.afcHz === before) return;
			this.unlock();
			this.counters.unlocks--;
		} else {
			if (Math.abs(hz) <= 1800) return;
			this.moveLo(hz);
			if (this.afcHz === before) return;
		}
		this.coarseHz = hz;
		this.coarseAt = now;
	}

	/** Where the signal's power sits (Hz), null when there is no clear signal. */
	private specCentre(): number | null {
		const pow = this.specPow;
		const N = SPEC_N;
		const hw = 64; // +-3 kHz: where most of the signal's power is
		let bestE = 0;
		let bestC = 0;
		let e = 0;
		for (let k = -hw; k <= hw; k++) e += pow[(k + N) % N];
		for (let c = 0; c < N; c++) {
			if (c) e += pow[(c + hw) % N] - pow[(c - hw - 1 + N) % N];
			if (e > bestE) {
				bestE = e;
				bestC = c;
			}
		}
		// the rest of the channel filter's passband (+-6 kHz) is the reference: noise there is as high as inside the window
		let refSum = 0;
		let refN = 0;
		for (let k = -128; k <= 128; k++) {
			const bin = ((k % N) + N) % N;
			const d = Math.abs(((((bin - bestC + N / 2) % N) + N) % N) - N / 2);
			if (d <= hw) continue;
			refSum += pow[bin];
			refN++;
		}
		if (refN < 20 || bestE < 3 * (refSum / refN) * (2 * hw + 1)) return null;
		const ref = refSum / refN;
		let sw = 0;
		let sf = 0;
		for (let k = -hw; k <= hw; k++) {
			const w = Math.max(0, pow[(((bestC + k) % N) + N) % N] - ref);
			sw += w;
			sf += w * k;
		}
		if (sw <= 0) return null;
		const ctr = ((((bestC + Math.round(sf / sw) + N / 2) % N) + N) % N) - N / 2;
		return (ctr * FS) / N;
	}
}
