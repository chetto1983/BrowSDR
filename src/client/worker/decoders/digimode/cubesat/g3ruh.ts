// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/include/dect2/packet/packet_demod.h (FskSlicer),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: NRZI is done here, before BrowSDR's HDLC layer.

import { Ax25Hdlc } from '@/worker/decoders/aprs/hdlc';

/**
 * Direct 2-FSK on the discriminator output (G3RUH 9600 baud, or another speed): slicer threshold from tracked
 * peaks, a clock that re-centres on level changes, the G3RUH descrambler (x^17 + x^12 + 1), NRZI, then HDLC.
 */
export class G3ruhSlicer {
	private hi = 0;
	private lo = 0;
	private ph = -0.5;
	private prevLevel = false;
	private sr = 0;
	private lastData = 0;
	private readonly hdlc: Ax25Hdlc;

	constructor(
		private readonly rate: number,
		readonly baud: number,
		onFrame: (frame: Uint8Array) => void,
		private readonly inertia = 0.7,
		private readonly inertiaLocked = 0.8,
	) {
		this.hdlc = new Ax25Hdlc(onFrame);
	}

	reset(): void {
		this.hi = this.lo = 0;
		this.ph = -0.5;
		this.prevLevel = false;
		this.sr = 0;
		this.lastData = 0;
		this.hdlc.reset();
	}

	/** Discriminator samples (any scale; the slicer follows the peaks). */
	process(samples: Float32Array): void {
		const step = this.baud / this.rate;
		for (const v of samples) {
			this.hi += (v > this.hi ? 0.25 : 0.0015) * (v - this.hi);
			this.lo += (v < this.lo ? 0.25 : 0.0015) * (v - this.lo);
			const level = v > 0.5 * (this.hi + this.lo);
			if (level !== this.prevLevel) this.ph *= this.hdlc.inFrame ? this.inertiaLocked : this.inertia;
			this.prevLevel = level;
			this.ph += step;
			if (this.ph < 0.5) continue;
			this.ph -= 1;
			const raw = level ? 1 : 0;
			const data = raw ^ ((this.sr >> 11) & 1) ^ ((this.sr >> 16) & 1);
			this.sr = ((this.sr << 1) | raw) & 0x1ffff;
			// NRZI: no change is a one.
			this.hdlc.bit(data === this.lastData ? 1 : 0);
			this.lastData = data;
		}
	}
}
