// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/marine/marine_fax.cpp (FaxDecoder pulse detector and the chain
// of phasing pulses), https://github.com/adswill/OnAir; see third_party/onair. Changes: the detector returns the pulse
// instead of calling the state machine; the chain test is a function of its own.

import type { FaxPulse } from './types';

/**
 * Pulse detector: the white pulse of a phasing line seen as a rise and a fall of the smoothed f through the mid level;
 * the pulse centre is the line boundary. Crossing times are interpolated, so a clock error shows up as a drift.
 */
export class FaxEdges {
	private smL = 48;
	private sm = new Float64Array(48);
	private smI = 0;
	private smSum = 0;
	private prevSm = 0;
	private prevPos = 0;
	private hi = false;
	private upX = NaN;
	private dnX = NaN;
	private riseT = NaN;

	configure(fs: number): void {
		this.smL = Math.max(3, Math.round(0.004 * fs));
	}

	reset(): void {
		this.sm = new Float64Array(this.smL);
		this.smI = 0;
		this.smSum = this.prevSm = this.prevPos = 0;
		this.hi = false;
		this.upX = this.dnX = this.riseT = NaN;
	}

	/** The newest f (sample `nAud` - 1) against the mid level `mid`; a pulse when it has just ended. */
	step(f: number, nAud: number, mid: number): FaxPulse | null {
		this.smSum += f - this.sm[this.smI];
		this.sm[this.smI] = f;
		if (++this.smI === this.smL) this.smI = 0;
		if (nAud < this.smL) return null;
		const v = this.smSum / this.smL;
		const pos = nAud - 1 - (this.smL - 1) / 2;
		const hyst = 120;
		let pulse: FaxPulse | null = null;
		if (nAud > this.smL) {
			const cross = this.prevPos + ((mid - this.prevSm) / (v - this.prevSm)) * (pos - this.prevPos);
			if (!this.hi) {
				if (v > mid && this.prevSm <= mid) this.upX = cross;
				if (v > mid + hyst) {
					this.hi = true;
					this.riseT = this.upX;
				}
			} else {
				if (v < mid && this.prevSm >= mid) this.dnX = cross;
				if (v < mid - hyst) {
					this.hi = false;
					if (!Number.isNaN(this.riseT) && !Number.isNaN(this.dnX) && this.dnX > this.riseT)
						pulse = { c: 0.5 * (this.riseT + this.dnX), w: this.dnX - this.riseT };
					this.riseT = NaN;
				}
			}
		}
		this.prevSm = v;
		this.prevPos = pos;
		return pulse;
	}
}

/**
 * Whether pulse `p` continues the chain of equally spaced pulses with the right width; `plausible` judges the first
 * spacing (the line rate).
 */
export function continuesChain(chain: FaxPulse[], p: FaxPulse, plausible: (spacing: number) => boolean): boolean {
	if (!chain.length) return true;
	const first = chain[0];
	const last = chain[chain.length - 1];
	const sp = p.c - last.c;
	let ok: boolean;
	if (chain.length === 1) ok = plausible(sp);
	else {
		const ref = (last.c - first.c) / (chain.length - 1);
		ok = Math.abs(sp - ref) < 0.02 * ref;
	}
	if (!ok) return false;
	const fr = p.w / sp;
	return fr > 0.03 && fr < 0.08;
}
