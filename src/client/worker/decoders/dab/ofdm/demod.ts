// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/dab/dab_rx.cpp (processFrame: DQPSK differential cells with the
// sample clock slope turned out, the common phase error, the soft bits scaled by the slow magnitude reference, the SNR
// from the phase scatter), https://github.com/adswill/OnAir; see third_party/onair. Changes: the soft bits come from
// differential detection only; OnAir's coherent soft bits from a channel estimate (channelSoft) are not ported, which
// costs about 3 dB of sensitivity but halves the FFTs per frame. The cells are kept in Float32Arrays, nothing is
// allocated per frame.

import * as geometry from '@/worker/decoders/dab/constants';
import type { SampleBuffer } from './buffer';
import type { OfdmSync } from './sync';
import { BACKOFF, type Spectrum } from './spectrum';
import * as tables from './tables';

// Module-level copies of the imports used in the loops: a bundler inlines imported bindings, other module loaders
// (vite-node in the tests) read them through an accessor on every access.
const { CARRIERS, FIC_SYMBOLS, SYMBOL_BITS, SYMBOLS, TU } = geometry;
const { CARRIER_BIN, FREQ_INTERLEAVER } = tables;
const DATA_SYMBOLS = SYMBOLS - 1;
const HALF = CARRIERS / 2;

/** DQPSK demodulation of one transmission frame into soft bits (positive = bit 1). */
export class FrameDemod {
	/** Soft bits of the 3 FIC symbols. */
	readonly fic = new Int8Array(FIC_SYMBOLS * SYMBOL_BITS);
	/** Soft bits of the 72 MSC symbols (4 CIFs). */
	readonly msc = new Int8Array((DATA_SYMBOLS - FIC_SYMBOLS) * SYMBOL_BITS);
	/** Differential cells of symbols 1..75, carrier n of symbol l at (l - 1) * CARRIERS + n. */
	private readonly qr = new Float32Array(DATA_SYMBOLS * CARRIERS);
	private readonly qi = new Float32Array(DATA_SYMBOLS * CARRIERS);
	private pr = new Float32Array(CARRIERS);
	private pi = new Float32Array(CARRIERS);
	private cr = new Float32Array(CARRIERS);
	private ci = new Float32Array(CARRIERS);
	private readonly rotR = new Float32Array(CARRIERS + 1);
	private readonly rotI = new Float32Array(CARRIERS + 1);
	meanMag = 0;
	snrDb = 0;

	/** Demodulates the frame whose phase reference starts at U: the differential cells and their mean magnitude. */
	demodulate(buf: SampleBuffer, spec: Spectrum, sync: OfdmSync, U: number): void {
		spec.window(buf, U - BACKOFF, sync.cfo);
		this.carriers(spec, this.pr, this.pi);
		let magSum = 0,
			restPrev = 0;
		for (let l = 1; l < SYMBOLS; l++) {
			const start = sync.symStart(U, l);
			const rest = sync.rest;
			spec.window(buf, start - BACKOFF, sync.cfo);
			this.carriers(spec, this.cr, this.ci);
			// With a sample clock error the fraction of a sample left between two symbols is a phase slope across the carriers
			const dr = rest - restPrev;
			restPrev = rest;
			const turn = Math.abs(dr) > 1e-4;
			if (turn) this.slope(dr);
			magSum += this.cells(l, turn);
			this.commonPhase(l);
			let t = this.pr;
			this.pr = this.cr;
			this.cr = t;
			t = this.pi;
			this.pi = this.ci;
			this.ci = t;
		}
		this.meanMag = magSum / (DATA_SYMBOLS * CARRIERS) + 1e-12;
	}

	private carriers(spec: Spectrum, re: Float32Array, im: Float32Array): void {
		const sr = spec.re,
			si = spec.im;
		for (let n = 0; n < CARRIERS; n++) {
			const k = CARRIER_BIN[n];
			re[n] = sr[k];
			im[n] = si[k];
		}
	}

	/** exp(j 2 pi k dr / TU) for the carriers k = -768..768. */
	private slope(dr: number): void {
		const sr = Math.cos((2 * Math.PI * dr) / TU),
			si = Math.sin((2 * Math.PI * dr) / TU);
		let zr = Math.cos((-2 * Math.PI * dr * HALF) / TU),
			zi = Math.sin((-2 * Math.PI * dr * HALF) / TU);
		for (let i = 0; i <= CARRIERS; i++) {
			this.rotR[i] = zr;
			this.rotI[i] = zi;
			const t = zr * sr - zi * si;
			zi = zr * si + zi * sr;
			zr = t;
		}
	}

