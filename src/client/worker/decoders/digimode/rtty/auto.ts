// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/hfdig/hfdig_rtty_auto.cpp (rttyAutoAnalyse, textScore) and
// core/src/autoparam/autoparam.cpp (powerSpectrum, findFskPairs, measureFskBaud), https://github.com/adswill/OnAir; see
// third_party/onair. Changes: the analysis is a generator that stops between steps (OnAir runs it on a thread of its
// own), so the worker can spread it over several blocks of audio; the FFT is BrowSDR's (dab/ofdm/fft.ts).

import { Fft } from '@/worker/decoders/dab/ofdm/fft';
import { RTTY_BAUDS, RTTY_RATE, RTTY_SHIFTS, RttyDecoder } from './decoder';
import type { FskBaud, FskPair, RttyAutoHyp } from './types';

const N = 2048;
/** Trial audio decoded between two stops of the analysis. */
const STEP = 4096;

/** Mean power spectrum of Hann-windowed frames. */
function powerSpectrum(x: Float32Array, fft: Fft, hop: number): Float64Array {
	const n = fft.n;
	const p = new Float64Array(n / 2);
	const re = new Float64Array(n);
	const im = new Float64Array(n);
	let frames = 0;
	for (let s = 0; s + n <= x.length; s += hop) {
		for (let i = 0; i < n; i++) {
			re[i] = x[s + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
			im[i] = 0;
		}
		fft.forward(re, im);
		for (let k = 0; k < n / 2; k++) p[k] += re[k] * re[k] + im[k] * im[k];
		frames++;
	}
	if (frames) for (let k = 0; k < p.length; k++) p[k] /= frames;
	return p;
}

/** The spectral lines: local maxima 6 dB over the median of 300 .. 3300 Hz, refined by a parabola on the log power. */
function spectralLines(pw: Float64Array, bin: number): Array<{ hz: number; p: number }> {
	const lo = Math.ceil(300 / bin);
	const hi = Math.min(N / 2 - 2, Math.floor(3300 / bin));
	const sc = Float64Array.from(pw.subarray(lo, hi + 1)).sort();
	const fl = Math.max(1e-12, sc[sc.length >> 1]);
	const lines: Array<{ hz: number; p: number }> = [];
	for (let k = lo + 1; k < hi; k++) {
		const a = pw[k];
		if (a < pw[k - 1] || a <= pw[k + 1] || a < 4 * fl) continue;
		const l0 = Math.log(pw[k - 1] + 1e-30);
		const l1 = Math.log(a);
		const l2 = Math.log(pw[k + 1] + 1e-30);
		const den = l0 - 2 * l1 + l2;
		const off = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (l0 - l2)) / den)) : 0;
		lines.push({ hz: (k + off) * bin, p: a / fl });
	}
	return lines;
}

/** Two spectral lines a shift of the table apart (the tones of an FSK signal), strongest first. */
export function findFskPairs(x: Float32Array, fs: number, shifts: number[], maxPairs: number, tolHz = 10): FskPair[] {
	if (x.length < N || !shifts.length) return [];
	const lines = spectralLines(powerSpectrum(x, new Fft(N), N / 2), fs / N);
	const maxShift = Math.max(...shifts);
	const pairs: FskPair[] = [];
	for (let i = 0; i < lines.length; i++)
		for (let j = i + 1; j < lines.length; j++) {
			const d = lines[j].hz - lines[i].hz;
			if (d > maxShift + tolHz + 2) break;
			let si = -1;
			let bestErr = tolHz;
			for (let q = 0; q < shifts.length; q++)
				if (Math.abs(d - shifts[q]) < bestErr) {
					bestErr = Math.abs(d - shifts[q]);
					si = q;
				}
			if (si < 0) continue;
			pairs.push({ lowHz: lines[i].hz, shiftIdx: si, shiftHz: shifts[si], score: Math.min(lines[i].p, lines[j].p) });
		}
	pairs.sort((a, b) => b.score - a.score);
	const out: FskPair[] = [];
	for (const p of pairs) {
		const dup = out.some((q) => q.shiftIdx === p.shiftIdx && Math.abs(q.lowHz - p.lowHz) < 25);
		// the weaker pairs are side lobes of the lines of the stronger ones
		if (!dup && p.score >= 0.15 * pairs[0].score) out.push(p);
		if (out.length >= maxPairs) break;
	}
	return out;
}

/** The run lengths of the keying: which tone is stronger over 3.5 ms, flip by flip. */
function keyingRuns(x: Float32Array, fs: number, lowHz: number, shiftHz: number): number[] {
	const len = Math.max(8, Math.round(fs * 0.0035));
	const ba = new Float64Array(2 * len);
	const bb = new Float64Array(2 * len);
	let [sar, sai, sbr, sbi, pa, pb] = [0, 0, 0, 0, 0, 0];
	const wa = (2 * Math.PI * lowHz) / fs;
	const wb = (2 * Math.PI * (lowHz + shiftHz)) / fs;
	const runs: number[] = [];
	let [cur, run, bi] = [0, 0, 0];
	for (let i = 0; i < x.length; i++) {
		const [mar, mai] = [x[i] * Math.cos(pa), -x[i] * Math.sin(pa)];
		const [mbr, mbi] = [x[i] * Math.cos(pb), -x[i] * Math.sin(pb)];
		pa = (pa + wa) % (2 * Math.PI);
		pb = (pb + wb) % (2 * Math.PI);
		sar += mar - ba[2 * bi];
		sai += mai - ba[2 * bi + 1];
		ba[2 * bi] = mar;
		ba[2 * bi + 1] = mai;
		sbr += mbr - bb[2 * bi];
		sbi += mbi - bb[2 * bi + 1];
		bb[2 * bi] = mbr;
		bb[2 * bi + 1] = mbi;
		if (++bi >= len) bi = 0;
		const d = sar * sar + sai * sai > sbr * sbr + sbi * sbi ? 1 : -1;
		if (i < len) {
			cur = d;
			continue;
		}
		if (d === cur) {
			run++;
			continue;
		}
		if (run > 0) runs.push(run);
		cur = d;
		run = 1;
	}
	return runs;
}

