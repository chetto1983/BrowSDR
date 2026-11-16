// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/hfdig/hfdig_ftx.cpp (HfdigFtx::Impl: feed, schedule, window,
// the slot clock that follows the system clock) and core/include/dect2/hfdig/clock_comp.h (ClockComp: the automatic
// correction of a computer clock that is off), https://github.com/adswill/OnAir; see third_party/onair. Changes: one
// mode per decoder; the slots are cut and handed back (the decoder queues them); no start time, slot search or early
// decode; the slot search that ClockComp asks for after quiet slots is not ported.

import { AUDIO_RATE, layoutOf, Resampler, SampleStore, streamOf, streamRate } from './layout';
import type { FtxJob, FtxMode, FtxProgress, FtxWindow } from './types';
import { spec } from './wave';

/** Never more than this much audio kept, s. */
const CAP_SEC = 300;

/** OnAir's ClockComp: watches the median DT of the slots and asks for a correction once it is steady. */
export class ClockComp {
	static readonly APPLY_DT = 0.5;
	static readonly BIG_DT = 1;
	static readonly MIN_DECODES = 2;
	static readonly STEADY_SLOTS = 2;
	total = 0;
	private last = 0;
	private consecutive = 0;

	/** Results of one finished slot: decodes and their median DT. Returns the seconds to subtract from the slot clock now, 0 when none. */
	slotEnded(decodes: number, medianDt: number): number {
		if (decodes < 1) {
			this.consecutive = 0;
			return 0;
		}
		// one decode can be a station with a bad clock: only a large error counts on it
		if (decodes < ClockComp.MIN_DECODES && Math.abs(medianDt) < ClockComp.BIG_DT) {
			this.consecutive = 0;
			return 0;
		}
		if (Math.abs(medianDt) < ClockComp.APPLY_DT) {
			this.consecutive = 0;
			return 0;
		}
		const sameWay = this.consecutive > 0 && medianDt > 0 === this.last > 0;
		this.consecutive = sameWay ? this.consecutive + 1 : 1;
		this.last = medianDt;
		if (this.consecutive < ClockComp.STEADY_SLOTS) return 0;
		this.consecutive = 0;
		this.total -= medianDt;
		return medianDt;
	}
}

/** The window of a slot against the slot start: the transmission with +-dtMax of start offset and two symbols of guard. */
export function slotWindow(mode: FtxMode): FtxWindow {
	const s = spec(mode);
	const dtMax = layoutOf(mode).dtMax;
	const guard = 2 * s.symSec;
	return { a: s.t0 - dtMax - guard, b: s.t0 + s.nn * s.symSec + dtMax + guard, dtMin: -dtMax, dtMax };
}

/** The 8 kHz audio of one mode, resampled, cut into the UTC slots of the mode. */
export class SlotClock {
	private readonly rs: Resampler;
	private readonly buf = new SampleStore();
	private readonly rate: number;
	private readonly win: FtxWindow;
	private readonly period: number;
	private first = true;
	private nAudio = 0;
	private anchorUtc = 0;
	private anchorK = 0;
	private errEma = 0;
	private clockTrim = 0;
	private nextSlot = NaN;
	/** A correction from the slots' DT, applied with the next audio. */
	private autoShift = NaN;
	readonly comp = new ClockComp();

	constructor(
		private readonly mode: FtxMode,
		private readonly now: () => number,
	) {
		const st = streamOf(mode);
		this.rs = new Resampler(st.L, st.M, st.cut);
		this.rate = streamRate(mode);
		this.win = slotWindow(mode);
		this.period = spec(mode).period;
	}

	reset(): void {
		this.first = true;
		this.nAudio = 0;
		this.errEma = 0;
		this.rs.reset();
		this.buf.clear();
		this.nextSlot = NaN;
	}

	private utcOfAudio(k: number): number {
		return this.anchorUtc + (k - this.anchorK) / AUDIO_RATE;
	}

	private audioOfUtc(u: number): number {
		return this.anchorK + (u - this.anchorUtc) * AUDIO_RATE;
	}

