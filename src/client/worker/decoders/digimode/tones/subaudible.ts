// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/tones/tones_rx.cpp (ctcssHop, lockCtcss, unlockCtcss, dcsHop,
// lockDcs, unlockDcs), https://github.com/adswill/OnAir; see third_party/onair. Changes: the squelch gate and the
// 50-tone power display are not ported; an event keeps the level and frequency of its strongest CTCSS reading (OnAir
// shows the newest).

import { FULL, newEvent, type ToneAudio } from './audio';
import { goertzel, hann } from './dsp';
import { CTCSS_HZ, ctcssExtended, ctcssHz, DCS_BAUD, dcsDecode, dcsName } from './proto';
import type { DcsHit, ToneEvent, ToneEventSink } from './types';

const CTCSS_WIN = 1000;
const DCS_N = 600;
const DCS_BITS = 69;
/** Samples per bit at 1 kHz. */
const DCS_SPS = 1000 / DCS_BAUD;
const HANN_1000 = hann(CTCSS_WIN);

const octal = (code: number) => String(code).padStart(3, '0');

/** "023", "112 (inverted)", "023 (or 047 inverted)": the code as written, then the other reading of the waveform. */
function dcsLabel(h: DcsHit): string {
	const notes = h.inverted ? ['inverted'] : [];
	if (h.aliasCode >= 0) notes.push(`or ${octal(h.aliasCode)}${h.aliasInverted ? ' inverted' : ''}`);
	return notes.length ? `${octal(h.code)} (${notes.join('; ')})` : octal(h.code);
}

function popcount(v: number): number {
	let n = 0;
	for (; v; v &= v - 1) n++;
	return n;
}

/** CTCSS (50 tones, a 1 s Goertzel bank on the 1 kHz audio) and DCS (the 23 bit word read three times over 0.6 s). */
export class SubAudible {
	// CTCSS
	private cPend = -1;
	private cPendRun = 0;
	private cMiss = 0;
	/** Locked tone (index into CTCSS_HZ), -1 none. */
	ctcssIdx = -1;
	/** Measured tone frequency. */
	ctcssHz = 0;
	/** Tone level, 0 dB = 5 kHz deviation. */
	ctcssDb = -200;
	private ctcssEv: ToneEvent | null = null;
	// DCS
	private dPendCode = -1;
	private dPendInv = false;
	private dPendRun = 0;
	private dLastHit = 0;
	/** Locked code as written (23 for 023), -1 none. */
	dcsCode = -1;
	dcsInv = false;
	private dcsEv: ToneEvent | null = null;

	private readonly win = new Float64Array(CTCSS_WIN);
	private readonly tmp = new Float64Array(CTCSS_WIN);
	private readonly sorted = new Float64Array(DCS_N);
	private readonly power = new Float64Array(CTCSS_HZ.length);
	private readonly bits = new Uint8Array(DCS_BITS);
	/** Amplitude of the newest CTCSS reading, Hz of deviation. */
	private amp = 0;

	constructor(
		private readonly audio: ToneAudio,
		private readonly sink: ToneEventSink,
	) {}

	reset(): void {
		this.cPend = -1;
		this.cPendRun = this.cMiss = 0;
		this.ctcssIdx = -1;
		this.ctcssHz = 0;
		this.ctcssDb = -200;
		this.dPendCode = -1;
		this.dPendRun = 0;
		this.dLastHit = 0;
		this.dcsCode = -1;
		this.dcsInv = false;
		this.ctcssEv = this.dcsEv = null;
	}

	/** The events in progress (for a flush before reset()). */
	active(): ToneEvent[] {
		return [this.ctcssEv, this.dcsEv].filter((event): event is ToneEvent => event !== null);
	}

