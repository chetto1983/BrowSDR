// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/tones/tones_rx.cpp (dtmfHop, seqHop, closeSeq),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: a DTMF group ends (and is reported) also when a new
// key comes more than 2.5 s after the last one without a pause between; its duration runs to the last key heard and
// its level is the highest audio level at a key; a plan whose reading would begin with its repeat tone does not fit
// (OnAir shows such a reading as "?1234", and ZVEI2 so took the DZVEI calls that begin with 1).

import { newEvent, RATE, type ToneAudio } from './audio';
import { goertzel } from './dsp';
import { DTMF_COLS, DTMF_KEYS, DTMF_ROWS, SEQ_POOL, SEQ_SETS } from './proto';
import type { SeqSegment, ToneEvent, ToneEventSink } from './types';

const DTMF_N = 205;
const SEQ_N = 128;
const SEQ_HOP = 64;
/** A key group ends after this much silence, s. */
const DTMF_GAP = 2.5;

/** DTMF (Goertzel pairs over 25.6 ms every 10 ms) and five-tone sequential calls (the tone pool over 16 ms every 8 ms). */
export class VoiceBand {
	private dtmfCand = -1;
	private dtmfRun = 0;
	private dtmfGone = 0;
	private dtmfDone = false;
	private dtmfEv: ToneEvent | null = null;
	private dtmfLastSec = -1e9;
	private dtmfHeard = 0;
	private segs: SeqSegment[] = [];
	private sqCur = -1;
	private sqRun = 0;
	private sqPend = -2;
	private sqPendRun = 0;
	private sqSilent = 0;
	/** Tone groups that fitted no plan. */
	rejected = 0;
	private readonly win = new Float64Array(DTMF_N);
	private readonly pr = new Float64Array(4);
	private readonly pc = new Float64Array(4);

	constructor(
		private readonly audio: ToneAudio,
		private readonly sink: ToneEventSink,
	) {}

	/** The keys of the group in progress. */
	get dtmfString(): string {
		return this.dtmfEv?.text ?? '';
	}

	reset(): void {
		this.dtmfCand = -1;
		this.dtmfRun = this.dtmfGone = 0;
		this.dtmfDone = false;
		this.dtmfEv = null;
		this.dtmfLastSec = -1e9;
		this.segs = [];
		this.sqCur = -1;
		this.sqRun = 0;
		this.sqPend = -2;
		this.sqPendRun = this.sqSilent = 0;
	}

	/** The event in progress (for a flush before reset()). */
	active(): ToneEvent[] {
		if (!this.dtmfEv) return [];
		this.dtmfEv.durSec = this.dtmfHeard - this.dtmfEv.timeSec;
		return [this.dtmfEv];
	}

	/** The key heard now, -1 none. */
	private dtmfKey(): number {
		const { win, pr, pc } = this;
		this.audio.tail(DTMF_N, win);
		let e = 0;
		for (let i = 0; i < DTMF_N; i++) e += win[i] * win[i];
		if (e / DTMF_N < 30.0 * 30.0) return -1;
		let br = 0;
		let bc = 0;
		const nf = 2.0 / DTMF_N;
		for (let i = 0; i < 4; i++) {
			pr[i] = (nf * goertzel(win, DTMF_N, DTMF_ROWS[i], RATE)) / e;
			pc[i] = (nf * goertzel(win, DTMF_N, DTMF_COLS[i], RATE)) / e;
			if (pr[i] > pr[br]) br = i;
			if (pc[i] > pc[bc]) bc = i;
		}
		let sr = 0;
		let sc = 0;
		for (let i = 0; i < 4; i++) {
			if (i !== br) sr = Math.max(sr, pr[i]);
			if (i !== bc) sc = Math.max(sc, pc[i]);
		}
		const twist = pc[bc] / Math.max(1e-12, pr[br]); // column against row power
		const ok =
			pr[br] + pc[bc] >= 0.6 && pr[br] >= 0.12 && pc[bc] >= 0.12 && pr[br] >= 4 * sr && pc[bc] >= 4 * sc && twist > 0.12 && twist < 8.0;
		return ok ? br * 4 + bc : -1;
	}

	dtmfHop(): void {
		if (this.audio.n8 < DTMF_N) return;
		const cand = this.dtmfKey();
		const now = this.audio.now();
		if (cand >= 0) {
			this.audio.dtmfOtherUntil = now + 0.15;
			this.dtmfHeard = now;
			this.dtmfGone = 0;
			if (cand === this.dtmfCand) this.dtmfRun++;
			else {
				this.dtmfCand = cand;
				this.dtmfRun = 1;
				this.dtmfDone = false;
			}
			if (this.dtmfRun >= 3 && !this.dtmfDone) this.dtmfPress(cand, now);
		} else {
			if (this.dtmfCand >= 0 && ++this.dtmfGone >= 2) {
				this.dtmfCand = -1;
				this.dtmfRun = 0;
				this.dtmfDone = false;
			}
			if (this.dtmfEv && now - this.dtmfLastSec > DTMF_GAP) this.dtmfEnd();
		}
	}

