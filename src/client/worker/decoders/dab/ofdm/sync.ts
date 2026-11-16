// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/dab/dab_rx.cpp (searchSync: null symbol and phase reference
// search with the mirrored-spectrum retry and the quick re-acquisition; processFrame: timing refinement, sample clock
// tracking, fades and lost samples, the carrier offset from the cyclic prefixes), https://github.com/adswill/OnAir; see
// third_party/onair. Changes: the integer carrier search spans +-32 kHz instead of +-80 kHz (OnAir also covers L band;
// BrowSDR tunes Band III and centres the ensemble with its own DDC); no TII and no ChannelCentre.

import * as geometry from '@/worker/decoders/dab/constants';
import type { SampleBuffer } from './buffer';
import type { Spectrum } from './spectrum';
import type { Candidate, SearchResult, TrackResult } from './types';

// module-level copies of the imports used in the loops (see demod.ts)
const { FRAME, SYMBOLS, TG, TNULL, TS, TU } = geometry;

/** Integer carrier offset searched at the start (carrier spacings of 1 kHz). */
const MAX_SHIFT = 32;
/** Frames decoded on the timing and carrier offset held through a fade before the sync counts as lost (1.15 s). */
const COAST = 12;
/** A re-acquisition searches this many carriers around the offset known. */
const QUICK_SHIFT = 2;
/** The phase reference correlation peak (against the median) that counts as found. */
const FOUND = 25;
/** Below this the phase reference of a tracked frame counts as missing. */
const TRACKED = 12;
const NULL_WINDOW = 2048;
const BLOCK = 64;

/** Null-symbol and phase-reference synchronisation, timing and carrier tracking of transmission mode I. */
export class OfdmSync {
	locked = false;
	/** The input is conjugated (a mirrored spectrum). */
	mirror = false;
	/** Carrier offset in carrier spacings (1 kHz each). */
	cfo = 0;
	/** Predicted useful start of the next phase reference symbol (absolute sample). */
	nextU = 0;
	/** Useful start of the frame being decoded. */
	frameStart = 0;
	/** Just found: the first frame needs no refinement. */
	private fresh = false;
	/** Frames in a row without the phase reference. */
	missed = 0;
	/** Sample clock error (relative). */
	sro = 0;
	/** The fraction of a sample left by the last symStart. */
	rest = 0;
	/** The next search re-acquires: only near the carrier offset known, the decoding state is kept. */
	quick = false;
	private quickTries = 0;
	private searchNext = 0;
	private searchFails = 0;
	cirPeak = 0;
	/** Slow average of the differential cell magnitude over good frames: the scale of the soft bits. */
	magRef = 0;
	/** Mean sample power of the good frames: a frame far weaker than that is a fade, not a lost timing. */
	powRef = 0;
	syncLosses = 0;
	relocks = 0;
	private readonly pw = new Float64Array(Math.ceil((FRAME + TNULL) / BLOCK) + 1);
	private readonly top: Candidate[] = [0, 1, 2].map(() => ({ fast: 0, p: 0, sh: 0 }));

	constructor(
		private readonly buf: SampleBuffer,
		private readonly spec: Spectrum,
	) {}

	reset(): void {
		this.locked = false;
		this.mirror = false;
		this.cfo = 0;
		this.fresh = false;
		this.missed = 0;
		this.sro = 0;
		this.quick = false;
		this.quickTries = 0;
		this.searchNext = 0;
		this.searchFails = 0;
		this.magRef = 0;
		this.powRef = 0;
		this.cirPeak = 0;
	}

	/** Start of symbol l of the frame at U with the clock error; the fraction of a sample left goes to `rest`. */
	symStart(U: number, l: number): number {
		const x = l * TS * (1 + this.sro);
		const r = Math.round(x);
		this.rest = x - r;
		return U + r;
	}

	/** Mean sample power over the first `symbols` symbols of the frame at U (every 7th sample). */
	framePower(U: number, symbols = SYMBOLS - 1): number {
		return this.buf.power(U >= TG ? U - TG : 0, U + symbols * TS - TG);
	}

	// ------------------------------------------------------------ search

