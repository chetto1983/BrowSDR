// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir tests/inmc/test_inmc_rx.cpp (the loop of five messages back bit
// exact, normal and inverted polarity), tests/inmc/test_inmc_impair.cpp (carrier offsets, drift, chunk sizes, a polarity
// flip) and tests/inmc/test_inmc_basic.cpp (noise only), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the decoder at its own 96 kS/s channel (OnAir feeds 0.25 to 20 MS/s captures through its own front end), ten
// EGC packets per frame so that the loop fits in fewer frames, the noise filtered to the 44 kHz channel as BrowSDR's
// channel filter leaves it (OnAir: the noise of the whole capture through its CIC decimator), records and status lines
// in place of the telemetry report, and the receiver's processor time measured against the signal time.

import { describe, expect, it } from 'vitest';
import { INMC_RATE, InmarsatCDecoder } from '@/worker/decoders/digimode/inmarsat-c';
import { InmcSignal, expectedTexts, gaussian } from './fixtures';

const field = (record, label) => record.fields.find(([name]) => name === label)?.[1];
const fullText = (record) =>
	record.fields
		.filter(([name]) => name.startsWith('Text'))
		.map(([, value]) => value)
		.join('');

/** Runs `secs` of the test signal through the decoder in chunks of `chunk` samples (or random sizes when `chunk` is 0). */
function run({ secs, chunk = 9600, flip = () => false, ...signal }) {
	const records = [];
	const statuses = [];
	const decoder = new InmarsatCDecoder({ record: (r) => records.push(r), status: (message, locked) => statuses.push({ message, locked }) });
	const gen = new InmcSignal({ rate: INMC_RATE, perFrame: 10, noiseBandHz: 44000, ...signal });
	const sizes = gaussian(7);
	let cpu = 0;
	for (let done = 0; done < secs * INMC_RATE;) {
		const n = chunk || Math.max(1, Math.min(20000, Math.round(Math.abs(sizes()) * 6000)));
		const iq = gen.generate(n);
		if (flip(done / INMC_RATE)) iq.forEach((v, i) => (iq[i] = -v));
		const t0 = performance.now();
		decoder.process(iq);
		cpu += performance.now() - t0;
		done += n;
	}
	return { records, statuses, decoder, source: gen.source, cpuSec: cpu / 1000 };
}

/** The loop's messages that came back complete and exact. */
function matches(records, source) {
	return expectedTexts(source).filter((m) =>
		records.some((r) => !r.damaged && field(r, 'Message number')?.startsWith(String(m.id)) && fullText(r) === m.text),
	).length;
}

describe('Inmarsat-C receiver', () => {
	it('gives back the loop of messages bit exact at Eb/N0 9 dB (C/N0 37 dB-Hz) with a carrier 8 kHz off, normal and inverted', () => {
		for (const invert of [false, true]) {
			const r = run({ secs: 62, ebn0Db: 9, cfoHz: 8000, invert, seed: 2 });
			const d = r.decoder;
			console.log(
				`Inmarsat-C ${invert ? 'inverted' : 'normal'}: ${d.framesOk} frames, ${matches(r.records, r.source)} of 5 messages, Eb/N0 ${d.ebn0Db.toFixed(1)} dB, carrier ${d.demod.cfoHz.toFixed(1)} Hz, ` +
					`${(62 / r.cpuSec).toFixed(0)}x real time (${((r.cpuSec / 62) * 100).toFixed(1)} % of a core)`,
			);
			expect(matches(r.records, r.source)).toBe(5);
			expect(d.framesBad).toBe(0);
			expect(d.framesOk).toBeGreaterThanOrEqual(4);
			expect(Math.abs(d.ebn0Db - 9)).toBeLessThan(1.5);
			expect(Math.abs(d.demod.cfoHz - 8000)).toBeLessThan(5);
			expect(d.parser.ncs).toMatchObject({ valid: true, sat: 3, lesId: 44, channelType: 1 });
			expect(r.statuses.at(-1)).toMatchObject({ locked: true });
			expect(r.statuses.at(-1).message).toMatch(/^IOR NCS · frame \d+ · Eb\/N0/);
		}
	}, 120_000);

	it('lists what a message is about, and makes distress and urgency alerts', () => {
		const r = run({ secs: 62, ebn0Db: 12, cfoHz: -3000, seed: 3 });
		const navarea = r.records.find((x) => x.text.includes('NAVAREA IX 231/26'));
		expect(navarea).toMatchObject({ alert: false, damaged: false });
		expect(navarea.text.startsWith('Safety · Navigational warning · NAVAREA IX 231/26: NAVAREA IX 231/26 PERSIAN GULF.')).toBe(true);
		expect(field(navarea, 'Area')).toBe('NAVAREA IX');
		expect(field(navarea, 'Channel')).toBe('Indian Ocean Region (IOR), NCS, NCS');
		const sar = r.records.find((x) => x.text.includes('SAR COORDINATION'));
		expect(sar).toMatchObject({ alert: true });
		expect(sar.text.startsWith('Urgency · Search and rescue')).toBe(true);
		const fleet = r.records.find((x) => field(x, 'Presentation') === 'ITA2 (telex)');
		expect(fleet.text.startsWith('Routine · FleetNET message: FLEETNET OPERATIONS BULLETIN 14.')).toBe(true);
	}, 60_000);

	it('follows a drifting carrier at the edge of the search', () => {
		const r = run({ secs: 45, ebn0Db: 10, cfoHz: -18500, driftHzS: 15, seed: 4 });
		expect(r.decoder.framesOk).toBeGreaterThanOrEqual(3);
		expect(r.decoder.framesBad).toBe(0);
		expect(Math.abs(r.decoder.demod.cfoHz - (-18500 + 15 * 45))).toBeLessThan(80);
	}, 60_000);

	it('repairs the polarity flips of carrier loop slips with the unique word', () => {
		const r = run({ secs: 62, ebn0Db: 8, cfoHz: 1200, seed: 2, flip: (t) => t >= 21 && t < 40 });
		expect(r.decoder.framer.polaritySlips).toBeGreaterThanOrEqual(2);
		expect(r.decoder.framesBad).toBe(0);
		expect(matches(r.records, r.source)).toBeGreaterThanOrEqual(3);
	}, 60_000);

	it('gives the same records in small and random chunks', () => {
		const big = run({ secs: 45, ebn0Db: 10, cfoHz: 2500, seed: 5, chunk: 48000 });
		const small = run({ secs: 45, ebn0Db: 10, cfoHz: 2500, seed: 5, chunk: 7 });
		const random = run({ secs: 45, ebn0Db: 10, cfoHz: 2500, seed: 5, chunk: 0 });
		const texts = (r) => r.records.map((x) => [x.text, x.damaged]);
		expect(big.records.length).toBeGreaterThanOrEqual(3);
		expect(texts(small)).toEqual(texts(big));
		expect(texts(random)).toEqual(texts(big));
	}, 120_000);

	it('finds nothing in noise alone', () => {
		const records = [];
		const decoder = new InmarsatCDecoder({ record: (r) => records.push(r), status: () => {} });
		const noise = gaussian(11);
		for (let s = 0; s < 40; s++) decoder.process(Float32Array.from({ length: 2 * INMC_RATE }, () => 0.1 * noise()));
		expect(records).toEqual([]);
		expect(decoder.framesOk).toBe(0);
		expect(decoder.frameLock).toBe(false);
	}, 60_000);
});
