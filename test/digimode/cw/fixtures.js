// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir core/src/cw/cw_gen.cpp (cwKeying with ARRL Farnsworth spacing,
// CwGenerator: keyed carriers with 4 ms raised-cosine edges, hand-keying jitter, QSB, drift, repeats with a pause;
// cwTestSignals) and tests/cw/test_cw_fistrx.cpp (decode, norm, editDistance), https://github.com/adswill/OnAir; see
// third_party/onair. Changes: the band is made at any rate as interleaved I/Q; the jitter and the noise are Gaussian
// from a seeded generator.

import { encodeSymbol, tokenize } from '@/worker/decoders/digimode/cw/morse';
import { gauss } from '../rtty/fixtures';

export { gauss };
const EDGE_SEC = 0.004;

/** Key-down / key-up durations (seconds, first a key-down) of a text at a speed, before jitter. */
export function cwKeying(text, wpm, fw = 0, dashRatio = 3) {
	const u = 1.2 / Math.max(1, wpm);
	let [cg, wg] = [3 * u, 7 * u];
	if (fw > 0 && fw < wpm) {
		const ta = (60 * wpm - 37.2 * fw) / (fw * wpm); // ARRL: the delay spread over the gaps
		[cg, wg] = [(3 * ta) / 19, (7 * ta) / 19];
	}
	const d = [];
	for (const tok of tokenize(text)) {
		if (tok === ' ') {
			if (d.length) d[d.length - 1] = wg;
			continue;
		}
		const code = encodeSymbol(tok);
		if (!code) continue;
		for (const c of code) d.push(c === '.' ? u : dashRatio * u, u);
		d[d.length - 1] = cg;
	}
	if (d.length) d[d.length - 1] = wg;
	return d;
}

/** A test signal (OnAir's CwGenSignal defaults). */
export function cwSig(hz, wpm, text, snrDb, extra = {}) {
	return {
		offsetHz: hz,
		wpm,
		farnsworthWpm: 0,
		text,
		snrDb,
		jitter: 0,
		dashRatio: 3,
		qsbDepthDb: 0,
		qsbPeriodSec: 0,
		driftHzPerMin: 0,
		startSec: 0.3,
		pauseSec: 2,
		repeat: true,
		...extra,
	};
}

/** One sending of the text, without the pause, s. */
export const messageSec = (s) => cwKeying(s.text, s.wpm, s.farnsworthWpm, s.dashRatio).reduce((a, b) => a + b, 0);

function newSending(g) {
	g.dur = cwKeying(g.s.text, g.s.wpm, g.s.farnsworthWpm, g.s.dashRatio);
	if (g.s.jitter > 0) g.dur = g.dur.map((v) => v * Math.max(0.4, Math.min(1.6, 1 + g.s.jitter * g.rng())));
	g.idx = 0;
	g.on = g.dur.length > 0;
	g.left = g.dur.length ? g.dur[0] : 1;
}

/** Advances a sender by dt: the key state of this sample. */
function step(g, dt) {
	g.left -= dt;
	while (g.left <= 0 && !g.done) {
		if (g.waiting) {
			g.waiting = false;
			const carry = g.left;
			newSending(g);
			g.left += carry;
			continue;
		}
		if (++g.idx >= g.dur.length) {
			g.on = false;
			if (!g.s.repeat) {
				g.done = true;
				break;
			}
			g.waiting = true;
			g.left += g.s.pauseSec;
			continue;
		}
		g.on = g.idx % 2 === 0;
		g.left += g.dur[g.idx];
	}
}

/**
 * The band as interleaved I/Q at `rate`, the dial at `dialOffsetHz` (a signal is heard at dial + its offset), complex
 * Gaussian noise of `noiseSigma` per component (SNRs are of the key-down carrier in 500 Hz).
 */
