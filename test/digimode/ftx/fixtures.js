// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir core/src/hfdig/hfdig_ftx_gen.cpp (ftxTestStations, the test
// audio of every slot), core/src/hfdig/hfdig_ftx.cpp (addWave, ftxAddTransmission), core/src/hfdig/hfdig_gen.cpp (the
// test audio as an upper sideband over noise) and tests/hfdig/hfdig_ftx_testutil.h (ampFor: a station's SNR in
// 2500 Hz against white noise of 0 .. 4 kHz), https://github.com/adswill/OnAir; see third_party/onair. Changes: the
// sideband is made directly as a complex tone (no Hilbert filter), centred on the channel 1.7 kHz above the dial; the
// noise is complex Gaussian from a seeded generator.

import { pack77 } from '@/worker/decoders/digimode/ftx/pack';
import { wsprSymbols } from '@/worker/decoders/digimode/wspr/codec';
import { envelope, ftxTones, gfskPulse, leadOf, spec } from '@/worker/decoders/digimode/ftx/wave';

export const FT8 = 0;
export const FT4 = 1;
export const WSPR = 3;
/** 2026-01-01 00:00:00 UTC: the start of a slot of every mode. */
export const T0 = 1767225600;
export const RATE = 8000;
export const OFFSET_HZ = 1700;
/** Noise per component of the complex channel at 8 kHz (the audio then has this sigma over 0 .. 4 kHz). */
export const SIGMA = 0.05;

/** The stations of OnAir's test audio of a mode: message, audio frequency, level against the first (dB), DT. */
export function ftxTestStations(mode) {
	if (mode === FT8)
		return [
			['CQ K1ABC FN42', 600, 0, 0.0],
			['K1ABC W9XYZ -12', 900, -6, 0.3],
			['W9XYZ K1ABC R-05', 1250, -10, -0.4],
			['CQ PJ4/K1ABC', 1500, -3, 0.1],
			['TNX BOB 73 GL', 1800, -12, 0.6],
			['G4ABC DL1XYZ RR73', 2100, -8, 0.0],
			['CQ JA1XYZ PM95', 2450, -14, 1.0],
			['7123456789ABCDEF01', 2800, -9, -0.2],
		].map(([msg, hz, relDb, dt]) => ({ msg, hz, relDb, dt }));
	if (mode === FT4)
		return [
			['CQ K1ABC FN42', 700, 0, 0.0],
			['K1ABC W9XYZ EN37', 1100, -5, 0.2],
			['W9XYZ K1ABC +03', 1600, -8, -0.3],
			['CQ TEST DL1XYZ JO62', 2100, -3, 0.0],
			['VK2ABC ZL1XYZ 73', 2600, -10, 0.5],
		].map(([msg, hz, relDb, dt]) => ({ msg, hz, relDb, dt }));
	return [
		['K1ABC FN42 37', 1450, 0, 0.0],
		['G4XYZ IO91 23', 1480, -6, 0.5],
		['PJ4/K1ABC 30', 1520, -10, -0.5],
		['DL1XYZ/P 10', 1550, -4, 1.0],
		['<K1ABC> FN42AX 37', 1580, -8, 0.2],
	].map(([msg, hz, relDb, dt]) => ({ msg, hz, relDb, dt }));
}

/** The amplitude of a tone with this SNR in 2500 Hz against SIGMA. */
export const ampFor = (snrDb, sigma = SIGMA) => Math.sqrt(2 * 10 ** (snrDb / 10) * sigma * sigma * (2500 / 4000));

/** The tones of a message, null when it cannot be sent. */
export function tonesOf(mode, msg) {
	if (mode === WSPR) return wsprSymbols(msg);
	const b = new Uint8Array(77);
	return pack77(msg, b) ? ftxTones(mode, b) : null;
}

/**
 * OnAir's addWave as a complex tone: adds a transmission to re / im (rate Hz, from sample `start`, may be negative or
 * past the end): tone 0 at f0 Hz (against the channel centre: the audio frequency minus the offset), amplitude amp.
 */