/** The symbol rate of an FSK pair from the run lengths of the keying. */
export function measureFskBaud(x: Float32Array, fs: number, lowHz: number, shiftHz: number, bauds: number[]): FskBaud {
	const r: FskBaud = { best: -1, second: -1, confidence: 0 };
	if (x.length < fs * 2 || !bauds.length) return r;
	// short flips are noise: fold them into their neighbours
	const sec: number[] = [];
	let acc = 0;
	const minLen = 0.4 / 110;
	for (const v of keyingRuns(x, fs, lowHz, shiftHz)) {
		const s = v / fs;
		if (s < minLen) {
			acc += s;
			continue;
		}
		sec.push(s + acc);
		acc = 0;
	}
	if (sec.length < 8) return r;
	// bit times and half bit times (the stop bit is 1.5 long, so the grid is half a bit)
	const sc = bauds.map((b) => sec.reduce((c, s) => c + Math.cos(2 * Math.PI * s * b * 2), 0) / sec.length);
	let i1 = 0;
	for (let b = 1; b < bauds.length; b++) if (sc[b] > sc[i1]) i1 = b;
	let i2 = -1;
	for (let b = 0; b < bauds.length; b++) if (b !== i1 && (i2 < 0 || sc[b] > sc[i2])) i2 = b;
	r.best = i1;
	r.second = i2;
	r.confidence = i2 < 0 ? 1 : Math.max(0, Math.min(1, (sc[i1] - sc[i2]) / Math.max(0.05, Math.abs(sc[i1]))));
	return r;
}

/** Score of a string of text: letters, digits and spaces count, line ends a little, the rest half. */
export function textScore(t: string): number {
	let g = 0;
	for (const c of t) {
		if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === ' ') g += 1;
		else if (c === '\r' || c === '\n') g += 0.3;
		else g += 0.5;
	}
	return g;
}

/** The decoder over the audio with the pair given: yields every STEP samples, returns the guess. */
function* trial(x: Float32Array, p: FskPair, bi: number, reverse: boolean): Generator<void, RttyAutoHyp> {
	const d = new RttyDecoder();
	d.configure({ baudIdx: bi, shiftIdx: p.shiftIdx, reverse });
	d.fixedLo = p.lowHz;
	d.reset();
	for (let i = 0; i < x.length; i += STEP) {
		d.run(x.subarray(i, Math.min(x.length, i + STEP)));
		yield;
	}
	return {
		lowHz: p.lowHz,
		shiftIdx: p.shiftIdx,
		shiftHz: RTTY_SHIFTS[p.shiftIdx],
		baudIdx: bi,
		baud: RTTY_BAUDS[bi],
		reverse,
		chars: d.chars,
		errors: d.framingErrors,
		score: textScore(d.text) - 2.5 * d.framingErrors,
	};
}

/**
 * Speed, shift and polarity from the audio alone (8 kHz, a few seconds to about 20 s of a signal that is on): the
 * pairs of tones (shift from the table), the likely speeds from the keying, then the decoder itself over the audio for
 * each guess and both polarities, ranked by the text they give. Best first, at most maxHyps; empty when nothing sends
 * RTTY. A generator: it stops after each step, the result is its return value.
 */
export function* rttyAutoAnalyse(audio: Float32Array, maxHyps = 3): Generator<void, RttyAutoHyp[]> {
	const fs = RTTY_RATE;
	if (audio.length < 3 * fs) return [];
	const pairs = findFskPairs(audio, fs, RTTY_SHIFTS, 4, 10);
	yield;
	if (!pairs.length) return [];
	const pick: Array<{ p: FskPair; bauds: number[] }> = [];
	for (const p of pairs) {
		const fb = measureFskBaud(audio, fs, p.lowHz, p.shiftHz, RTTY_BAUDS);
		const bauds: number[] = [];
		if (fb.best >= 0 && fb.confidence >= 0.2) {
			bauds.push(fb.best);
			if (fb.second >= 0) bauds.push(fb.second);
		}
		pick.push({ p, bauds: bauds.length ? bauds : RTTY_BAUDS.map((_, i) => i) });
		yield;
	}
	// the decoder over the audio for each guess; the last 20 s of it at most
	const x = audio.subarray(audio.length - Math.min(audio.length, 20 * fs));
	const all: RttyAutoHyp[] = [];
	for (const { p, bauds } of pick) for (const bi of bauds) for (const reverse of [false, true]) all.push(yield* trial(x, p, bi, reverse));
	all.sort((a, b) => b.score - a.score);
	const res: RttyAutoHyp[] = [];
	for (const h of all) {
		if (res.length >= maxHyps || h.score < 8 || h.chars < 8) break;
		res.push(h);
	}
	return res;
}

/** Runs the analysis to its end at once. */
export function rttyAutoAnalyseNow(audio: Float32Array, maxHyps = 3): RttyAutoHyp[] {
	const steps = rttyAutoAnalyse(audio, maxHyps);
	for (;;) {
		const r = steps.next();
		if (r.done) return r.value;
	}
}
