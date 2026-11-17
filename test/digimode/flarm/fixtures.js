// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir core/src/flarm/flarm_gen.cpp (chipsOf, flarmBurst, flarmScene,
// flarmDemoAircraft, FlarmSynth::scheduleSecond), core/src/adsl/adsl_gen.cpp (adslTrafficNet, adslBurst, adslScene),
// core/src/adsl/adsl_proto.cpp (frameChips, the M-band) and tests/flarm/test_flarm_rx.cpp (mk, twice),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: the scenes are made at the decoder's 400 kS/s
// (or any rate) around 868.3 MHz with ADS-L on the M-band only; the noise is complex Gaussian from BrowSDR's seeded
// generator (OnAir: mt19937 and PortableNormal); bursts are mixed into a Float32Array of interleaved I/Q.

import { gauss } from '../ftx/fixtures';
import { emptyV6, encodeV6, frameToChips, packPosition, packVelocity } from '@/worker/decoders/digimode/flarm/flarm-proto';
import { emptyTraffic, makeData, makeNetwork, packTraffic, TYPE_TRAFFIC } from '@/worker/decoders/digimode/flarm/adsl-proto';
import { lowpassTaps } from '@/worker/decoders/digimode/tones/dsp';

export const RATE = 400000;
export const REF_LAT = 54.7;
export const REF_LON = 25.3;
/** A key time 20 s into a 64 s step (test_flarm_impair.cpp). */
export const U0 = 1800000000 - (1800000000 % 64) + 20;

/** GFSK chips (±dev Hz) at `rate` with a Gaussian of `bt`, carrier offset `cfoHz`, gain in dB, chip clock error in ppm. */
export function gfsk(chips, rate, { chipRate = 100000, dev = 50000, bt = 0.5, cfoHz = 0, gainDb = 0, ppm = 0 } = {}) {
	const tchip = (1 + ppm * 1e-6) / chipRate;
	const sigma = (0.1325 / bt) * tchip;
	const n = Math.floor((chips.length + 6) * tchip * rate);
	const fr = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const c = Math.max(0, Math.min(chips.length - 1, Math.floor(i / rate / tchip - 3)));
		fr[i] = chips[c] ? 1 : -1;
	}
	const half = Math.ceil(3 * sigma * rate);
	const g = Float64Array.from({ length: 2 * half + 1 }, (_, k) => Math.exp(-0.5 * ((k - half) / rate / sigma) ** 2));
	const gs = g.reduce((a, b) => a + b, 0);
	const out = new Float32Array(2 * n);
	let ph = 0;
	for (let i = 0; i < n; i++) {
		let s = 0;
		for (let k = -half; k <= half; k++) s += g[k + half] * fr[Math.max(0, Math.min(n - 1, i + k))];
		ph += (2 * Math.PI * ((dev * s) / gs + cfoHz)) / rate;
		out[2 * i] = Math.cos(ph);
		out[2 * i + 1] = Math.sin(ph);
	}
	const ramp = Math.min(n >> 1, Math.floor(rate * 4e-6) + 1);
	for (let i = 0; i < ramp; i++)
		for (const j of [i, n - 1 - i]) {
			out[2 * j] *= i / ramp;
			out[2 * j + 1] *= i / ramp;
		}
	const amp = 10 ** (gainDb / 20);
	return out.map((v) => v * amp);
}

/** A FLARM packet to send: `{ timeSec, channel, pkt | raw, keyTime, gainDb, cfoHz, badCrc }` (flarm_gen.h FlarmTx). */
export function flarmChips(tx) {
	const pay = tx.raw ? Uint8Array.from({ length: 24 }, (_, i) => tx.raw[i] ?? 0) : encodeV6(tx.pkt, tx.keyTime);
	const chips = Array.from({ length: 16 }, (_, i) => i & 1); // preamble 0101..., then the sync word and the frame
	const f = frameToChips(pay, true);
	if (tx.badCrc) {
		f[104] ^= 1;
		f[105] ^= 1;
	}
	return [...chips, ...f];
}

/** The ADS-L M-band frame chips: preamble, "1001 1001", sync, length and packet, Manchester coded (adsl_proto.cpp). */
export function adslChips(net, preamble = 8) {
	const c = [];
	for (let i = 0; i < preamble; i++) c.push(0, 1);
	for (let i = 0; i < 2; i++) c.push(1, 0, 0, 1);
	for (const b of [0x72, 0x4b, net.length, ...net])
		for (let k = 7; k >= 0; k--) {
			const bit = (b >> k) & 1;
			c.push(bit ^ 1, bit);
		}
	return c;
}

/**
 * Radio samples centred on 868.3 MHz (`centreHz` moves it): each burst `{ timeSec, channelHz, chips, cfoHz, gainDb }`
 * mixed to its channel, plus white noise for an SNR of a 0 dB burst in 200 kHz (none below -100 dB).
 */