	search(): SearchResult {
		const buf = this.buf;
		const need = FRAME + TNULL + 4096 + TS;
		if (buf.length < need) return 'wait';
		// After a false null the next search waits a while: the phase reference search is the costly part.
		if (buf.end < this.searchNext) {
			buf.trim(buf.end - need);
			return 'wait';
		}
		const nullAt = this.findNull();
		if (nullAt < 0) {
			buf.trim(buf.end - FRAME);
			return 'none';
		}
		// the PRS useful part starts about 1832 samples after the centre of the quietest window
		const best = this.findReference(nullAt + NULL_WINDOW / 2 + 1832);
		if (best.peak < FOUND) return this.searchFailed();
		const U = buf.base + best.p + best.idx;
		this.cfo = best.sh;
		this.nextU = U;
		this.fresh = true;
		this.missed = 0;
		this.locked = true;
		this.searchFails = 0;
		this.searchNext = 0;
		if (this.quick) this.relocks++;
		this.quick = false;
		this.quickTries = 0;
		this.cirPeak = best.peak;
		buf.trim(U > 2 * TS ? U - 2 * TS : 0);
		return 'locked';
	}

	/** The quietest window of 2048 samples over one frame (its offset from the buffer start), -1 when none is a null. */
	private findNull(): number {
		const buf = this.buf,
			d = buf.data,
			pw = this.pw;
		const blocks = Math.floor((FRAME + TNULL) / BLOCK);
		let o = buf.offset(buf.base);
		for (let b = 0; b < blocks; b++) {
			let s = 0;
			for (let i = 0; i < BLOCK; i++, o += 2) s += d[o] * d[o] + d[o + 1] * d[o + 1];
			pw[b] = s;
		}
		const nb = NULL_WINDOW / BLOCK;
		let best = Infinity,
			bestPos = 0;
		for (let b = 0; b + nb <= FRAME / BLOCK; b += 2) {
			let s = 0;
			for (let i = 0; i < nb; i++) s += pw[b + i];
			if (s < best) {
				best = s;
				bestPos = b * BLOCK;
			}
		}
		let mean = 0;
		for (let b = 0; b < FRAME / BLOCK; b++) mean += pw[b];
		mean /= FRAME;
		return mean <= 1e-12 || best / NULL_WINDOW > 0.6 * mean ? -1 : bestPos;
	}

	/** The strongest phase reference correlation around `nominal`: the best few by the fast measure, measured again. */
	private findReference(nominal: number): { peak: number; p: number; sh: number; idx: number } {
		const buf = this.buf,
			spec = this.spec,
			top = this.top;
		for (const c of top) c.fast = 0;
		const centre = Math.round(this.cfo);
		const lo = this.quick ? centre - QUICK_SHIFT : -MAX_SHIFT;
		const hi = this.quick ? centre + QUICK_SHIFT : MAX_SHIFT;
		for (let p = nominal - 1400; p <= nominal + 1000; p += 128) {
			if (p < 0 || p + TU > buf.length) continue;
			spec.window(buf, buf.base + p, 0);
			for (let sh = lo; sh <= hi; sh++) {
				const f = spec.cirFast(sh);
				if (f <= top[2].fast) continue;
				top[2].fast = f;
				top[2].p = p;
				top[2].sh = sh;
				top.sort((a, b) => b.fast - a.fast);
			}
		}
		const best = { peak: 0, p: 0, sh: 0, idx: 0 };
		for (const c of top) {
			if (c.fast <= 0) continue;
			spec.window(buf, buf.base + c.p, 0);
			const pk = spec.cirOf(c.sh);
			if (pk > best.peak) Object.assign(best, { peak: pk, p: c.p, sh: c.sh, idx: spec.idx });
		}
		return best;
	}

	private searchFailed(): SearchResult {
		const buf = this.buf;
		if (this.quick && ++this.quickTries < 6) {
			// the signal may still be fading: look again near the same offset, the spectrum is not mirrored
			buf.trim(buf.end - FRAME);
			return 'none';
		}
		const restart = this.quick;
		this.quick = false;
		// no phase reference: the next attempt looks at the mirrored spectrum (I and Q swapped by the radio)
		this.mirror = !this.mirror;
		buf.conjugate();
		buf.trim(buf.end - FRAME);
		this.searchFails++;
		this.searchNext = buf.end + (FRAME / 2) * Math.min(this.searchFails, 6);
		return restart ? 'restart' : 'none';
	}

	// ------------------------------------------------------------ tracking

