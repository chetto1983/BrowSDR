// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir core/src/mesh/mesh_lora_code.cpp (TxFrame: the LoRa frame waveform:
// preamble, sync word, 2.25 down-chirps, data symbols, transmitter clock error, carrier offset and phase) and
// core/include/dect2/dsp/gen_util.h (complex white noise), https://github.com/adswill/OnAir; see third_party/onair. LoRa
// facts as credited there: gr-lora_sdr (Joachim Tapparel, EPFL, and contributors, GPL-3.0) modulate_impl.cc. Changes:
// Math.cos / sin in place of the 65536-entry table; Box-Muller noise from a seeded generator in place of the noise table;
// the carrier's drift (OnAir's freqRateHzS, a satellite's Doppler rate) and, added in BrowSDR, inverted IQ (the conjugate).

import { airSeconds, encode, sfdExtraSymbols, symbolSeconds, syncSymbol } from '@/worker/decoders/digimode/lora/code';
import { noise } from '../fixtures';

/** A frame to render: settings, payload, start time, carrier offset (Hz), SNR in the LoRa bandwidth, clock error. */
export function txFrame(
	p,
	payload,
	{ startSec = 0.05, freqHz = 0, snrDb = 20, sroPpm = 0, phase0 = 0.3, freqRateHzS = 0, inverted = false } = {},
) {
	const data = encode(p, payload, payload.length);
	const end = startSec + (p.preamble + 4.25 + sfdExtraSymbols(p.sf) + data.length) * symbolSeconds(p.sf, p.bwHz) * (1 + sroPpm * 1e-6);
	return { p, data, startSec, freqHz, snrDb, sroPpm, phase0, freqRateHzS, inverted, endSec: end, airSec: airSeconds(p, payload.length) };
}

/** Adds the frame's waveform (amplitude amp) to the interleaved samples out[k] for sample times t0 + k / rate. */
export function renderFrame(f, out, t0, rate, amp) {
	const { p, data } = f;
	const N = 1 << p.sf;
	const chipRate = p.bwHz / (1 + f.sroPpm * 1e-6);
	const P = p.preamble;
	const sfdEnd = (P + 4.25) * N;
	const dataStart = sfdEnd + sfdExtraSymbols(p.sf) * N;
	const total = dataStart + data.length * N;
	const sw1 = syncSymbol(p.syncWord, 0, p.sf),
		sw2 = syncSymbol(p.syncWord, 1, p.sf);
	const up = (v, x) => {
		let ph = ((v - N / 2) * x + 0.5 * x * x) / N;
		if (x > N - v) ph -= x - (N - v);
		return ph;
	};
	const down = (x) => ((N / 2) * x - 0.5 * x * x) / N;
	const n = out.length >> 1;
	const k0 = Math.max(0, Math.ceil((f.startSec - t0) * rate - 1e-9));
	for (let k = k0; k < n; k++) {
		const t = t0 + k / rate - f.startSec;
		const u = t * chipRate;
		if (u >= total) break;
		if (u < 0) continue;
		let c;
		if (u >= sfdEnd && u < dataStart) {
			const ue = u - sfdEnd;
			c = up(0, ue - Math.floor(ue / N) * N);
		} else if (u < dataStart) {
			const s = Math.floor(u / N);
			const x = u - s * N;
			if (s < P) c = up(0, x);
			else if (s === P) c = up(sw1, x);
			else if (s === P + 1) c = up(sw2, x);
			else c = down(x);
		} else {
			const ud = u - dataStart;
			const s = Math.floor(ud / N);
			c = up(data[s], ud - s * N);
		}
		// inverted IQ: the chirps run the other way round (the conjugate); the carrier and its drift stay
		let cyc = (f.inverted ? -c : c) + f.freqHz * t + f.phase0 + 0.5 * (f.freqRateHzS ?? 0) * t * t;
		cyc -= Math.floor(cyc);
		out[2 * k] += amp * Math.cos(2 * Math.PI * cyc);
		out[2 * k + 1] += amp * Math.sin(2 * Math.PI * cyc);
	}
}