export function addWave(mode, tones, f0, amp, rate, start, mirrored, re, im) {
	const s = spec(mode);
	const lead = leadOf(mode);
	const nsym = tones.length;
	const total = nsym + 2 * lead;
	const T = s.symSec;
	const sg = mirrored ? -1 : 1;
	const ext = (k) => tones[Math.max(0, Math.min(nsym - 1, k - lead))];
	const n0 = Math.max(0, Math.ceil(start));
	const n1 = Math.min(re.length, Math.floor(start + total * T * rate));
	let ph = 0;
	for (let n = n0; n < n1; n++) {
		const u = (n - start) / (T * rate);
		let dev;
		if (s.bt <= 0) dev = ext(Math.floor(u));
		else {
			dev = 0;
			const k0 = Math.floor(u);
			for (let k = k0 - 2; k <= k0 + 2; k++) dev += ext(k) * gfskPulse(s.bt, u - k - 0.5);
		}
		const env = amp * envelope(mode, u, total);
		re[n] += env * Math.cos(ph);
		im[n] += env * Math.sin(ph);
		ph += (2 * Math.PI * (f0 + sg * s.spacing * dev)) / rate;
		if (Math.abs(ph) > 1e4) ph %= 2 * Math.PI;
	}
}

/** Seeded standard normal numbers (xorshift32 and Box-Muller), so failures reproduce. */
export function gauss(seed) {
	let x = (seed * 2654435761 + 1) >>> 0 || 1;
	const u = () => {
		x ^= x << 13;
		x >>>= 0;
		x ^= x >>> 17;
		x ^= x << 5;
		x >>>= 0;
		return (x + 0.5) / 2 ** 32;
	};
	return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

/**
 * The channel of `slots` slots of a mode (plus `tail` seconds) as interleaved I/Q at 8 kHz, centred 1.7 kHz above the
 * dial: every station `{ msg, hz, snrDb, dt }` in every slot, from sample 0 = the start of a slot (or `startSec` into
 * it), over complex noise of SIGMA per component (times `noise`). `dialHz` moves every tone.
 */
export function ftxChannel(mode, stations, { slots = 1, tail = 4, noise = 1, seed = 1, startSec = 0, dialHz = 0, mirrored = false } = {}) {
	const P = spec(mode).period;
	const t0 = spec(mode).t0;
	const count = Math.round((slots * P + tail - startSec) * RATE);
	const re = new Float64Array(count);
	const im = new Float64Array(count);
	for (let k = 0; k < slots; k++)
		for (const st of stations) {
			const tones = tonesOf(mode, st.msg);
			if (!tones) throw new Error(`cannot send "${st.msg}"`);
			const f0 = st.hz + dialHz - OFFSET_HZ;
			addWave(mode, tones, f0, ampFor(st.snrDb), RATE, (k * P + t0 + st.dt - startSec) * RATE, mirrored, re, im);
		}
	const iq = new Float32Array(2 * count);
	const g = gauss(seed);
	for (let n = 0; n < count; n++) {
		iq[2 * n] = re[n] + (noise ? SIGMA * noise * g() : 0);
		iq[2 * n + 1] = im[n] + (noise ? SIGMA * noise * g() : 0);
	}
	return iq;
}

/** OnAir's generator stations at their relative levels, the first at `topDb` in 2500 Hz. */
export const generatorStations = (mode, topDb) =>
	ftxTestStations(mode).map((s) => ({ msg: s.msg, hz: s.hz, snrDb: topDb + s.relDb, dt: s.dt }));

/** A sink that keeps what the decoder reports. */
export function ftxSink() {
	const sink = { records: [], statuses: [] };
	sink.record = (r) => sink.records.push(r);
	sink.status = (message, locked) => sink.statuses.push({ message, locked });
	return sink;
}

/**
 * Feeds the channel to a decoder made by `make(sink, options)` in blocks of `block` samples, with a clock in step with
 * the audio from `startUtc` (seconds); each slot is decoded as soon as it is complete (sliceMs Infinity) unless the
 * options say otherwise. Returns the sink and the decoder.
 */
export function receive(make, iq, { startUtc = T0, block = 800, options = {} } = {}) {
	const sink = ftxSink();
	let fed = 0;
	const decoder = make(sink, { now: () => (startUtc + fed / RATE) * 1000, sliceMs: Infinity, ...options });
	for (let i = 0; i < iq.length; i += 2 * block) {
		const part = iq.subarray(i, Math.min(iq.length, i + 2 * block));
		fed += part.length / 2;
		decoder.process(part);
	}
	decoder.flush();
	return { sink, decoder };
}

export const field = (record, label) => record.fields.find(([name]) => name === label)?.[1];