export function cwBand(seconds, signals, { rate = 24000, dialOffsetHz = 0, cfoHz = 0, noiseSigma = 0.02, seed = 1 } = {}) {
	const n = Math.round(seconds * rate);
	const out = new Float32Array(2 * n);
	const dt = 1 / rate;
	const sigma = noiseSigma > 0 ? noiseSigma : 0.02;
	signals.forEach((s, k) => {
		const g = {
			s,
			amp: Math.sqrt(10 ** (s.snrDb / 10) * 2 * sigma * sigma * (500 / rate)),
			ph: 0,
			dur: [],
			idx: 0,
			left: s.startSec,
			on: false,
			waiting: true,
			done: false,
			edge: 0,
			rng: gauss(seed * 7919 + k * 104729),
		};
		for (let i = 0; i < n; i++) {
			if (!g.done) step(g, dt);
			const key = g.on && !g.waiting && !g.done;
			g.edge = Math.max(0, Math.min(1, g.edge + ((key ? 1 : -1) * dt) / EDGE_SEC));
			if (g.edge <= 0) continue;
			const t = i * dt;
			let a = g.amp * (0.5 - 0.5 * Math.cos(Math.PI * g.edge));
			if (s.qsbDepthDb > 0 && s.qsbPeriodSec > 0)
				a *= 10 ** ((-s.qsbDepthDb / 20) * (0.5 - 0.5 * Math.cos((2 * Math.PI * t) / s.qsbPeriodSec)));
			const f = dialOffsetHz + cfoHz + s.offsetHz + (s.driftHzPerMin * t) / 60;
			g.ph = (g.ph + 2 * Math.PI * f * dt) % (2 * Math.PI);
			out[2 * i] += a * Math.cos(g.ph);
			out[2 * i + 1] += a * Math.sin(g.ph);
		}
	});
	if (noiseSigma > 0) {
		const gn = gauss(seed);
		for (let i = 0; i < out.length; i++) out[i] += noiseSigma * gn();
	}
	return out;
}

/** OnAir's cwTestSignals: the test band. */
export function cwTestSignals() {
	return [
		cwSig(-3000, 20, 'CQ CQ DE LY2ABC LY2ABC <AR> K', 0),
		cwSig(-1200, 28, 'TEST DL1XYZ DL1XYZ TEST', -3, { startSec: 1.1 }),
		cwSig(400, 16, 'LY2ABC DE G4ABC UR 599 <BT> NAME JOHN <KN>', -2, {
			farnsworthWpm: 10,
			jitter: 0.06,
			qsbDepthDb: 10,
			qsbPeriodSec: 7,
			startSec: 0.6,
		}),
		cwSig(2500, 35, '5NN TU OK1XX <SK>', -6, { startSec: 2 }),
	];
}

/** A sink that keeps what the decoder reports. */
export function recordingSink() {
	const sink = { records: [], statuses: [] };
	sink.record = (r) => sink.records.push(r);
	sink.status = (message, locked) => sink.statuses.push({ message, locked });
	return sink;
}

export const field = (record, name) => record.fields?.find(([k]) => k === name)?.[1];
const offsetOf = (record) => Number(field(record, 'Offset').split(' ')[0].replace('−', '-'));

/** Feeds a channel to a decoder in blocks of `block` complex samples. */
export function feed(decoder, iq, block = 2400) {
	for (let i = 0; i < iq.length; i += 2 * block) decoder.process(iq.subarray(i, Math.min(iq.length, i + 2 * block)));
}

/** The text of the signal near `hz`: its records, joined by spaces. */
export const textNear = (records, hz, tol = 30) =>
	records
		.filter((r) => Math.abs(offsetOf(r) - hz) <= tol)
		.map((r) => r.text.slice(r.text.indexOf(': ') + 2))
		.join(' ');

/** The decoder alone: durations (s) in, text out; idle() while the key is up, as a receiver does. */
export function decodeKeying(d, durSec) {
	let s = '';
	const take = () =>
		(s += d
			.pop()
			.map((t) => t.text)
			.join(''));
	durSec.forEach((v, i) => {
		const ms = v * 1000;
		if (i % 2 === 0) d.mark(ms);
		else {
			for (let k = 10; k < ms; k += 10) d.idle(k);
			d.space(ms);
		}
		take();
	});
	for (let k = 10; k < 3000; k += 10) d.idle(k);
	take();
	return s;
}

/** Spaces collapsed and trimmed. */
export const norm = (s) => s.replace(/ +/g, ' ').trim();

/** Edit distance of the whole reference anywhere in the decoded text. */
export function editDistance(ref, dec) {
	let prev = new Array(dec.length + 1).fill(0);
	for (let i = 1; i <= ref.length; i++) {
		const cur = [i];
		for (let j = 1; j <= dec.length; j++) cur[j] = Math.min(prev[j - 1] + (ref[i - 1] === dec[j - 1] ? 0 : 1), prev[j] + 1, cur[j - 1] + 1);
		prev = cur;
	}
	return Math.min(...prev);
}