export function scene(rate, durationSec, bursts, snrDb, { ppm = 0, seed = 1, centreHz = 868.3e6 } = {}) {
	const count = Math.floor(durationSec * rate);
	const out = new Float32Array(2 * count);
	for (const b of bursts) {
		const s = gfsk(b.chips, rate, { cfoHz: b.cfoHz ?? 0, gainDb: b.gainDb ?? 0, ppm, dev: b.dev ?? 50000 });
		const s0 = Math.floor(b.timeSec * rate);
		const w = (2 * Math.PI * (b.channelHz - centreHz)) / rate;
		for (let i = 0; i < s.length >> 1 && s0 + i < count; i++) {
			const a = w * (s0 + i);
			const [c, sn] = [Math.cos(a), Math.sin(a)];
			out[2 * (s0 + i)] += s[2 * i] * c - s[2 * i + 1] * sn;
			out[2 * (s0 + i) + 1] += s[2 * i] * sn + s[2 * i + 1] * c;
		}
	}
	if (snrDb > -100) {
		const sigma = Math.sqrt(rate / 200000 / 10 ** (snrDb / 10) / 2);
		const g = gauss(seed);
		for (let i = 0; i < out.length; i++) out[i] += sigma * g();
	}
	return out;
}

/**
 * A scene made at `factor` times the rate and filtered down (pass ±180 kHz, stop ±200 kHz), as a receiver's DDC hands it
 * over: a signal next to the band edge does not fold back into it as one made at 400 kS/s would.
 */
export function wideScene(durationSec, bursts, snrDb, { factor = 4, ...opts } = {}) {
	const wide = scene(RATE * factor, durationSec, bursts, snrDb, opts);
	const taps = lowpassTaps(180000, 200000, RATE * factor, 60, 9);
	const count = Math.floor(wide.length / 2 / factor) - taps.length;
	const out = new Float32Array(2 * count);
	for (let i = 0; i < count; i++) {
		let re = 0;
		let im = 0;
		for (let k = 0, j = i * factor; k < taps.length; k++, j++) {
			re += taps[k] * wide[2 * j];
			im += taps[k] * wide[2 * j + 1];
		}
		out[2 * i] = re;
		out[2 * i + 1] = im;
	}
	return out;
}

/** FLARM transmissions as bursts of `scene` (channel 0 at 868.2, 1 at 868.4 MHz). */
export const flarmBursts = (txs) =>
	txs.map((tx) => ({
		timeSec: tx.timeSec,
		channelHz: tx.channel ? 868.4e6 : 868.2e6,
		chips: flarmChips(tx),
		cfoHz: tx.cfoHz,
		gainDb: tx.gainDb,
	}));

export const flarmScene = (rate, durationSec, txs, snrDb, opts) => scene(rate, durationSec, flarmBursts(txs), snrDb, opts);

/** A V6 transmission of an aircraft `dn` / `de` metres from the reference (test_flarm_rx.cpp mk). */
export function mk(t, channel, id, dn, de, acType = 1, u0 = U0) {
	const p = emptyV6();
	p.addr = id;
	p.aircraftType = acType;
	p.alt = 800;
	Object.assign(p, packPosition(REF_LAT + dn / 111320, REF_LON + de / (111320 * Math.cos((REF_LAT * Math.PI) / 180))));
	packVelocity(25, 90, 1, p);
	return { timeSec: t, channel, keyTime: Math.floor(u0 + t), pkt: p };
}

/** Every packet sent twice, 2.4 s apart: an aircraft counts when a second packet agrees with the first. */
export const twice = (txs, u0 = U0) => [
	...txs,
	...txs.map((tx) => ({
		...tx,
		timeSec: tx.timeSec + 2.4,
		keyTime: tx.keyTime === undefined ? undefined : tx.keyTime - Math.floor(u0 + tx.timeSec) + Math.floor(u0 + tx.timeSec + 2.4),
	})),
];

/** The ADS-L network packet of a Traffic message (adsl_gen.cpp adslTrafficNet). */
export const adslTrafficNet = (t, version = 1, keyIndex = 0, fec = false) =>
	makeNetwork(makeData(TYPE_TRAFFIC, t.amt, t.addr, t.relay, packTraffic(t)), version, keyIndex, fec);

/** A gliding FLARM-addressed ADS-L aircraft (test_adsl_rx.cpp ac). */
export function adslAircraft(id, cat = 4, lat = 54.7, lon = 25.3) {
	return Object.assign(emptyTraffic(), {
		amt: 6,
		addr: id,
		category: cat,
		flightState: 2,
		emergency: 1,
		hasPos: true,
		lat,
		lon,
		hasAlt: true,
		altM: 1234,
		hasSpeed: true,
		speedMs: 31.5,
		hasClimb: true,
		climbMs: -1.25,
		hasTrack: true,
		trackDeg: 247.5,
		hAcc: 6,
		vAcc: 2,
		velAcc: 2,
	});
}

/** An ADS-L transmission as a burst of `scene` on the M-band channel (0: 868.2, 1: 868.4 MHz). */
export const adslBurst = (timeSec, channel, net, { cfoHz = 0, gainDb = 0, preamble = 8 } = {}) => ({
	timeSec,
	channelHz: channel ? 868.4e6 : 868.2e6,
	chips: adslChips(net, preamble),
	cfoHz,
	gainDb,
});

/** Records and the decoder after feeding `iq` in blocks of `block` samples. */
export function runDecoder(Decoder, iq, { block = 16384, setup = () => {}, options } = {}) {
	const records = [];
	const statuses = [];
	const decoder = new Decoder({ record: (r) => records.push(r), status: (m, locked) => statuses.push([m, locked]) }, options);
	setup(decoder);
	for (let i = 0; i < iq.length; i += 2 * block) decoder.process(iq.subarray(i, Math.min(iq.length, i + 2 * block)));
	return { records, statuses, decoder };
}

export const field = (record, label) => record.fields.find(([name]) => name === label)?.[1];
