// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/hfdig/hfdig_sstv.cpp (idleStep, decodeVis, pulseLog),
// https://github.com/adswill/OnAir; see third_party/onair.
//
// A state machine on the 4 ms mean frequency looks for the VIS header: leader 1900 Hz, break 1200 Hz (10 ms), leader,
// start bit 1200 Hz, seven data bits (1100 Hz = 1, 1300 Hz = 0, least significant first), even parity, stop bit,
// 30 ms each. At the same time the 1200 Hz pulses are logged: five pulses at the line period of a known mode start
// that mode without a VIS header.

import { SSTV_MODES } from './modes';
import type { SstvStart, VisState } from './types';
import { BOX, CENTER_HZ, MS, type PhaseFront } from './phase';

export class VisHunter {
	private state: VisState = 'idle';
	private leadCount = 0;
	private trans = 0;
	private leadSum = 0;
	private leadMean = CENTER_HZ;
	private edge1 = 0;
	private edge2 = 0;
	private edge3 = 0;
	private inPulse = false;
	private runStart = 0;
	private events: number[] = [];

	constructor(
		private readonly front: PhaseFront,
		private readonly start: SstvStart,
	) {}

	reset(): void {
		this.state = 'idle';
		this.leadCount = this.trans = 0;
		this.leadSum = 0;
		this.leadMean = CENTER_HZ;
		this.inPulse = false;
		this.events = [];
	}

	/** One step at the newest sample (index front.n - 1). */
	step(): void {
		const i = this.front.n - 1;
		const fb = this.front.boxF(i);
		this.pulseLog(i, fb);
		const dev = fb - this.leadMean;
		if (this.state === 'idle') this.idle(fb);
		else if (this.state === 'lead1') this.lead1(i, fb, dev);
		else if (this.state === 'break') this.breakTone(i, dev);
		else if (this.state === 'lead2') this.lead2(i, dev);
		else if (i >= this.edge3 + 300 * MS + 8) {
			this.decodeVis();
			if (this.state === 'bits') this.reset();
		}
		if (this.state === 'idle' && this.leadCount === 0) this.leadMean = CENTER_HZ;
	}

	private followLeader(fb: number): void {
		this.leadCount++;
		this.leadSum += fb;
		this.leadMean = this.leadSum / this.leadCount;
	}

	private idle(fb: number): void {
		if (Math.abs(fb - CENTER_HZ) < 130) this.followLeader(fb);
		else {
			this.leadCount = 0;
			this.leadSum = 0;
			this.leadMean = CENTER_HZ;
		}
		if (this.leadCount >= 800) {
			this.state = 'lead1';
			this.trans = 0;
		}
	}

	private lead1(i: number, fb: number, dev: number): void {
		if (Math.abs(dev) < 130) {
			this.trans = 0;
			this.followLeader(fb);
		} else if (dev < -350) {
			this.edge1 = i - BOX / 2;
			this.state = 'break';
		} else if (dev < -130) {
			if (++this.trans > 48) this.state = 'idle';
		} else this.state = 'idle';
	}

	private breakTone(i: number, dev: number): void {
		if (dev > -350) {
			this.edge2 = i - BOX / 2;
			const d = this.edge2 - this.edge1;
			this.state = d >= 7 * MS && d <= 13 * MS ? 'lead2' : 'idle';
			this.trans = 0;
		} else if (i - this.edge1 > 16 * MS) this.state = 'idle';
	}

	private lead2(i: number, dev: number): void {
		const since = i - this.edge2;
		if (since < 40) return; // the box is still on the rising edge
		if (Math.abs(dev) < 130) this.trans = 0;
		else if (dev < -350 && since > 120 * MS) {
			this.edge3 = i - BOX / 2;
			this.state = this.edge3 - this.edge2 <= 600 * MS ? 'bits' : 'idle';
		} else if (dev < -130 && since > 120 * MS) {
			if (++this.trans > 48) this.state = 'idle';
		} else this.state = 'idle';
		if (since > 700 * MS) this.state = 'idle';
	}

	private decodeVis(): void {
		const off = this.leadMean - CENTER_HZ;
		let code = 0;
		let ones = 0;
		for (let j = 0; j < 9; j++) {
			const f = this.front.meanF(this.edge3 + (30 * j + 6) * MS, this.edge3 + (30 * j + 24) * MS);
			if (j === 0) {
				if (Math.abs(f - (1200 + off)) > 110) return;
				continue;
			}
			const bit = f < 1200 + off ? 1 : 0;
			ones += bit;
			if (j <= 7) code |= bit << (j - 1);
		}
		if (ones & 1) return;
		const spec = SSTV_MODES.find((mode) => mode.vis === code);
		if (spec) {
			this.reset();
			this.start(spec, true, this.edge3 + 300 * MS, off);
		}
	}

	private pulseLog(i: number, fb: number): void {
		if (fb < 1330) {
			if (!this.inPulse) {
				this.inPulse = true;
				this.runStart = i;
			}
			return;
		}
		if (!this.inPulse) return;
		this.inPulse = false;
		const len = i - this.runStart;
		if (len < 6 || len > 40 * MS) return;
		this.events.push((this.runStart + i) * 0.5 - BOX / 2);
		if (this.events.length > 8) this.events.shift();
		if (this.events.length >= 5) this.matchPeriod();
	}

	private matchPeriod(): void {
		const e = this.events;
		const m = e.length;
		const d = (e[m - 1] - e[m - 5]) / 4;
		for (let k = m - 4; k < m; k++) if (Math.abs(e[k] - e[k - 1] - d) > 0.006 * d) return;
		const spec = SSTV_MODES.find((mode) => Math.abs(d - mode.lineMs * MS) < 0.01 * d);
		if (!spec) return;
		const startOfPulse = e[m - 5] - spec.syncMs * (MS / 2);
		this.reset();
		this.start(spec, false, startOfPulse - spec.syncOffMs * MS, 0);
	}
}