	/** The cells of symbol l: this symbol times the conjugate of the one before. Returns the sum of their magnitudes. */
	private cells(l: number, turn: boolean): number {
		const qr = this.qr,
			qi = this.qi,
			pr = this.pr,
			pi = this.pi,
			cr = this.cr,
			ci = this.ci;
		const o = (l - 1) * CARRIERS;
		let sum = 0;
		for (let n = 0; n < CARRIERS; n++) {
			let a = cr[n] * pr[n] + ci[n] * pi[n];
			let b = ci[n] * pr[n] - cr[n] * pi[n];
			if (turn) {
				const k = FREQ_INTERLEAVER[n] + HALF;
				const rr = this.rotR[k],
					ri = this.rotI[k];
				const t = a * rr - b * ri;
				b = a * ri + b * rr;
				a = t;
			}
			qr[o + n] = a;
			qi[o + n] = b;
			sum += Math.sqrt(a * a + b * b);
		}
		return sum;
	}

	/**
	 * Common phase error: oscillator phase noise turns all carriers of a symbol alike. The turn is measured from the
	 * fourth power of the cells (the DQPSK points sit at odd multiples of 45 degrees) and taken out.
	 */
	private commonPhase(l: number): void {
		const qr = this.qr,
			qi = this.qi;
		const o = (l - 1) * CARRIERS;
		let sr = 0,
			si = 0,
			m2s = 0;
		for (let n = o; n < o + CARRIERS; n++) {
			const a = qr[n],
				b = qi[n];
			const m2 = a * a + b * b;
			if (m2 <= 0) continue;
			const zr = a * a - b * b,
				zi = 2 * a * b;
			sr += (zr * zr - zi * zi) / m2;
			si += (2 * zr * zi) / m2;
			m2s += m2;
		}
		// only where there is a signal (noise alone gives about 0.03)
		if (Math.sqrt(sr * sr + si * si) <= 0.1 * m2s) return;
		const err = Math.atan2(-si, -sr) / 4;
		const c = Math.cos(err),
			s = -Math.sin(err);
		for (let n = o; n < o + CARRIERS; n++) {
			const a = qr[n],
				b = qi[n];
			qr[n] = a * c - b * s;
			qi[n] = a * s + b * c;
		}
	}

	/** The soft bits of every data symbol, scaled by 40 / `scale` (first half real parts, second half imaginary). */
	soft(scale: number): void {
		const sc = 40 / scale;
		for (let l = 1; l < SYMBOLS; l++) {
			const fic = l <= FIC_SYMBOLS;
			this.softSymbol(fic ? this.fic : this.msc, (fic ? l - 1 : l - FIC_SYMBOLS - 1) * SYMBOL_BITS, (l - 1) * CARRIERS, sc);
		}
	}

	/** One symbol's soft bits: rounded and clipped to +-127 without branches (the signs are random). */
	private softSymbol(dst: Int8Array, at: number, o: number, sc: number): void {
		const qr = this.qr,
			qi = this.qi;
		for (let n = 0; n < CARRIERS; n++) {
			const a = Math.max(-127, Math.min(127, -qr[o + n] * sc)),
				b = Math.max(-127, Math.min(127, -qi[o + n] * sc));
			// Math.round of a value in -127..127: floor(v + 0.5), taken on the positive side
			dst[at + n] = ((a + 128.5) | 0) - 128;
			dst[at + CARRIERS + n] = ((b + 128.5) | 0) - 128;
		}
	}

	/** Quality: the phase scatter of the differential cells of symbols 10..13 around the nearest odd multiple of 45 degrees. */
	measureSnr(): void {
		let err2 = 0,
			cnt = 0;
		for (let n = 9 * CARRIERS; n < 13 * CARRIERS; n++) {
			const a = this.qr[n],
				b = this.qi[n];
			const zr = a * a - b * b,
				zi = 2 * a * b;
			const ph = Math.atan2(-(2 * zr * zi), -(zr * zr - zi * zi)) / 4;
			err2 += ph * ph;
			cnt++;
		}
		this.snrDb = -10 * Math.log10(Math.max(1e-3, err2 / cnt));
	}
}
