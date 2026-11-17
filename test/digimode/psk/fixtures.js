// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir core/src/psk/psk_gen.cpp (PskGenerator: each signal with its own
// audio frequency, modulation, text, start, drift and clock error, the raised-cosine symbol shaping, BPSK reversals for
// zeros, QPSK with fldigi's mapping of the K = 5 code, the idle reversals before and after the text; pskTestSignals)
// and tests/psk/test_psk_rx.cpp (sig, the run of a receiver over the generated band), https://github.com/adswill/OnAir;
// see third_party/onair. Changes: the band is made at any rate as interleaved I/Q; the noise is Gaussian from a seeded
// generator; no 8PSK.

import { PSK_MODES } from '@/worker/decoders/digimode/psk';
import { ConvEncoder, qpskTurns, varicodeBits } from '@/worker/decoders/digimode/psk/varicode';
import { gauss } from '../rtty/fixtures';

export { gauss };

/** A test signal (OnAir's PskGenSignal defaults; the tests send once, as sig() does). */
export function sig(hz, text, snrDb, mode = 0, extra = {}) {
	return {
		offsetHz: hz,
		mode,
		text,
		snrDb,
		startSec: 0.3,
		idleSec: 1,
		pauseSec: 2,
		repeat: false,
		driftHzPerMin: 0,
		clockPpm: 0,
		phase0: 0,
		...extra,
	};
}

/** The phase steps (eighth turns) of one sending. */
function turnsOf(s) {
	const baud = PSK_MODES[s.mode].baud;
	const idle = Math.max(8, Math.floor(s.idleSec * baud));
	const bits = [...new Array(idle).fill(0), ...varicodeBits(s.text), ...new Array(idle).fill(0)];
	if (!PSK_MODES[s.mode].qpsk) return bits.map((b) => (b ? 0 : 4));
	const enc = new ConvEncoder();
	for (let k = 0; k < 8; k++) bits.push(0); // flush the code
	return bits.map((b) => 2 * qpskTurns(enc.encode(b)));
}

/** One sender of the generator. */
function sender(s, rate, sigma) {
	const baud = PSK_MODES[s.mode].baud;
	return {
		s,
		amp: Math.sqrt(((2 * sigma * sigma * baud) / rate) * 10 ** (s.snrDb / 10)),
		T: (1 + s.clockPpm * 1e-6) / baud,
		ph: 0,
		turns: [],
		idx: 0,
		u: 0,
		prev: [0, 0],
		cur: [0, 0],
		on: false,
		done: false,
		offLeft: s.startSec,
	};
}

function build(g) {
	g.turns = turnsOf(g.s);
	g.idx = 0;
	g.u = 0;
	g.prev = [0, 0];
	g.cur = [Math.cos(g.s.phase0), Math.sin(g.s.phase0)];
}

/** The next symbol: its phase from the previous one and the step; after the last one the carrier fades out. */
function nextSymbol(g) {
	g.u -= 1;
	g.prev = g.cur;
	if (++g.idx > g.turns.length) {
		g.on = false;
		if (!g.s.repeat) g.done = true;
		else g.offLeft = g.s.pauseSec;
		return false;
	}
	if (g.idx < g.turns.length) {
		const a = (g.turns[g.idx] * Math.PI) / 4;
		g.cur = [g.prev[0] * Math.cos(a) - g.prev[1] * Math.sin(a), g.prev[0] * Math.sin(a) + g.prev[1] * Math.cos(a)];
	} else g.cur = [0, 0];
	return true;
}

/**
 * The band as interleaved I/Q at `rate`, the dial at `dialOffsetHz` (a signal at audio frequency f is at
 * dialOffsetHz + f), complex Gaussian noise of `noiseSigma` per component.
 */
export function pskBand(seconds, signals, { rate = 24000, dialOffsetHz = -2000, cfoHz = 0, noiseSigma = 0.02, seed = 1 } = {}) {
	const n = Math.round(seconds * rate);
	const out = new Float32Array(2 * n);
	const dt = 1 / rate;
	for (const g of signals.map((s) => sender(s, rate, noiseSigma > 0 ? noiseSigma : 0.02))) {
		for (let i = 0; i < n && !g.done; i++) {
			const t = i * dt;
			const f = dialOffsetHz + cfoHz + g.s.offsetHz + (g.s.driftHzPerMin * t) / 60;
			g.ph = (g.ph + 2 * Math.PI * f * dt) % (2 * Math.PI);
			if (!g.on) {
				g.offLeft -= dt;
				if (g.offLeft > 0) continue;
				g.on = true;
				build(g);
			}
			g.u += dt / g.T;
			if (g.u >= 1 && !nextSymbol(g)) continue;
			const w = 0.5 + 0.5 * Math.cos(Math.PI * g.u);
			const br = g.prev[0] * w + g.cur[0] * (1 - w);
			const bi = g.prev[1] * w + g.cur[1] * (1 - w);
			const [c, s] = [Math.cos(g.ph), Math.sin(g.ph)];
			out[2 * i] += g.amp * (br * c - bi * s);
			out[2 * i + 1] += g.amp * (br * s + bi * c);
		}
	}
	if (noiseSigma > 0) {
		const gn = gauss(seed);
		for (let i = 0; i < out.length; i++) out[i] += noiseSigma * gn();
	}
	return out;
}

/** OnAir's pskTestSignals: the test band. */
export function pskTestSignals() {
	return [
		sig(700, 'CQ CQ CQ DE LY2ABC LY2ABC KO24 PSE K\n', 0, 0, { repeat: true }),
		sig(1050, 'DL1XYZ DE G4ABC UR RST 599 NAME JOHN QTH LONDON\nBTU DL1XYZ DE G4ABC KN\n', -3, 0, {
			repeat: true,
			startSec: 1.1,
			driftHzPerMin: 3,
		}),
		sig(1500, 'CQ TEST DE OK1XX OK1XX TEST\n', -6, 0, { repeat: true, startSec: 0.6, clockPpm: 80 }),
		sig(2200, 'SP5AB DE EA3XYZ TNX FER QSO 73 SK\n', -2, 0, { repeat: true, startSec: 2 }),
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
export const hzOf = (record) => Number(field(record, 'Audio frequency').split(' ')[0]);

/** Feeds a channel to a decoder in blocks of `block` complex samples. */
export function feed(decoder, iq, block = 2400) {
	for (let i = 0; i < iq.length; i += 2 * block) decoder.process(iq.subarray(i, Math.min(iq.length, i + 2 * block)));
}

/** The text of the signal near `hz`: its records, one line each. */
export const textNear = (records, hz, tol = 20) =>
	records
		.filter((r) => Math.abs(hzOf(r) - hz) <= tol)
		.map((r) => r.text.slice(r.text.indexOf(': ') + 2))
		.join('\n');