	private dtmfPress(cand: number, now: number): void {
		this.dtmfDone = true;
		const key = DTMF_KEYS[cand];
		const event = this.dtmfEv;
		if (event && now - this.dtmfLastSec < DTMF_GAP) {
			event.text += key;
			event.label = event.text;
			event.durSec = now - event.timeSec;
			event.levelDb = Math.max(event.levelDb, this.audio.audioDb);
		} else {
			if (event) this.dtmfEnd();
			this.dtmfEv = newEvent(this.audio, 'dtmf', {
				system: 'DTMF',
				text: key,
				label: key,
				detail: `${DTMF_ROWS[cand >> 2]} + ${DTMF_COLS[cand & 3]} Hz`,
				levelDb: this.audio.audioDb,
			});
			this.sink.begin(this.dtmfEv);
		}
		this.dtmfLastSec = now;
	}

	private dtmfEnd(): void {
		const event = this.dtmfEv;
		this.dtmfEv = null;
		if (!event) return;
		event.active = false;
		event.durSec = Math.max(0, this.dtmfHeard - event.timeSec);
		this.sink.end(event);
	}

	/** The pool tone heard now, -1 none. */
	private seqTone(): number {
		const a = this.audio;
		const win = this.win;
		a.tail(SEQ_N, win);
		let e = 0;
		for (let i = 0; i < SEQ_N; i++) e += win[i] * win[i];
		if (a.now() <= a.dtmfOtherUntil || e / SEQ_N < 30.0 * 30.0) return -1;
		const nf = 2.0 / SEQ_N;
		let bp = 0;
		let cand = -1;
		for (let i = 0; i < SEQ_POOL.length; i++) {
			const f = (nf * goertzel(win, SEQ_N, SEQ_POOL[i], RATE)) / e;
			if (f > bp) {
				bp = f;
				cand = i;
			}
		}
		return bp < 0.55 ? -1 : cand;
	}

	seqHop(): void {
		if (this.audio.n8 < SEQ_N) return;
		const cand = this.seqTone();
		// tracking with a two-hop confirmation of a change
		if (cand === this.sqCur) {
			this.sqRun++;
			this.sqPend = -2;
			this.sqPendRun = 0;
		} else if (cand === this.sqPend) {
			if (++this.sqPendRun >= 2) {
				if (this.sqCur >= 0 && this.sqRun >= 2 && this.sqRun <= 40)
					this.segs.push({ pool: this.sqCur, dwellMs: Math.trunc((this.sqRun * 1000 * SEQ_HOP) / RATE) + 8 });
				this.sqCur = cand;
				this.sqRun = this.sqPendRun;
				this.sqPend = -2;
				this.sqPendRun = 0;
				this.sqSilent = 0;
			}
		} else {
			this.sqPend = cand;
			this.sqPendRun = 1;
		}
		if (this.sqRun > 40) this.segs = []; // a tone of 0.3 s and more is no sequential tone (SELCAL, two-tone pages)
		if (this.sqCur < 0) this.sqSilent++;
		else this.sqSilent = 0;
		if (this.segs.length && this.sqCur < 0 && (this.sqSilent * SEQ_HOP * 1000) / RATE > 160) this.closeSeq();
		else if (this.segs.length > 12) this.segs = [];
	}

	private closeSeq(): void {
		const s = this.segs;
		this.segs = [];
		if (s.length < 3) return;
		const dw = s.map((g) => g.dwellMs).sort((a, b) => a - b);
		const med = dw[dw.length >> 1];
		const c: Array<{ set: number; digits: string; raw: string }> = [];
		SEQ_SETS.forEach((st, si) => {
			let digits = '';
			let raw = '';
			let prev = '';
			for (const g of s) {
				const f = SEQ_POOL[g.pool];
				let sym = -1;
				for (let k = 0; k < 10; k++) if (Math.abs(st.digit[k] - f) < 0.5) sym = k;
				if (Math.abs(st.rep - f) < 0.5) sym = 10;
				if (sym < 0 || (sym === 10 && !digits)) return;
				if (sym === 10) {
					digits += prev;
					raw += 'E';
				} else {
					prev = String(sym);
					digits += prev;
					raw += prev;
				}
			}
			c.push({ set: si, digits, raw });
		});
		if (!c.length) {
			this.rejected++;
			return;
		}
		// CCIR (100 ms) and EEA (40 ms) share their tones: the tone length decides; the others by closeness to their usual length
		const score = (k: { set: number }) => Math.abs(med - SEQ_SETS[k.set].toneMs) + (k.set === 0 ? 0 : 0.01 * k.set);
		c.sort((a, b) => score(a) - score(b));
		const also = c.slice(1).map((k) => SEQ_SETS[k.set].name);
		const st = SEQ_SETS[c[0].set];
		let detail = `${st.name}, ${s.length} tones of about ${med} ms`;
		if (c[0].raw !== c[0].digits) detail += `, sent as ${c[0].raw}`;
		if (also.length) detail += `; the tones also fit ${also.join(', ')}`;
		const event = newEvent(this.audio, 'seq', {
			system: st.id.toUpperCase(),
			text: c[0].digits,
			label: c[0].digits,
			detail,
			levelDb: this.audio.audioDb,
		});
		event.active = false;
		event.durSec = (s.length * med) / 1000;
		this.sink.end(event);
	}
}
