// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/cw/cw_decoder.cpp (FistDecoder: the lock from the backlog
// (blipFloor, tryLock), the confirmation of Morse timing, dropping a lock and the prior of the same sender, the events
// of marks and spaces, the soft merging of drop-outs and noise spikes, the check of the speed after a pause, the idle
// flush; mark, space, idle, pop, stats) and core/include/dect2/cw/cw_decoder.h, https://github.com/adswill/OnAir; see
// third_party/onair. Changes: the model and the beam are classes of their own (model.ts, beam.ts); the CW_TRACE output
// and liveAlternatives (OnAir's text view) are left out.

import { Beam } from './beam';
import { dashFit, FistModel, twoMeans } from './model';
import type { CwEv, DecTok, FistClasses, FistStats } from './types';

const BACK = 160;
const POST = 40;
const POST_MARKS = 10;
/** The rate of clear detector errors above which the soft decisions are made. */
const NOISY = 0.015;
const LN3 = 1.0986;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * CW adaptive decoder: key-down / key-up durations in, text with a confidence per character out. The sender is learned
 * while the text comes (dot length, dash ratio, three gap classes and their spreads, in the log domain), and a beam
 * search reads the segmentations by timing likelihood, code validity and a model of amateur-radio traffic (lm.ts).
 */
export class FistDecoder {
	locked = false;
	readonly model = new FistModel();
	private readonly beam = new Beam();
	private back: CwEv[] = [];
	/** The merging queue. */
	private q: CwEv[] = [];
	private haveMark = false;
	private idleFlushed = false;
	/** The sender learned before the lock was lost: a new lock at about the same speed starts from it. */
	private prior: FistClasses | null = null;
	/** How often the detector opens on noise in a gap: the soft decisions' measure of how weak the signal is. */
	private rSpike = 0.01;
	private sinceCheck = 0;
	private collecting = false;
	private post: CwEv[] = [];

	reset(): void {
		const manual = this.model.manualDot;
		this.locked = false;
		this.model.reset();
		this.model.manualDot = manual;
		this.beam.reset();
		this.back = [];
		this.q = [];
		this.haveMark = this.idleFlushed = this.collecting = false;
		this.post = [];
		this.prior = null;
		this.rSpike = 0.01;
		this.sinceCheck = 0;
	}

	/** 0: automatic (the default); else the dot length is fixed (the ratio and the gaps are still learned). */
	setManualWpm(wpm: number): void {
		this.model.manualDot = wpm > 0 ? 1200 / Math.max(3, Math.min(60, wpm)) : 0;
	}

	/** A key-down that just ended. */
	mark(ms: number): void {
		this.event(true, ms);
	}

	/** A key-up that just ended. */
	space(ms: number): void {
		this.event(false, ms);
	}

	get dotMs(): number {
		return this.model.dot;
	}

	get wpm(): number {
		return this.locked ? 1200 / this.model.dot : 0;
	}

	/** Characters are waiting to be popped. */
	get ready(): boolean {
		return this.beam.ready;
	}

	/** The characters committed since the last call. */
	pop(): DecTok[] {
		return this.beam.pop();
	}

	stats(): FistStats {
		const m = this.model;
		const spread = (m.sd + m.sD + m.si) / 3;
		return {
			locked: this.locked,
			dotMs: m.dot,
			wpm: this.locked ? 1200 / m.dot : 0,
			dashRatio: Math.exp(m.ldr),
			intraGapDots: Math.exp(m.gi),
			charGapDots: Math.exp(m.gc),
			wordGapDots: Math.exp(m.gw),
			quality: clamp(1 - (spread - 0.07) / 0.3, 0, 1),
			fit: m.fit,
		};
	}

	/** Text held back until the timing has proven to be Morse. */
	private confirmCheck(): void {
		const m = this.model;
		if (this.beam.confirmed || m.n < 14 || m.fit > 4 || m.fitG > 4) return;
		this.beam.confirm();
	}

	/** The held text was noise; the classes of a confirmed sender are kept for the next lock. */
	private dropLock(): void {
		if (this.beam.confirmed) this.prior = this.model.classes();
		this.beam.drop();
		this.locked = false;
		this.back = [];
		this.q = [];
		this.haveMark = this.idleFlushed = this.collecting = false;
		this.post = [];
		this.beam.single();
		const m = this.model;
		m.n = m.badRun = m.ringN = 0;
		m.fit = m.fitG = 1;
		m.forgetWindows();
		m.batchM = m.batchG = false;
	}

