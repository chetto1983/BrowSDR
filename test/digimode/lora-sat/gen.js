// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir core/src/lorasat/lorasat_gen.cpp (LoraSatPass: the straight-line
// pass model of the Doppler shift, its rate and the stretched symbol clock; loraSatBeacons; the generator's frames with
// the radio's frequency and clock errors on top) and tests/lorasat/test_lorasat_rx.cpp (framesAt, decoded),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: the frames are rendered by phy.js (OnAir's TxFrame)
// straight into the decoder's channel at its rate, centred on the VFO (OnAir: a 2 MS/s capture with the dial 300 kHz
// off); inverted IQ, other sync words and implicit-header frames added for BrowSDR.

import { autoLdro, loraParams } from '@/worker/decoders/digimode/lora/code';
import { LoraSatDecoder } from '@/worker/decoders/digimode/lora-sat';
import { streamSignal, txFrame } from '../lora/phy';

const C = 299792458;

/** A satellite passing straight over a station: closest at tcaSec, closestKm away, at speedMS. */
export class LoraSatPass {
	constructor({ carrierMhz = 436.8, speedMS = 7560, closestKm = 600, tcaSec = 300 } = {}) {
		Object.assign(this, { carrierMhz, speedMS, closestKm, tcaSec });
	}
	dopplerHz(t) {
		const a = (this.closestKm * 1e3) / this.speedMS,
			d = t - this.tcaSec;
		return (this.carrierMhz * 1e6 * (this.speedMS / C) * -d) / Math.sqrt(d * d + a * a);
	}
	rateHzS(t) {
		const a = (this.closestKm * 1e3) / this.speedMS,
			d = t - this.tcaSec,
			u = d * d + a * a;
		return (-this.carrierMhz * 1e6 * (this.speedMS / C) * a * a) / (u * Math.sqrt(u));
	}
	/** How much the satellite's clock appears slow (+) or fast (-). */
	stretchPpm(t) {
		return (-1e6 * this.dopplerHz(t)) / (this.carrierMhz * 1e6);
	}
}

/** A beacon payload with a counter, as OnAir's loraSatBeacons writes it. */
export function beaconText(n, bytes = 24) {
	const s = `SAT-BCN #${String(n).padStart(4, '0')} bat=${(3.6 + 0.01 * (n % 20)).toFixed(2)}V t=+${18 + (n % 7)}`;
	const p = Array.from(s.slice(0, bytes), (c) => c.charCodeAt(0));
	while (p.length < bytes) p.push(65 + (p.length % 26));
	return Uint8Array.from(p);
}

/** LoRa settings of a beacon: 4/8, CRC, preamble 8, low data rate optimisation as the radios set it. */
export const beaconParams = (sf, bwHz, sync, over = {}) =>
	loraParams({ sf, bwHz, cr: 8, crc: true, preamble: 8, syncWord: sync, ldro: autoLdro(sf, bwHz), ...over });

/**
 * Frames of one setting at the given pass times, one every `gap` seconds from 0.3 s (OnAir framesAt), Doppler, rate and
 * stretched clock from the pass, plus a radio error cfoHz and a clock error sroPpm.
 */
export function framesAt(
	pass,
	p,
	passTimes,
	gap,
	{ bytes = 20, snrDb = 10, cfoHz = 0, sroPpm = 0, inverted = false, doppler = true, rate = true, first = 0 } = {},
) {
	return passTimes.map((pt, i) => {
		const payload = beaconText(first + i, bytes);
		const f = txFrame(p, payload, {
			startSec: 0.3 + i * gap,
			freqHz: cfoHz + (doppler ? pass.dopplerHz(pt) : 0),
			freqRateHzS: doppler && rate ? pass.rateHzS(pt) : 0,
			sroPpm: sroPpm + (doppler ? pass.stretchPpm(pt) : 0),
			snrDb,
			inverted,
			phase0: (0.37 * (i + 1)) % 1,
		});
		return { ...f, payload, passSec: pt };
	});
}

/** Seconds of signal the frames need, with 0.3 s after the last. */
export const seconds = (frames) => Math.max(...frames.map((f) => f.endSec)) + 0.3;

/** How many frames came out right: the payload text equal, the CRC good, the spreading factor theirs. */
export function decoded(records, frames) {
	let n = 0;
	for (const f of frames) {
		const want = String.fromCharCode(...f.payload);
		if (records.some((r) => !r.damaged && field(r, 'Text') === want && field(r, 'Spreading factor') === `SF${f.p.sf}`)) n++;
	}
	return n;
}

/** A record's field. */
export const field = (record, label) => record.fields?.find(([k]) => k === label)?.[1];

/** A field's leading number ("+8.32 kHz (...)" is 8.32). */
export const fieldNumber = (record, label) => parseFloat(String(field(record, label)).replace('−', '-'));

/**
 * The frames over noise into a new LoRa satellite decoder of `band`, chunk by chunk; `loraSat` (or a function of the signal
 * time, as the app's updates) gives its VFO parameters. Records, status lines, decoder, processing time and seconds.
 */
export function runSat(band, frames, { freqMHz = 436.8, loraSat, chunk = 16384, seed = 1, noiseRms = 0.05, durationSec } = {}) {
	const records = [];
	const status = [];
	const decoder = new LoraSatDecoder({ record: (r) => records.push(r), status: (m, locked) => status.push([m, locked]) }, band);
	const options = (t) => ({ freqMHz, loraSat: typeof loraSat === 'function' ? loraSat(t) : loraSat });
	decoder.setOptions(options(0));
	let ms = 0,
		done = 0;
	const secs = streamSignal(
		frames,
		(iq) => {
			if (typeof loraSat === 'function') decoder.setOptions(options(done / band.rate));
			const t0 = performance.now();
			decoder.process(iq);
			ms += performance.now() - t0;
			done += iq.length >> 1;
		},
		{ rate: band.rate, noiseRms, durationSec: durationSec ?? (frames.length ? seconds(frames) : 1), chunk, seed },
	);
	return { records, status, decoder, ms, secs };
}

/** Per cent of one core: processing time over signal time. */
export const core = (r) => (r.ms / r.secs) * 0.1;
