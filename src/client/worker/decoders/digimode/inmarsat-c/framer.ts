// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/inmc/inmc_rx.cpp (Chan: symbol history, uwRows, uwCount, frameSync,
// decodeAt), https://github.com/adswill/OnAir; see third_party/onair. Changes: the decoded frame goes to a callback;
// the telemetry counters are fields of this class.
//
// Frames are found by their 128 unique word symbols (spread over the whole frame, two every 162 symbols), which also give
// the polarity; once the frame position is known, a polarity flip inside a frame (a cycle slip of the carrier loop) is
// repaired with the unique word.

import { COLS, FRAME_SYMS, ROWS, UW, decodeFrame, uwFit } from './code';
import type { InmcFrameEvent, InmcUwFit } from './types';

/** Wrong unique word symbols (of 128) allowed, as in the reference decoder. */
const UW_TOLERANCE = 30;
/** Symbol history: a power of two above the frame length plus the search window. */
const RING = 16384;

export class InmcFramer {
	private readonly soft = new Float32Array(RING);
	private readonly hard = new Uint8Array(RING);
	/** Symbols so far. */
	private sc = 0;
	tracking = false;
	private lastEnd = 0;
	private misses = 0;
	private best: InmcUwFit & { end: number } = { errors: 999, startRev: false, slipRow: ROWS, end: 0 };
	/** Frames found by their unique word, and the polarity slips repaired. */
	framesFound = 0;
	polaritySlips = 0;

	constructor(private readonly onFrame: (event: InmcFrameEvent) => void) {}

	reset(): void {
		this.soft.fill(0);
		this.hard.fill(0);
		this.sc = 0;
		this.tracking = false;
		this.lastEnd = this.misses = 0;
		this.best.errors = 999;
	}

	/** One soft symbol; `carrierLock`: a frame is searched for only while the carrier loop holds. */
	push(soft: number, carrierLock: boolean): void {
		const at = this.sc % RING;
		this.soft[at] = soft;
		this.hard[at] = soft > 0 ? 1 : 0;
		this.sc++;
		if (this.sc >= FRAME_SYMS) this.sync(carrierLock);
	}

	/** Wrong unique word symbols per row (against the normal polarity) of the frame ending at symbol `end`. */
	private uwRows(end: number): Uint8Array {
		const d = new Uint8Array(ROWS);
		const start = end - (FRAME_SYMS - 1);
		for (let r = 0; r < ROWS; r++) {
			const p = start + r * COLS;
			const u = UW[r];
			d[r] = Number(this.hard[p % RING] !== u) + Number(this.hard[(p + 1) % RING] !== u);
		}
		return d;
	}

	/** slipOk: also look for one polarity flip inside the frame; only while the frame position is known (a free search would let noise pass). */
	private uwCount(end: number, slipOk: boolean): InmcUwFit {
		const d = this.uwRows(end);
		if (slipOk) return uwFit(d);
		const e = d.reduce((a, b) => a + b, 0);
		return { errors: e > 64 ? 128 - e : e, startRev: e > 64, slipRow: ROWS };
	}

	private sync(carrierLock: boolean): void {
		const end = this.sc - 1;
		if (!this.tracking) {
			if (!carrierLock) return;
			const fit = this.uwCount(end, false);
			if (fit.errors <= UW_TOLERANCE) {
				this.tracking = true;
				this.misses = 0;
				this.decodeAt(end, fit);
				this.lastEnd = end;
				this.best.errors = 999;
			}
			return;
		}
		const expect = this.lastEnd + FRAME_SYMS;
		if (end < expect - 4) return;
		if (end <= expect + 4) {
			const fit = this.uwCount(end, true);
			if (fit.errors < this.best.errors) this.best = { ...fit, end };
			if (end < expect + 4) return;
		}
		// the window is complete
		if (this.best.errors <= UW_TOLERANCE) {
			this.decodeAt(this.best.end, this.best);
			this.lastEnd = this.best.end;
			this.misses = 0;
		} else {
			this.lastEnd = expect;
			if (++this.misses >= 3) this.tracking = false;
		}
		this.best = { errors: 999, startRev: false, slipRow: ROWS, end: 0 };
	}

	private decodeAt(end: number, fit: InmcUwFit): void {
		const buf = new Float32Array(FRAME_SYMS);
		const start = end - (FRAME_SYMS - 1);
		for (let i = 0; i < FRAME_SYMS; i++) {
			const flip = fit.startRev !== Math.floor(i / COLS) >= fit.slipRow;
			buf[i] = (flip ? -1 : 1) * this.soft[(start + i) % RING];
		}
		if (fit.slipRow < ROWS) this.polaritySlips++;
		this.framesFound++;
		this.onFrame({ decode: decodeFrame(buf), uwErrors: fit.errors, inverted: fit.startRev || fit.slipRow < ROWS, slipRow: fit.slipRow });
	}
}