	ctcssHop(): void {
		if (this.audio.n1k < CTCSS_WIN) return;
		const cand = this.ctcssCandidate();
		if (this.ctcssIdx >= 0) {
			if (cand === this.ctcssIdx) this.cMiss = 0;
			else if (++this.cMiss >= 8 || this.dcsCode >= 0) this.unlockCtcss();
		} else if (cand >= 0) {
			if (cand === this.cPend) this.cPendRun++;
			else {
				this.cPend = cand;
				this.cPendRun = 1;
			}
			if (this.cPendRun >= 4) this.lockCtcss(cand);
		} else {
			this.cPend = -1;
			this.cPendRun = 0;
		}
		if (this.ctcssIdx >= 0 && cand === this.ctcssIdx) this.measure();
	}

	/** The tone of the newest second (index into CTCSS_HZ, -1 none); its amplitude goes to `amp`. */
	private ctcssCandidate(): number {
		const { win, tmp, power: p } = this;
		this.audio.tail1k(CTCSS_WIN, win);
		let mean = 0;
		for (let i = 0; i < CTCSS_WIN; i++) mean += win[i];
		mean /= CTCSS_WIN;
		let ew = 0;
		for (let i = 0; i < CTCSS_WIN; i++) {
			tmp[i] = (win[i] - mean) * HANN_1000[i];
			ew += tmp[i] * tmp[i];
		}
		const nf = 3.0 / CTCSS_WIN; // Hann: 2 * sum(w^2) / (sum w)^2
		let top = 0;
		for (let k = 0; k < CTCSS_HZ.length; k++) {
			p[k] = goertzel(tmp, CTCSS_WIN, CTCSS_HZ[k], 1000);
			if (p[k] > p[top]) top = k;
		}
		let second = 0;
		for (let k = 0; k < CTCSS_HZ.length; k++) if (Math.abs(CTCSS_HZ[k] - CTCSS_HZ[top]) > 4.5) second = Math.max(second, p[k]);
		this.amp = (4.0 * Math.sqrt(p[top])) / CTCSS_WIN; // tone amplitude in the audio's units (Hann window)
		const good = this.dcsCode < 0 && ew > 0 && (nf * p[top]) / ew >= 0.12 && p[top] >= 3 * second && this.amp >= 25.0;
		return good ? top : -1;
	}

	/** The measured frequency: a fine scan around the tone. */
	private measure(): void {
		const amp = this.amp;
		const centre = ctcssHz(this.ctcssIdx);
		let bf = centre;
		let bp = -1;
		for (let f = centre - 3; f <= centre + 3.001; f += 0.25) {
			const q = goertzel(this.tmp, CTCSS_WIN, f, 1000);
			if (q > bp) {
				bp = q;
				bf = f;
			}
		}
		this.ctcssHz = bf;
		this.ctcssDb = 10 * Math.log10((amp * amp) / (FULL * FULL) + 1e-12);
		// the record keeps the strongest reading: the first and last windows only partly hold the tone
		const event = this.ctcssEv;
		if (event && (event.measuredHz === undefined || this.ctcssDb >= event.levelDb)) {
			event.levelDb = this.ctcssDb;
			event.measuredHz = bf;
		}
	}

	private lockCtcss(idx: number): void {
		this.ctcssIdx = idx;
		this.ctcssHz = ctcssHz(idx);
		this.cMiss = 0;
		this.cPend = -1;
		this.cPendRun = 0;
		const text = `${ctcssHz(idx).toFixed(1)} Hz`;
		this.ctcssEv = newEvent(this.audio, 'ctcss', {
			system: 'CTCSS',
			text,
			label: text,
			detail: ctcssExtended(idx) ? 'extended tone' : 'standard tone',
			levelDb: this.ctcssDb,
		});
		this.sink.begin(this.ctcssEv);
	}

	private unlockCtcss(): void {
		const event = this.ctcssEv;
		if (event) {
			event.active = false;
			event.durSec = Math.max(0, this.audio.now() - event.timeSec - 0.8);
			this.sink.end(event);
		}
		this.ctcssEv = null;
		this.ctcssIdx = -1;
		this.ctcssHz = 0;
		this.ctcssDb = -200;
		this.cMiss = 0;
	}

