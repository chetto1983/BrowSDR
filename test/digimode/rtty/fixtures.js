// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir core/src/hfdig/hfdig_rtty.cpp (RttyTestAudio, makeRttyTxAudio:
// a looping transmission of the text, idle mark, LTRS, the shifts the text needs; kRttyTestText of hfdig_rtty.h) and
// tests/hfdig/test_hfdig_rtty.cpp (the noise of a given SNR in 3 kHz, textOk), https://github.com/adswill/OnAir; see
// third_party/onair. Changes: the transmission can also be made as a complex tone at any rate and offset (the channel
// the worker hands over); the noise is Gaussian from a seeded generator.

import { FIGS_CODE, FIGURES, LETTERS, LTRS_CODE, RTTY_BAUDS, RTTY_SHIFTS } from '@/worker/decoders/digimode/rtty/decoder';

export const RTTY_TEST_TEXT = 'RYRYRY CQ CQ DE ONAIR TEST 0123456789 1/2 -.:? THE QUICK BROWN FOX\n';

/** Seeded Gaussian numbers (xorshift, Box-Muller). */
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

/** The keying of one loop: [mark, length in bits] segments. */
export function rttySegments(text = RTTY_TEST_TEXT) {
	const segs = [[true, 20]];
	const put = (code) => {
		segs.push([false, 1]);
		for (let b = 0; b < 5; b++) segs.push([((code >> b) & 1) !== 0, 1]);
		segs.push([true, 1.5]);
	};
	put(LTRS_CODE);
	let figs = false;
	for (const ch of text || RTTY_TEST_TEXT) {
		if (ch === '\n') {
			put(8);
			put(2);
			continue;
		}
		let code = LETTERS.findIndex((c) => c === ch && c !== '');
		let needFigs = false;
		if (code < 0) {
			code = FIGURES.findIndex((c) => c === ch && c !== '');
			needFigs = true;
		}
		if (code < 0) continue;
		if (code !== 4 && needFigs !== figs) {
			put(needFigs ? FIGS_CODE : LTRS_CODE);
			figs = needFigs;
		}
		put(code);
	}
	segs.push([true, 20]);
	return segs;
}

/**
 * The looping transmission (OnAir's RttyTestAudio): tone amplitude 0.5. Real audio at `rate` (the default), or with
 * `complex` the samples of a complex tone at `offsetHz` + the audio frequency (interleaved I/Q).
 */
export function rttySignal(
	seconds,
	{ baudIdx = 0, shiftIdx = 0, reverse = false, lowHz = 2125, text, rate = 8000, complex = false, offsetHz = 0 } = {},
) {
	const segs = rttySegments(text);
	const step = RTTY_BAUDS[baudIdx] / rate;
	const lo = lowHz > 0 ? lowHz : 2125;
	const hi = lo + RTTY_SHIFTS[shiftIdx];
	const markW = (2 * Math.PI * ((reverse ? hi : lo) + offsetHz)) / rate;
	const spaceW = (2 * Math.PI * ((reverse ? lo : hi) + offsetHz)) / rate;
	const n = Math.round(seconds * rate);
	const out = new Float32Array(complex ? 2 * n : n);
	let [idx, rem, phase] = [0, segs[0][1], 0];
	for (let i = 0; i < n; i++) {
		rem -= step;
		while (rem <= 0) {
			idx = (idx + 1) % segs.length;
			rem += segs[idx][1];
		}
		phase += segs[idx][0] ? markW : spaceW;
		phase %= 2 * Math.PI;
		if (!complex) out[i] = 0.5 * Math.sin(phase);
		else {
			out[2 * i] = 0.5 * Math.cos(phase);
			out[2 * i + 1] = 0.5 * Math.sin(phase);
		}
	}
	return out;
}

/** Noise sigma for an SNR in 3 kHz against a tone of amplitude 0.5 (white over 0 .. 4 kHz). */
export const rttySigma = (snrDb) => Math.sqrt(0.125 / 10 ** (snrDb / 10) / 0.75);

/** Adds Gaussian noise of sigma (per component) in place. */
export function addNoise(x, sigma, seed = 1) {
	const g = gauss(seed);
	for (let i = 0; i < x.length; i++) x[i] += sigma * g();
	return x;
}

/**
 * The 8 kHz channel of the RTTY decoder (centred 2 kHz above the dial): the transmission with the lower tone at
 * `lowHz` above the dial, and complex noise of the SNR in 3 kHz.
 */
export function rttyChannel(seconds, options = {}, snrDb = 20, seed = 1) {
	const iq = rttySignal(seconds, { ...options, complex: true, offsetHz: -2000 });
	return snrDb === null ? iq : addNoise(iq, rttySigma(snrDb), seed);
}

/** The text holds the whole message and goes on as the message repeated, without a wrong character. */
export function textOk(text, minCopies, msg = RTTY_TEST_TEXT) {
	const first = text.indexOf(msg);
	if (first < 0) return false;
	const tail = text.slice(first);
	const expect = msg.repeat(Math.ceil(tail.length / msg.length) + 1);
	return expect.startsWith(tail) && Math.floor(tail.length / msg.length) >= minCopies;
}

/** Feeds a channel to a decoder in blocks of `block` complex samples. */
export function feed(decoder, iq, block = 4000) {
	for (let i = 0; i < iq.length; i += 2 * block) decoder.process(iq.subarray(i, Math.min(iq.length, i + 2 * block)));
}

/** A sink that keeps what the decoder reports. */
export function recordingSink() {
	const sink = { records: [], statuses: [] };
	sink.record = (r) => sink.records.push(r);
	sink.status = (message, locked) => sink.statuses.push({ message, locked });
	return sink;
}

export const field = (record, name) => record.fields?.find(([k]) => k === name)?.[1];
