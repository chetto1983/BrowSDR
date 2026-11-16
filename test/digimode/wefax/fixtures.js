// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir core/src/marine/marine_fax.cpp (FaxAudioSource: start tone,
// phasing, one white line, picture, stop tone, black) and core/src/marine/marine_gen.cpp (FaxSource: the audio as an
// upper sideband signal), https://github.com/adswill/OnAir; see third_party/onair. Changes: the sideband signal is made
// directly as a complex tone (no Hilbert filter); the picture is a function of row and column instead of the synthetic
// chart; a clock error, a tuning error and Gaussian noise are applied here.

import { noise } from '../fixtures';

/** IOC x pi cut to a whole number (576 -> 1809, 288 -> 904). */
export const faxWidth = (ioc) => Math.trunc(ioc * Math.PI);

/** Nine vertical bands: black, white, black, white, mid grey, dark, light, black, white (OnAir's independent transmitter). */
export const BAND_LEVELS = [0, 255, 0, 255, 128, 64, 192, 0, 255];
export const bands = (width) => (row, col) => BAND_LEVELS[Math.min(8, Math.floor(col / Math.floor(width / 9)))];

/**
 * The tone plan of one fax transmission at 120 lpm (or `lpm`): `startS` of the start tone (300 Hz for IOC 576, 675 Hz
 * for 288), `phasing` lines (white for the first and last 2.5 % of the line, black between), one white line, `rows`
 * picture lines of `pixel(row, col)` (0 black .. 255 white), `stopS` of the 450 Hz stop tone, `blackS` of black.
 * Sections with zero length are left out (a picture joined midway: `startS: 0, phasing: 0, white: false`).
 */
export function faxPlan({ ioc = 576, lpm = 120, startS = 3, phasing = 10, white = true, rows = 20, pixel, stopS = 3, blackS = 1 } = {}) {
	const W = faxWidth(ioc);
	const line = 60 / lpm;
	const picture = pixel ?? bands(W);
	const sections = [
		{ seconds: startS, freq: () => (ioc === 288 ? 675 : 300) },
		{
			seconds: phasing * line,
			freq: (t) => {
				const fr = t / line - Math.floor(t / line);
				return fr < 0.025 || fr >= 0.975 ? 2300 : 1500;
			},
		},
		{ seconds: white ? line : 0, freq: () => 2300 },
		{
			seconds: rows * line,
			freq: (t) => {
				const row = Math.min(rows - 1, Math.floor(t / line));
				const fr = t / line - Math.floor(t / line);
				return 1500 + (800 * picture(row, Math.min(W - 1, Math.floor(fr * W)))) / 255;
			},
		},
		{ seconds: stopS, freq: () => 450 },
		{ seconds: blackS, freq: () => 1500 },
	];
	return sections.filter((section) => section.seconds > 0);
}

function gaussian(random) {
	return () => {
		const u = random() + 0.5;
		const v = random() + 0.5;
		return Math.sqrt(-2 * Math.log(Math.max(u, 1e-12))) * Math.cos(2 * Math.PI * v);
	};
}

/**
 * The plan as a radio in USB hears it: each audio tone f becomes a complex tone at `offsetHz` + f + `mistuneHz` (the
 * dial at `offsetHz`), amplitude 1, sampled at `rate`; the sender's clock runs `ppm` fast (a slanted picture); complex
 * Gaussian noise for `snrDb` in 3 kHz; `leadS` of noise alone first.
 */
export function faxSignal(plan, { rate = 24000, offsetHz = 0, mistuneHz = 0, ppm = 0, snrDb = Infinity, seed = 1, leadS = 0.5 } = {}) {
	const total = plan.reduce((sum, section) => sum + section.seconds, 0) / (1 + ppm * 1e-6);
	const lead = Math.round(leadS * rate);
	const count = lead + Math.ceil(total * rate);
	const iq = new Float32Array(count * 2);
	const sigma = Number.isFinite(snrDb) ? Math.sqrt(rate / 3000 / 10 ** (snrDb / 10) / 2) : 0;
	const g = gaussian(noise(seed));
	let phase = 0;
	let section = 0;
	let start = 0;
	for (let n = 0; n < count; n++) {
		const on = n >= lead;
		if (on) {
			let t = ((n - lead) / rate) * (1 + ppm * 1e-6) - start;
			while (section < plan.length - 1 && t >= plan[section].seconds) {
				start += plan[section].seconds;
				t -= plan[section].seconds;
				section++;
			}
			phase += (2 * Math.PI * (offsetHz + mistuneHz + plan[section].freq(t))) / rate;
			phase -= 2 * Math.PI * Math.round(phase / (2 * Math.PI));
		}
		iq[2 * n] = (on ? Math.cos(phase) : 0) + sigma * g();
		iq[2 * n + 1] = (on ? Math.sin(phase) : 0) + sigma * g();
	}
	return iq;
}

/** A sink that keeps records, statuses and the picture rows as the app would assemble them. */
export function faxSink() {
	const out = { records: [], statuses: [], images: [], picture: null };
	out.record = (record) => out.records.push(record);
	out.status = (message, locked) => out.statuses.push({ message, locked });
	out.image = (rows) => {
		out.images.push({ ...rows, rgb: undefined });
		if (!out.picture || out.picture.number !== rows.picture) out.picture = { number: rows.picture, width: rows.width, rows: [] };
		for (let r = rows.from; r < rows.to; r++) {
			const grey = new Uint8Array(rows.width);
			for (let x = 0; x < rows.width; x++) grey[x] = rows.rgb[((r - rows.from) * rows.width + x) * 3];
			out.picture.rows[r] = grey;
		}
	};
	return out;
}

/** Mean of `row` over each band, leaving `margin` pixels at either edge of the band. */
export function bandMeans(row, width, margin = 12) {
	const bandW = Math.floor(width / 9);
	return BAND_LEVELS.map((_, b) => {
		let sum = 0;
		for (let x = b * bandW + margin; x < (b + 1) * bandW - margin; x++) sum += row[x];
		return sum / (bandW - 2 * margin);
	});
}
