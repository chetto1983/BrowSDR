// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir core/src/tones/tones_gen.cpp (ToneScene, toneSceneFm),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: BrowSDR's seeded noise() in place of mt19937, an
// optional carrier on / off schedule, normalize() and the demonstration synthesizer are not ported.

import {
	DCS_BAUD,
	dcsWord,
	DTMF_COLS,
	DTMF_KEYS,
	DTMF_ROWS,
	SEQ_SETS,
	selcalHz,
	selcalIndex,
} from '@/worker/decoders/digimode/tones/proto';
import { noise } from '../fixtures';

/** Gaussian samples from the seeded uniform source (Box-Muller). */
function gaussian(seed) {
	const random = noise(seed);
	return () => Math.sqrt(-2 * Math.log(random() + 0.5 + 1e-12)) * Math.cos(2 * Math.PI * (random() + 0.5));
}

/** Tone signalling audio, 1.0 = 5 kHz FM deviation. */
export class ToneScene {
	constructor(rate = 16000, seed = 1) {
		this.rate = rate;
		this.seed = seed;
		this.a = [];
	}

	get seconds() {
		return this.a.length / this.rate;
	}

	/** Make the scene at least this long. */
	pad(sec) {
		const n = Math.round(sec * this.rate);
		while (this.a.length < n) this.a.push(0);
	}

	/** A plain tone (added). */
	tone(hz, t0, sec, amp) {
		this.pad(t0 + sec);
		const [i0, n] = [Math.round(t0 * this.rate), Math.round(sec * this.rate)];
		for (let i = 0; i < n; i++) this.a[i0 + i] += amp * Math.sin((2 * Math.PI * hz * (i0 + i)) / this.rate);
	}

	ctcss(hz, t0, sec, amp) {
		this.tone(hz, t0, sec, amp);
	}

	/** 134.4 bit/s NRZ, then a two-pole low-pass at 250 Hz like the transmitters' deviation filter. */
	dcs(code, inverted, t0, sec, amp, startBit = 0) {
		this.pad(t0 + sec);
		const w = dcsWord(code);
		const [i0, n] = [Math.round(t0 * this.rate), Math.round(sec * this.rate)];
		const d = Array.from({ length: n }, (_, i) => {
			const bit = startBit + (i / this.rate) * DCS_BAUD;
			const b = ((w >>> (Math.trunc(bit) % 23)) & 1) ^ (inverted ? 1 : 0);
			return b ? 1 : -1;
		});
		const al = 1 - Math.exp((-2 * Math.PI * 250.0) / this.rate);
		let y1 = d.length ? d[0] : 0;
		let y2 = y1;
		for (let i = 0; i < n; i++) {
			y1 += al * (d[i] - y1);
			y2 += al * (y1 - y2);
			this.a[i0 + i] += amp * y2;
		}
	}

	dtmf(keys, t0, toneSec, gapSec, amp) {
		let t = t0;
		for (const k of keys) {
			const i = DTMF_KEYS.indexOf(k);
			if (i >= 0) {
				this.tone(DTMF_ROWS[i >> 2], t, toneSec, amp * 0.5);
				this.tone(DTMF_COLS[i & 3], t, toneSec, amp * 0.5);
			}
			t += toneSec + gapSec;
		}
	}

	/** Sequential tones of a plan ("zvei1", "ccir" ...); a repeated digit goes out as the repeat tone. */
	sequential(setId, digits, t0, toneMs, amp) {
		const st = SEQ_SETS.find((set) => set.id === setId);
		let t = t0;
		let prev = '';
		for (const c of digits) {
			const f = c === prev ? st.rep : st.digit[Number(c)];
			const sec = toneMs / 1000;
			// a keyed tone: phase continuous per tone, 1 ms raised edges
			this.pad(t + sec);
			const [i0, n] = [Math.round(t * this.rate), Math.round(sec * this.rate)];
			const ramp = Math.max(1, this.rate * 0.001);
			for (let i = 0; i < n; i++) {
				const g = Math.min(1, i / ramp, (n - i) / ramp);
				this.a[i0 + i] += amp * g * Math.sin((2 * Math.PI * f * i) / this.rate);
			}
			t += sec;
			prev = c;
		}
	}

