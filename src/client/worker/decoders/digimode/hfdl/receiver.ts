// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/hfdl/hfdl_rx.cpp (HfdlReceiver::Impl: process, burst's search
// position rules, trim; the per-channel counters of HfdlChannelInfo and the "why" counters of HfdlTelemetry),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: one channel (the VFO's); OnAir decodes every HFDL
// channel of a wide capture at once (each with its own chain, or one FFT channeliser for very wide captures), which is
// not ported. A found burst is decoded a step at a time between input blocks (the search waits meanwhile), so the
// worker never stops for a whole burst; the search itself stops when its time is up and goes on with the next block.
// The higher search threshold OnAir uses for a channel next to the radio's centre (DC spur) is not used: the decoder
// does not know where the centre is, and BrowSDR's channel filter removes the DC first.

import { HFDL_RATE, HfdlSamples, SPS } from './front';
import { decodeBurst } from './burst';
import { EQ_L } from './equalizer';
import { COARSE_THR, CoarseSearch, SEARCH_SYMS } from './coarse';
import { estimate } from './search';
import { PRE_LEN, burstSyms } from './phy';
import type { HfdlBurst, HfdlCounters, HfdlJob } from './types';

/** The search runs while this many samples past the position are in. */
const SPAN = SEARCH_SYMS * SPS + 16;
const LOOK = (PRE_LEN + 8) * SPS;

export const newCounters = (): HfdlCounters => ({
	bursts: 0,
	good: 0,
	bad: 0,
	preambleRejected: 0,
	short: 0,
	spduFcs: 0,
	mpduFcs: 0,
	lpduFcs: 0,
	unknownLpdu: 0,
	byRate: [0, 0, 0, 0],
});

/** One HFDL channel: the matched filter, the burst search and the burst decoder. */
export class HfdlReceiver {
	x = new HfdlSamples();
	private readonly coarse = new CoarseSearch();
	searchAt = 0;
	private waitUntil = 0;
	private job: HfdlJob | null = null;
	readonly counters = newCounters();
	/** Signal seconds of the last preamble and of the last good burst. */
	lastBurstSec = -1e9;
	lastGoodSec = -1e9;

	constructor(private readonly onBurst: (burst: HfdlBurst) => void) {}

	/** Seconds of signal so far. */
	get now(): number {
		return this.x.end / HFDL_RATE;
	}

	/** A burst is being decoded. */
	get busy(): boolean {
		return this.job !== null;
	}

	/** Takes the channel (interleaved I/Q at 7200 Hz) and searches and decodes for up to `budgetMs` ms. */
	process(iq: Float32Array, budgetMs = Infinity): void {
		this.x.push(iq);
		this.work(budgetMs);
	}

	/** Searches and decodes for up to `budgetMs` ms (Infinity: everything there is). */
	work(budgetMs = Infinity): void {
		const t0 = performance.now();
		for (;;) {
			if (this.job) {
				const r = this.job.steps.next();
				if (!r.done) {
					if (performance.now() - t0 >= budgetMs) break;
					continue;
				}
				this.finish(this.job, r.value);
				this.job = null;
			}
			if (!this.search(t0, budgetMs)) break;
		}
		if (!this.job) this.x.trim(this.searchAt);
	}

	/** A gap in the input: the search starts again after it (the counters stay). */
	reset(): void {
		const at = this.x.end;
		this.x = new HfdlSamples();
		this.x.restart(at);
		this.searchAt = at;
		this.waitUntil = 0;
		this.job = null;
		this.coarse.clear();
	}

	/** Moves the search on; true when a burst is to be decoded, false when more samples (or time) are needed. */
	private search(t0: number, budgetMs: number): boolean {
		const x = this.x;
		const end = x.end;
		if (this.searchAt < x.base) this.searchAt = x.base;
		if (end < this.waitUntil) return false;
		let n = 0;
		while (this.searchAt + SPAN + LOOK < end) {
			if ((++n & 511) === 0 && performance.now() - t0 >= budgetMs) return false;
			const s = this.searchAt;
			const m = this.coarse.measure(x, s);
			if (m < COARSE_THR) {
				this.searchAt += 2;
				continue;
			}
			let best = s;
			let bm = m;
			for (let q = s - 2; q <= s + 10; q++) {
				if (q < x.base) continue;
				const v = this.coarse.measure(x, q);
				if (v > bm) {
					bm = v;
					best = q;
				}
			}
			const r = this.preamble(s, best, end);
			if (r === 'wait') return false;
			if (r === 'job') return true;
			if (this.searchAt <= s) this.searchAt = s + SPS * 4;
		}
		return false;
	}

	/** The fine look at a coarse peak: a burst to decode, a wait for its samples, or no preamble after all. */
	private preamble(s: number, s0: number, end: number): 'job' | 'wait' | 'rejected' {
		const pre = estimate(this.x, s0);
		if (pre === 'coherence') {
			this.searchAt = Math.max(this.searchAt, s0) + 2;
			this.counters.preambleRejected++;
			return 'rejected';
		}
		if (pre === 'm1') {
			this.searchAt = Math.max(this.searchAt + 2, s0 + SEARCH_SYMS * SPS);
			this.counters.preambleRejected++;
			return 'rejected';
		}
		const need = Math.ceil(pre.t0) + (burstSyms(pre.m1) + EQ_L + 8) * SPS;
		if (need >= end) {
			this.waitUntil = need + 1;
			return 'wait';
		}
		this.counters.bursts++;
		this.lastBurstSec = this.now;
		this.job = { s, pre, steps: decodeBurst(this.x, pre) };
		return 'job';
	}

	/** A decoded (or failed) burst: the counters, the search position after it, the report. */
	private finish(job: HfdlJob, b: HfdlBurst): void {
		const c = this.counters;
		const nsym = burstSyms(job.pre.m1);
		this.searchAt = Math.floor(job.pre.t0) + (nsym - 40) * SPS;
		for (const m of b.messages) {
			if (m.bad) c.lpduFcs++;
			else if (m.kind === 'LPDU' && m.summary.startsWith('LPDU type 0x')) c.unknownLpdu++;
		}
		if (b.ok) {
			c.good++;
			c.byRate[job.pre.m1 & 3]++;
			this.lastGoodSec = this.now;
		} else {
			c.bad++;
			if (b.why === 1) c.short++;
			else if (b.why === 2) c.spduFcs++;
			else c.mpduFcs++;
			this.searchAt = job.pre.s0 + SEARCH_SYMS * SPS;
		}
		if (this.searchAt <= job.s) this.searchAt = job.s + SPS * 4;
		this.onBurst(b);
	}
}