	/** Refines the timing of the next frame against its phase reference and measures the carrier offset. */
	track(): TrackResult {
		const buf = this.buf,
			spec = this.spec;
		if (buf.end < this.nextU + SYMBOLS * TS + TU + 256) return 'wait';
		if (this.nextU < buf.base + TG + 64) {
			this.locked = false;
			return 'lost';
		}
		let U = this.nextU;
		const wasFresh = this.fresh;
		if (this.fresh) {
			spec.window(buf, U, this.cfo);
			this.cirPeak = spec.cirOf(0);
			this.fresh = false;
		} else {
			// the window sits inside the guard interval
			const p = U - 64;
			spec.window(buf, p, this.cfo);
			this.cirPeak = spec.cirOf(0);
			if (this.cirPeak >= TRACKED) {
				const Un = p + spec.placeWindow(spec.mag, spec.idx);
				// the sample clock error, from how far the frame moved against the prediction (jumps between echoes left out)
				const e = Un - U;
				if (!this.missed && Math.abs(e) <= 48) this.sro = Math.max(-4e-4, Math.min(4e-4, this.sro + (0.25 * e) / FRAME));
				U = Un;
				this.missed = 0;
			} else if (this.lose(U)) return 'lost';
		}
		if (U - TG < buf.base) {
			this.locked = false;
			return 'lost';
		}
		this.cfo = this.prefixCfo(U, wasFresh);
		this.frameStart = U;
		return 'frame';
	}

	/**
	 * A frame without its phase reference. A fade (the frame far weaker than the good ones) keeps the timing and carrier
	 * offset and is decoded. A frame of normal strength means lost samples or a jump: the sync is found again at once,
	 * near the offset known. True when the sync is lost.
	 */
	private lose(U: number): boolean {
		this.missed++;
		const fade = this.powRef > 0 && this.framePower(U, 1) < 0.3 * this.powRef;
		if (fade && this.missed < COAST) return false;
		this.locked = false;
		this.quick = true;
		this.quickTries = 0;
		this.syncLosses++;
		this.buf.trim(U > FRAME / 2 + 2 * TS ? U - FRAME / 2 - 2 * TS : 0);
		return true;
	}

	/** The carrier offset from the cyclic prefixes of the whole frame, unwrapped around the previous value. */
	private prefixCfo(U: number, wasFresh: boolean): number {
		const d = this.buf.data;
		let ar = 0,
			ai = 0;
		for (let l = 0; l < SYMBOLS; l++) {
			const u = this.symStart(U, l);
			let a = this.buf.offset(u - TG),
				b = this.buf.offset(u + TU - TG);
			for (let i = 0; i < TG; i++, a += 2, b += 2) {
				ar += d[a] * d[b] + d[a + 1] * d[b + 1];
				ai += d[a] * d[b + 1] - d[a + 1] * d[b];
			}
		}
		const e = Math.atan2(ai, ar) / (2 * Math.PI);
		const diff = e - this.cfo;
		// held through a fade (the cyclic prefixes of noise say nothing)
		const nc = this.missed ? this.cfo : this.cfo + diff - Math.round(diff);
		if (!wasFresh) return nc;
		// The cyclic prefix only knows the offset modulo one carrier spacing: at n + 1/2 spacings both neighbours look
		// equally good in the search. The first frame after a lock picks the candidate with the sharpest phase reference.
		let best = nc,
			bestPk = -1;
		for (let k = -1; k <= 1; k++) {
			this.spec.window(this.buf, U, nc + k);
			const pk = this.spec.cirOf(0);
			if (pk > bestPk) {
				bestPk = pk;
				best = nc + k;
			}
		}
		return best;
	}

	/**
	 * The soft-bit and fade references from a frame with its phase reference: the soft bits are scaled by a slow average
	 * of the cell magnitude, so a faded frame gives weak soft bits instead of confident noise. Returns the scale to use.
	 */
	references(U: number, meanMag: number): number {
		if (!this.missed) {
			this.magRef = this.magRef > 0 ? 0.8 * this.magRef + 0.2 * meanMag : meanMag;
			const pw = this.framePower(U);
			this.powRef = this.powRef > 0 ? 0.8 * this.powRef + 0.2 * pw : pw;
		}
		return Math.max(meanMag, this.magRef);
	}

	/** After a decoded frame: where the next one starts. */
	advance(U: number): void {
		this.nextU = U + Math.round(FRAME * (1 + this.sro));
		// half a frame more is kept for a re-acquisition
		const keep = this.nextU - FRAME / 2 - 2 * TS;
		this.buf.trim(keep > 0 ? keep : 0);
	}
}