/** Seeded standard normal values (Box-Muller). */
export function gaussian(seed) {
	const random = noise(seed);
	return () => {
		const u = random() + 0.5 || 1e-12;
		return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * (random() + 0.5));
	};
}

/**
 * The frames over complex white noise at `rate`: the noise power in the bandwidth `bwHz` is 1 / (10^(snr/10)) of a frame's
 * power at its snrDb; `noiseRms` sets the noise (the frames' amplitude follows from their SNR). `tailSec` of noise after.
 */
export function loraSignal(frames, { rate, bwHz, noiseRms = 0.05, tailSec = 0.1, seed = 1, durationSec } = {}) {
	const end = durationSec ?? Math.max(0, ...frames.map((f) => f.endSec)) + tailSec;
	const n = Math.ceil(end * rate);
	const out = new Float32Array(2 * n);
	for (const f of frames) {
		const amp = Math.sqrt((10 ** (f.snrDb / 10) * noiseRms * noiseRms * (bwHz ?? f.p.bwHz)) / rate);
		renderFrame(f, out, 0, rate, amp);
	}
	if (noiseRms > 0) {
		const g = gaussian(seed);
		const sigma = noiseRms / Math.SQRT2;
		for (let i = 0; i < out.length; i++) out[i] += sigma * g();
	}
	return out;
}

/**
 * Renders the frames over noise chunk by chunk (as loraSignal, without holding the whole signal) into `consume(iq)`; the
 * noise follows the SNR convention of loraSignal. Returns the seconds of signal.
 */
export function streamSignal(frames, consume, { rate, bwHz, noiseRms = 0.05, tailSec = 0.1, seed = 1, durationSec, chunk = 16384 } = {}) {
	const end = durationSec ?? Math.max(0, ...frames.map((f) => f.endSec)) + tailSec;
	const n = Math.ceil(end * rate);
	const g = gaussian(seed);
	const sigma = noiseRms / Math.SQRT2;
	const amps = frames.map((f) => Math.sqrt((10 ** (f.snrDb / 10) * noiseRms * noiseRms * (bwHz ?? f.p.bwHz)) / rate));
	for (let k0 = 0; k0 < n; k0 += chunk) {
		const m = Math.min(chunk, n - k0);
		const out = new Float32Array(2 * m);
		const t0 = k0 / rate,
			t1 = (k0 + m) / rate;
		frames.forEach((f, i) => {
			if (f.endSec >= t0 && f.startSec <= t1) renderFrame(f, out, t0, rate, amps[i]);
		});
		if (noiseRms > 0) for (let i = 0; i < out.length; i++) out[i] += sigma * g();
		consume(out);
	}
	return end;
}

/** Streams the frames into a new decoder; its records, status lines and the decode time. */
export function decodeFrames(Decoder, frames, opts) {
	const records = [];
	const status = [];
	const decoder = new Decoder({ record: (r) => records.push(r), status: (message, locked) => status.push([message, locked]) });
	let ms = 0;
	const seconds = streamSignal(
		frames,
		(iq) => {
			const t0 = performance.now();
			decoder.process(iq);
			ms += performance.now() - t0;
		},
		opts,
	);
	return { records, status, ms, seconds };
}

/** Feeds the decoder in chunks and collects its records and status lines. */
export function runDecoder(Decoder, iq, chunk = 16384) {
	const records = [];
	const status = [];
	const decoder = new Decoder({ record: (r) => records.push(r), status: (message, locked) => status.push([message, locked]) });
	for (let i = 0; i < iq.length; i += 2 * chunk) decoder.process(iq.subarray(i, Math.min(iq.length, i + 2 * chunk)));
	return { records, status, decoder };
}