	/** The slot clock: the system clock with the correction in use, s. */
	private clockNow(): number {
		return this.now() / 1000 + this.clockTrim;
	}

	/** Takes 8 kHz audio; returns the slots now complete. */
	feed(x: Float32Array): FtxJob[] {
		if (this.first) {
			this.first = false;
			this.anchorK = 0;
			// the clock is the time of the last sample of this block
			this.anchorUtc = this.clockNow() - x.length / AUDIO_RATE;
		}
		if (!Number.isNaN(this.autoShift)) {
			// the computer clock is off: the slot clock is corrected and the system clock is followed with that offset
			this.anchorUtc -= this.autoShift;
			this.clockTrim -= this.autoShift;
			this.nextSlot = NaN;
			this.autoShift = NaN;
		}
		// NaN or infinite samples (a broken file, a driver fault) become silence instead of spreading through every FFT
		const clean = x.every(Number.isFinite) ? x : x.map((v) => (Number.isFinite(v) ? v : 0));
		this.rs.process(clean, this.buf);
		this.nAudio += x.length;
		this.follow();
		return this.schedule();
	}

	/** Follow the system clock; a jump (a stall, the clock set) moves the anchor. */
	private follow(): void {
		const err = this.clockNow() - this.utcOfAudio(this.nAudio);
		this.errEma += 0.05 * (err - this.errEma);
		if (Math.abs(err) > 2) {
			this.anchorUtc += err;
			this.errEma = 0;
		} else if (Math.abs(this.errEma) > 0.2) {
			this.anchorUtc += this.errEma;
			this.errEma = 0;
		}
	}

	private schedule(): FtxJob[] {
		const { buf, rs, win, period: P } = this;
		const jobs: FtxJob[] = [];
		if (!buf.length) return jobs;
		const uStart = this.utcOfAudio(rs.inputPos(buf.base));
		const uEnd = this.utcOfAudio(rs.inputPos(buf.base + buf.length));
		if (Number.isNaN(this.nextSlot)) {
			// start mid-slot: a transmission missing more than its first second waits for the next slot
			let S = Math.floor(uStart / P) * P;
			while (uStart > S + spec(this.mode).t0 + 1) S += P;
			this.nextSlot = S;
		}
		while (uEnd >= this.nextSlot + win.b) {
			const S = this.nextSlot;
			this.nextSlot = S + P;
			const ja = rs.outputPos(this.audioOfUtc(S + win.a));
			const i0 = Math.floor(ja);
			const nwin = Math.ceil((win.b - win.a) * this.rate);
			const x = new Float32Array(nwin);
			for (let i = 0; i < nwin; i++) x[i] = buf.at(i0 + i);
			jobs.push({ mode: this.mode, slotUtc: S, x0: win.a + (i0 - ja) / this.rate, x, dtMin: win.dtMin, dtMax: win.dtMax });
		}
		// keep what the next slot needs: from its window start, never more than five minutes
		const keep = Math.floor(rs.outputPos(this.audioOfUtc(this.nextSlot + win.a - 1)));
		buf.drop(Math.min(buf.length, keep - buf.base));
		if (buf.length > CAP_SEC * this.rate) buf.drop(buf.length - CAP_SEC * this.rate);
		return jobs;
	}

	/** After a slot is decoded: the median DT of its decodes for the clock correction. */
	slotDecoded(dts: number[]): void {
		const sorted = [...dts].sort((a, b) => a - b);
		const shift = this.comp.slotEnded(dts.length, dts.length ? sorted[dts.length >> 1] : 0);
		if (shift !== 0) this.autoShift = shift;
	}

	/** The slot being heard now and how far into it the audio is. */
	progress(): FtxProgress | null {
		if (this.first) return null;
		const u = this.utcOfAudio(this.nAudio);
		const slotUtc = Math.floor(u / this.period) * this.period;
		return { slotUtc, into: u - slotUtc };
	}

	/** The correction in use, added to the computer clock, s. */
	get trim(): number {
		return this.clockTrim;
	}
}