	/** "ABCD": two pairs of simultaneous tones. */
	selcal(code, t0, amp, pairSec = 1.0, gapSec = 0.2) {
		for (let p = 0; p + 1 < code.length; p += 2) {
			const t = t0 + (p / 2) * (pairSec + gapSec);
			this.tone(selcalHz(selcalIndex(code[p])), t, pairSec, amp * 0.5);
			this.tone(selcalHz(selcalIndex(code[p + 1])), t, pairSec, amp * 0.5);
		}
	}

	twoTone(hzA, hzB, t0, secA, secB, amp) {
		this.tone(hzA, t0, secA, amp);
		this.tone(hzB, t0 + secA, secB, amp);
	}

	/** Voiced, gliding pitch, syllables and fricatives. */
	speech(t0, sec, amp) {
		this.pad(t0 + sec);
		const random = noise(this.seed + Math.trunc(t0 * 1000));
		const u = () => random() + 0.5;
		const [i0, n] = [Math.round(t0 * this.rate), Math.round(sec * this.rate)];
		let [ph, f0, lp] = [0, 100 + 40 * u(), 0];
		let target = f0;
		const step = Math.trunc(this.rate * 0.08);
		for (let i = 0; i < n; i++) {
			const t = i / this.rate;
			if (i % step === 0) target = 85 + 120 * u(); // the pitch wanders every 80 ms
			f0 += (target - f0) * 0.0006 * (48000.0 / this.rate) * 8;
			ph += (2 * Math.PI * f0) / this.rate;
			const syl = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3.7 * t + 1.3 * Math.sin(2 * Math.PI * 0.9 * t)); // syllable rhythm
			let v = 0;
			for (let h = 1; h <= 24; h++) {
				const fh = f0 * h;
				if (fh > 3400) break;
				// formants near 500, 1500 and 2500 Hz
				const env =
					Math.exp(-(((fh - 500) / 350) ** 2)) +
					0.6 * Math.exp(-(((fh - 1500) / 500) ** 2)) +
					0.3 * Math.exp(-(((fh - 2500) / 600) ** 2)) +
					0.25 / h;
				v += env * Math.sin(h * ph);
			}
			lp += 0.2 * (u() - 0.5 - lp);
			const fric = t % 0.35 < 0.07 ? (u() - 0.5 - lp) * 1.2 : 0.0;
			this.a[i0 + i] += amp * 0.22 * (syl * v + fric);
		}
	}

	noise(t0, sec, rms) {
		this.pad(t0 + sec);
		const g = gaussian(this.seed * 7919 + Math.trunc(t0 * 10));
		const [i0, n] = [Math.round(t0 * this.rate), Math.round(sec * this.rate)];
		for (let i = 0; i < n; i++) this.a[i0 + i] += rms * g();
	}
}

/**
 * FM-modulate the scene: complex baseband at `rate`, carrier offset by offsetHz, deviation 5 kHz at 1.0, complex noise
 * for snrDb in 25 kHz. `carrier` (optional) says per second of the scene whether the transmitter is on.
 */
export function toneSceneFm(scene, rate, offsetHz, snrDb, { seed = 3, carrier = () => true } = {}) {
	const n = Math.round(scene.seconds * rate);
	const out = new Float32Array(2 * n);
	const a = scene.a;
	const adv = scene.rate / rate;
	const g = gaussian(seed);
	const sigma = snrDb < 100 ? Math.sqrt(rate / 25000 / 10 ** (snrDb / 10) / 2) : 0;
	let [pos, th] = [0, 0];
	for (let i = 0; i < n; i++) {
		const i0 = Math.trunc(pos);
		const fr = pos - i0;
		const [v0, v1] = [a[i0] ?? 0, a[i0 + 1] ?? 0];
		th += (2 * Math.PI * (offsetHz + 5000.0 * (v0 + (v1 - v0) * fr))) / rate;
		if (th > Math.PI) th -= 2 * Math.PI;
		else if (th < -Math.PI) th += 2 * Math.PI;
		const on = carrier(i / rate) ? 1 : 0;
		out[2 * i] = on * Math.cos(th) + sigma * g();
		out[2 * i + 1] = on * Math.sin(th) + sigma * g();
		pos += adv;
	}
	return out;
}