	dcsHop(): void {
		const a = this.audio;
		if (a.n1k < DCS_N || this.ctcssIdx >= 0) return;
		const { win, sorted } = this;
		a.tail1k(DCS_N, win);
		sorted.set(win.subarray(0, DCS_N));
		sorted.sort();
		let lo = 0;
		let hi = 0;
		for (let i = 0; i < 60; i++) {
			lo += sorted[i];
			hi += sorted[DCS_N - 1 - i];
		}
		lo /= 60;
		hi /= 60;
		const best = hi - lo >= 80.0 ? this.readWord(0.5 * (lo + hi)) : null;
		if (best) {
			this.dLastHit = a.n1k;
			if (best.code === this.dPendCode && best.inverted === this.dPendInv) this.dPendRun++;
			else {
				this.dPendCode = best.code;
				this.dPendInv = best.inverted;
				this.dPendRun = 1;
			}
			if (this.dPendRun >= 2 && (this.dcsCode !== best.code || this.dcsInv !== best.inverted)) {
				if (this.dcsCode >= 0) this.unlockDcs();
				this.lockDcs(best);
			}
		} else if (this.dcsCode >= 0 && a.n1k - this.dLastHit > 1500) this.unlockDcs();
		else if (this.dcsCode < 0 && a.n1k - this.dLastHit > 1000) {
			this.dPendCode = -1;
			this.dPendRun = 0;
		}
	}

	/** Three words at every bit phase; the phase whose words agree best and decode. */
	private readWord(thr: number): DcsHit | null {
		const { win, bits: b } = this;
		let best: DcsHit | null = null;
		let bestDist = 99;
		for (let ph = 0; ph < DCS_SPS; ph += 0.62) {
			let inRange = true;
			for (let k = 0; k < DCS_BITS; k++) {
				const pos = DCS_N - 1 - (DCS_BITS - 0.5 - k) * DCS_SPS - ph;
				if (pos < 0) {
					inRange = false;
					break;
				}
				const i0 = Math.floor(pos);
				const fr = pos - i0;
				const v = win[i0] * (1 - fr) + win[Math.min(DCS_N - 1, i0 + 1)] * fr;
				b[k] = v > thr ? 1 : 0;
			}
			if (!inRange) continue;
			const w = [0, 0, 0];
			for (let r = 0; r < 3; r++) for (let j = 0; j < 23; j++) w[r] |= b[r * 23 + j] << j;
			let m = 0;
			for (let j = 0; j < 23; j++) if (((w[0] >> j) & 1) + ((w[1] >> j) & 1) + ((w[2] >> j) & 1) >= 2) m |= 1 << j;
			let dist = 0;
			let nearBy = 0;
			for (let r = 0; r < 3; r++) {
				const d = popcount(w[r] ^ m);
				dist += d;
				if (d <= 1) nearBy++;
			}
			if (nearBy < 2 || dist > 3) continue;
			const hit = dcsDecode(m);
			if (hit && dist < bestDist) {
				best = hit;
				bestDist = dist;
			}
		}
		return best;
	}

	private lockDcs(h: DcsHit): void {
		this.dcsCode = h.code;
		this.dcsInv = h.inverted;
		const alias = h.aliasCode >= 0 ? dcsName(h.aliasCode, h.aliasInverted) : '';
		let detail = h.standard ? 'standard code' : 'not in the usual list of 83 codes';
		if (alias) detail += `; the same waveform reads as ${alias}`;
		this.dcsEv = newEvent(this.audio, 'dcs', {
			system: 'DCS',
			text: dcsName(h.code, h.inverted),
			label: dcsLabel(h),
			detail,
			levelDb: this.audio.audioDb,
		});
		this.sink.begin(this.dcsEv);
		// a CTCSS lock that was really the DCS data
		if (this.ctcssIdx >= 0) this.unlockCtcss();
	}

	private unlockDcs(): void {
		const event = this.dcsEv;
		if (event) {
			event.active = false;
			event.durSec = Math.max(0, this.audio.now() - event.timeSec - 1.5);
			this.sink.end(event);
		}
		this.dcsEv = null;
		this.dcsCode = -1;
		this.dcsInv = false;
		this.dPendCode = -1;
		this.dPendRun = 0;
	}
}