	// ---------------------------------------------------------------- the lock
	/**
	 * The shortest mark the lock takes: noise in the gaps of a weak signal opens the detector for a few ms at a time;
	 * those blips are much shorter than the dashes, which carry most of the key-down time.
	 */
	private blipFloor(from: number): number {
		const v: number[] = [];
		let tot = 0;
		for (let i = from; i < this.back.length; i++) {
			const e = this.back[i];
			if (e.on && e.ms >= 18 && e.ms < 1200) {
				v.push(e.ms);
				tot += e.ms;
			}
		}
		if (v.length < 8) return 18;
		v.sort((a, b) => a - b);
		let acc = 0;
		for (const x of v) {
			acc += x;
			if (acc >= 0.3 * tot) return Math.max(18, 0.15 * x);
		}
		return 18;
	}

	/** The dot length and dash ratio from the marks of the backlog (null: not Morse yet). */
	private lockSpeed(xs: number[]): { dotL: number; ratio: number } | null {
		const m = xs.length;
		const { c1, c2, n1, n2, sig } = twoMeans(xs, m);
		const f = dashFit(xs, m, 2);
		if (f && Math.abs(f.dotL - c1) > 0.2) return { dotL: f.dotL, ratio: f.ratio }; // blips in the marks
		if (c2 - c1 >= 0.52 && n1 >= 2 && n2 >= 2 && sig <= 0.45) return { dotL: c1, ratio: c2 - c1 };
		if (m < 20) return null;
		// one kind of element only: the gaps inside the characters are one dot long
		const mean = xs.reduce((a, b) => a + b, 0) / m;
		if (Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / m) > 0.3) return null;
		const sp = this.back.filter((e) => !e.on && e.ms >= 10 && e.ms < 2.5 * Math.exp(mean)).map((e) => Math.log(e.ms));
		if (sp.length < 6) return null;
		sp.sort((a, b) => a - b);
		const unit = sp[sp.length >> 1];
		if (mean - unit < 0.45) return { dotL: mean, ratio: LN3 };
		if (mean - unit > 0.8) return { dotL: mean - LN3, ratio: LN3 };
		return null;
	}

	/**
	 * The gaps must look like Morse too: the shorter half of them is about one dot long; and three gaps between
	 * characters at least, so the gap classes can be fitted before the backlog is read (else Farnsworth character gaps
	 * read as word gaps).
	 */
	private gapsLookMorse(dotL: number): boolean {
		const sp: number[] = [];
		for (let i = Math.max(0, this.back.length - 70); i < this.back.length; i++) {
			const e = this.back[i];
			if (!e.on && e.ms >= 18 && e.ms < 3000) sp.push(Math.log(e.ms));
		}
		if (sp.length < 6) return false;
		sp.sort((a, b) => a - b);
		const half = sp.length >> 1;
		const low = sp.slice(0, half);
		const lowQ = low.reduce((a, b) => a + b, 0) / half;
		if (lowQ < dotL - 1 || lowQ > dotL + 0.7) return false;
		if (Math.sqrt(low.reduce((a, b) => a + (b - lowQ) ** 2, 0) / half) > 0.5) return false;
		return sp.filter((x) => x > dotL + 0.7).length >= 3;
	}

	private tryLock(): boolean {
		const from = Math.max(0, this.back.length - 70);
		const floorMs = this.blipFloor(from);
		const xs: number[] = [];
		for (let i = from; i < this.back.length; i++) {
			const e = this.back[i];
			if (e.on && e.ms >= floorMs && e.ms < 1200) xs.push(Math.log(e.ms));
		}
		if (xs.length < 8) return false;
		const speed = this.lockSpeed(xs);
		if (!speed) return false;
		let { dotL } = speed;
		const m = this.model;
		if (m.manualDot > 0) dotL = Math.log(m.manualDot);
		const ms = Math.exp(dotL);
		if (ms < 20 || ms > 280 || !this.gapsLookMorse(dotL)) return false;
		m.start(dotL, clamp(speed.ratio, 0.64, 1.65));
		this.beam.confirmed = false;
		const p = this.prior;
		if (p && Math.abs(m.L - p.L) < 0.25) {
			// the same sender again: its classes, refined by the backlog below
			Object.assign(m, { ldr: p.ldr, gi: p.gi, gc: p.gc, gw: p.gw, sd: p.sd, sD: p.sD, si: p.si, sc: p.sc, sw: p.sw });
			m.batchM = m.batchG = true; // known classes: only the window fits move them
		}
		m.fromBacklog(xs, this.back, from);
		this.locked = true;
		return true;
	}

	// ---------------------------------------------------------------- events
	private processMark(ms: number): void {
		const x = Math.log(Math.max(1, ms));
		const m = this.model;
		this.beam.extendMark(x, m, this.rSpike);
		m.learnMark(x, this.rSpike);
		this.haveMark = true;
		this.confirmCheck();
		if (m.n >= 40 && (m.fit > 8 || m.fitG > 8)) {
			this.dropLock();
			return;
		}
		if (m.badRun >= 6 && m.fit > 5) m.relock();
		else if (++this.sinceCheck >= 6 && m.ringN >= 16) {
			this.sinceCheck = 0;
			m.checkSpeed();
		}
	}

	private processSpace(ms: number): void {
		if (!this.haveMark || !this.locked) return;
		const x = Math.log(Math.max(1, ms));
		this.beam.extendSpace(x, false, this.model);
		this.model.learnGap(x);
		this.beam.commitAfterStep();
	}

	private process(e: CwEv): void {
		if (e.on) this.processMark(e.ms);
		else this.processSpace(e.ms);
	}

	// ---------------------------------------------------------------- soft mark / space decisions
	/**
	 * A weak signal's detector splits marks (a fade inside a dash) and opens on noise in the gaps. On a noisy detector
	 * the three events read as they are (mark, gap, mark or gap, mark, gap, each in its best class) are weighed against
	 * the one merged event plus the log chance of such a detector error, learned from the clear noise spikes.
	 */
	private softMerge(dropOut: boolean): boolean {
		const m = this.model;
		if (!this.locked || m.n < 10 || this.rSpike < NOISY) return false;
		const q = this.q;
		const d = m.dot;
		const [a, b, c] = [Math.log(Math.max(1, q[0].ms)), Math.log(Math.max(1, q[1].ms)), Math.log(Math.max(1, q[2].ms))];
		const all = Math.log(q[0].ms + q[1].ms + q[2].ms);
		const pr = Math.log(clamp(this.rSpike, 0.003, 0.3));
		// only on a noisy detector: on a clean one the same patterns are a change of speed, which must reach the model
		if (dropOut) return q[1].ms <= 0.8 * d && m.lMark(all) + pr > m.lMark(a) + m.lGap(b, false) + m.lMark(c);
		const split = m.lGap(a, false) + m.lMark(b) + m.lGap(c, false);
		// a mark alone between a word gap and a character gap or longer would be a word of one element: rare in traffic
		// (-4.6: about 1 %), common as noise in the pause of a weak signal
		if (Math.max(a, c) >= m.L + m.gw - m.sw && Math.min(a, c) >= m.L + m.gc - m.sc && b < m.L + m.ldr + 2 * m.sD)
			return m.lGap(all, false) + pr > split - 4.6;
		if (q[1].ms > 0.9 * d) return false;
		// a dot between two gaps inside a character is a dot (a weak one is short): noise only next to a character gap
		if (Math.max(a, c) < m.L + m.gc - m.sc) return false;
		return m.lGap(all, false) + pr > split;
	}

	/** Three queued events: a drop-out inside a mark, or a noise spike inside a gap, merged into one. */
	private tryMerge(): boolean {
		const q = this.q;
		const d = this.model.dot;
		let merge = false;
		if (q[0].on && !q[1].on && q[2].on) merge = q[1].ms < 0.3 * d || this.softMerge(true);
		else if (!q[0].on && q[1].on && !q[2].on) {
			const sure = q[1].ms < 0.33 * d;
			merge = sure || this.softMerge(false);
			this.rSpike += 0.02 * ((sure ? 1 : 0) - this.rSpike);
		}
		if (merge) {
			q[0] = { on: q[0].on, ms: q[0].ms + q[1].ms + q[2].ms };
			q.splice(1, 2);
		}
		return merge;
	}

	private drain(flush: boolean): void {
		for (;;) {
			if (flush ? this.q.length === 0 : this.q.length < 3) return;
			if (this.q.length >= 3 && this.tryMerge()) continue;
			this.process(this.q.shift() as CwEv);
			if (!this.locked) {
				this.q = [];
				return;
			}
		}
	}

	private feed(on: boolean, ms: number): void {
		if (this.q.length >= 4) {
			this.process(this.q.shift() as CwEv);
			if (!this.locked) {
				this.q = [];
				return;
			}
		}
		this.q.push({ on, ms });
		this.drain(false);
	}

	private event(on: boolean, ms: number): void {
		if (ms <= 0) return;
		const m = this.model;
		if (!on && this.idleFlushed) {
			// the pause ends: what follows is held until the timing is checked (afterPause)
			this.idleFlushed = false;
			if (this.locked && this.haveMark) {
				m.learnGap(Math.log(Math.max(1, ms)));
				if (ms > 2 * Math.exp(m.L + m.gw)) {
					this.post = []; // a pause, not a word gap
					this.collecting = true;
				}
			}
			return;
		}
		if (this.collecting && this.locked) {
			this.post.push({ on, ms });
			const marks = this.post.filter((e) => e.on).length;
			const longGap = !on && marks >= 4 && ms > Math.exp(m.L + 0.5 * (m.gc + m.gw));
			if (marks >= POST_MARKS || this.post.length >= POST || longGap) this.afterPause();
			return;
		}
		if (!this.locked) {
			if (this.back.length >= BACK) this.back.splice(0, 40);
			this.back.push({ on, ms });
			if (this.tryLock()) {
				const back = this.back;
				this.back = [];
				for (let i = 0; i < back.length && this.locked; i++) this.feed(back[i].on, back[i].ms);
			}
			return;
		}
		this.idleFlushed = false;
		this.feed(on, ms);
	}

	/**
	 * After a pause the sender may be another one, or the same at another speed. The first marks after it (up to a word)
	 * were held; when a dot length that explains them (and their gaps) at least twice as well is found, the model moves
	 * to it before they are read.
	 */
	private afterPause(): void {
		this.collecting = false;
		const m = this.model;
		const d = m.dot;
		const post = this.post;
		const xs: number[] = [];
		const gs: number[] = [];
		post.forEach((e, i) => {
			if (e.ms < 0.25 * d) return; // noise blips and drop-outs say nothing about the speed
			if (e.on) xs.push(Math.log(e.ms));
			else if (i + 1 < post.length) gs.push(Math.log(e.ms));
		});
		if (xs.length >= 4 && m.manualDot <= 0) this.retune(xs, gs);
		this.post = [];
		for (let i = 0; i < post.length && this.locked; i++) this.feed(post[i].on, post[i].ms);
	}

	/** The dot lengths that might explain the marks after a pause; the model moves to the best one. */
	private retune(xs: number[], gs: number[]): void {
		const m = this.model;
		const cand: number[] = [];
		const { c1, c2 } = twoMeans(xs, xs.length);
		if (c2 - c1 >= 0.5) cand.push(c1);
		const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
		cand.push(mean, mean - m.ldr);
		if (gs.length >= 3) cand.push([...gs].sort((a, b) => a - b)[gs.length >> 2] - m.gi);
		const cur = m.misfit(m.L, xs, gs);
		let [best, bl] = [cur, m.L];
		for (const c of cand) {
			const l = clamp(c, Math.log(20), Math.log(260));
			const e = m.misfit(l, xs, gs);
			if (e < best) [best, bl] = [e, l];
		}
		if (Math.abs(bl - m.L) > 0.18 && best < 0.5 * cur) {
			m.L = bl;
			m.n = Math.min(m.n, 3);
			m.forgetWindows();
			m.badRun = m.ringN = 0;
			m.fit = 1;
			m.clamp();
		}
	}

	/** The key is up and has been for ms: ends the character and the word in time. */
	idle(ms: number): void {
		if (!this.locked) return;
		const m = this.model;
		if (this.collecting && this.post.length) {
			// a pause again: the held marks are read (a short word waits longer: the sender may be slower)
			const marks = this.post.filter((e) => e.on).length;
			if (ms <= (marks >= 4 ? Math.exp(m.L + 0.5 * (m.gc + m.gw)) : 2 * Math.exp(m.L + m.gw))) return;
			this.afterPause();
		}
		if (ms < Math.exp(m.L + 0.5 * (m.gc + m.gw)) || this.idleFlushed) return;
		this.drain(true);
		if (!this.haveMark) return;
		const b = this.beam;
		if (b.hyp[0].nPend === 0 && b.hyp[0].node === 1 && b.nh === 1) {
			this.idleFlushed = true;
			return;
		}
		b.extendSpace(Math.log(ms), true, m);
		b.commit(b.hyp[0].nPend);
		// from here on one reading
		const h = b.hyp[0];
		h.nPend = h.zc = h.wLen = h.score = 0;
		h.node = 1;
		b.nh = 1;
		this.idleFlushed = true;
	}
}
