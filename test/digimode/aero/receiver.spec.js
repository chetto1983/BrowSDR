// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir tests/aero/test_aero_rx.cpp (the band search finds the channels,
// the rate is found on its own, frames bit exact with the ones sent, messages and log-ons), tests/aero/test_aero_rates.cpp
// (all three rates, chunks of every size), tests/aero/test_aero_map.cpp (positions) and tests/aero/test_aero_basic.cpp
// (noise only), https://github.com/adswill/OnAir; see third_party/onair. Changes: the decoder at its 48 kS/s channel
// with up to two carriers in it (OnAir: a wide capture with carriers 100 kHz apart), records and status lines in place
// of the telemetry report, and the receiver's processor time measured against the signal time.

import { describe, expect, it } from 'vitest';
import { AERO_RATE, AeroDecoder } from '@/worker/decoders/digimode/aero';
import { gaussian } from '../inmarsat-c/fixtures';
import { field } from './fixtures';
import { AeroSignal } from './signal';

const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Runs `secs` of the test signal through the decoder in chunks of `chunk` samples (or random sizes when `chunk` is 0). */
function run({ secs, chunk = 4800, station, ...signal }) {
	const records = [];
	const statuses = [];
	const frames = [];
	const dec = new AeroDecoder(
		{ record: (r) => records.push(r), status: (message, locked) => statuses.push({ message, locked }) },
		(e, heard) => frames.push({ e, heard }),
	);
	if (station) dec.setStation(...station);
	const sig = new AeroSignal({ rate: AERO_RATE, ...signal });
	const sizes = gaussian(5);
	let cpu = 0;
	for (let done = 0; done < secs * AERO_RATE;) {
		const n = Math.min(secs * AERO_RATE - done, chunk || Math.max(1, Math.min(20000, Math.round(Math.abs(sizes()) * 3000))));
		const iq = sig.generate(n);
		const t0 = performance.now();
		dec.process(iq);
		cpu += performance.now() - t0;
		done += n;
	}
	return { records, statuses, frames, dec, sent: sig.sent, cpuSec: cpu / 1000 };
}

const acarsRecords = (records) => records.filter((r) => r.text.startsWith('Uplink') || r.text.startsWith('Downlink'));

describe('Aero receiver', () => {
	it('finds a 1200 and a 600 bit/s P channel several kHz off in one VFO and decodes them bit exact', () => {
		const secs = 40;
		const r = run({
			secs,
			ebn0Db: 12,
			channels: [
				{ bitRate: 1200, offsetHz: -7500, cfoHz: -2460 },
				{ bitRate: 600, offsetHz: 7500, cfoHz: 970 },
			],
		});
		console.log(
			`Aero 1200 + 600 bit/s: ${r.frames.length} frames, ${r.records.length} records, ${(secs / r.cpuSec).toFixed(0)}x real time (${((r.cpuSec / secs) * 100).toFixed(1)} % of a core)`,
		);
		const sentFrames = r.sent.flatMap((s) => s.frames);
		expect(r.frames.length).toBeGreaterThan(40);
		expect(r.frames.every(({ e }) => sentFrames.some((f) => sameBytes(f, e.bytes)))).toBe(true);
		expect(r.dec.receiver.susBad).toBe(0);
		const rates = r.frames.map(({ heard }) => [heard.bitRate, Math.round(heard.offsetHz / 100) / 10]);
		expect(rates.some(([b, f]) => b === 1200 && Math.abs(f + 9.96) < 0.05)).toBe(true);
		expect(rates.some(([b, f]) => b === 600 && Math.abs(f - 8.47) < 0.05)).toBe(true);
		for (const { e } of r.frames) expect(Math.abs(e.ebn0Db - 12)).toBeLessThan(2);
		// every message logged was sent, and every one sent early enough was logged
		const sent = r.sent.flatMap((s) => s.messages);
		const logged = acarsRecords(r.records);
		for (const rec of logged)
			expect(
				sent.some(({ msg }) => rec.text.includes(msg.registration) && (field(rec, 'Text') ?? '') === msg.text.replace(/^#M1B\//, '#M1B/')),
			).toBe(true);
		expect(logged.length).toBeGreaterThanOrEqual(sent.filter(({ t }) => t < secs - 8).length);
		expect(logged.every((rec) => !rec.damaged)).toBe(true);
		expect(r.records.filter((x) => x.text.startsWith('Log-on')).length).toBeGreaterThanOrEqual(6);
		expect(r.records.some((x) => x.text.startsWith('System table: satellite 5 at 64.5°E (Inmarsat 64.5E (IOR))'))).toBe(true);
		const last = r.statuses.at(-1);
		expect(last.locked).toBe(true);
		expect(last.message).toMatch(/^1200 bit\/s at -9\.96 kHz, Eb\/N0 \d+\.\d dB; 600 bit\/s at \+8\.47 kHz/);
	}, 60_000);

	it('reads ACARS, ADS-C positions and text positions, with the distance from the station', () => {
		const r = run({ secs: 30, ebn0Db: 14, station: [25.25, 55.36], channels: [{ bitRate: 10500, offsetHz: 3000, cfoHz: 1830 }] });
		const recs = acarsRecords(r.records);
		const wx = recs.find((x) => x.text.startsWith('Uplink to A6-EUA (896411) · ACARS H1'));
		expect(wx.text).toContain('WX OMDB 071300Z');
		expect(field(wx, 'Ground earth station')).toBe('GES 05');
		const adsc = recs.find((x) => x.text.startsWith('Downlink from A6-EUA (896411) · ADS-C report · position 25.'));
		expect(adsc.text).toMatch(/37000 ft · 480 kt · 105° · \d+ km$/);
		expect(field(adsc, 'ADS-C')).toBe('report from A6-EUA, ground BOMCAYA, CRC good');
		expect(field(adsc, 'ADS-C flight id')).toBe('EK0501');
		const pos = recs.find((x) => x.text.includes('VT-ANA (800B21) · ACARS H1'));
		expect(field(pos, 'Position')).toMatch(/^20\.\d+, 6[56]\.\d+ · 33000 ft · \d+ km \(POS report\)$/);
		const sa = recs.find((x) => x.text.includes('ACARS SA'));
		expect(field(sa, 'Reading')).toBe('link established: VHF ACARS at 14:26:52, available: VHF ACARS');
		const sat = r.records.find((x) => x.text.startsWith('System table: satellite'));
		expect(field(sat, 'Seen from the station')).toMatch(/^azimuth \d+°, elevation \d+°$/);
		expect(r.dec.positions).toBeGreaterThanOrEqual(3);
	}, 60_000);

	it('decodes 10500 and 1200 bit/s at Eb/N0 6 dB per channel bit (C/N0 46 and 37 dB-Hz)', () => {
		const secs = 24;
		const r = run({
			secs,
			ebn0Db: 6,
			seed: 5,
			channels: [
				{ bitRate: 10500, offsetHz: 6500, cfoHz: -2000 },
				{ bitRate: 1200, offsetHz: -9000, cfoHz: 1200, positions: false },
			],
		});
		const rx = r.dec.receiver;
		console.log(
			`Aero 10500 + 1200 bit/s at 6 dB: SUs ${rx.susOk} good ${rx.susBad} bad, ${(secs / r.cpuSec).toFixed(0)}x real time (${((r.cpuSec / secs) * 100).toFixed(1)} % of a core)`,
		);
		for (const rate of [10500, 1200])
			expect(r.frames.filter(({ heard }) => heard.bitRate === rate).length).toBeGreaterThan(rate === 10500 ? 30 : 12);
		expect(rx.susBad * 50).toBeLessThanOrEqual(rx.susOk);
		expect(acarsRecords(r.records).filter((x) => !x.damaged).length).toBeGreaterThanOrEqual(6);
	}, 60_000);

	it('gives the same records in small and random chunks', () => {
		const opts = { secs: 20, ebn0Db: 12, channels: [{ bitRate: 1200, offsetHz: 2000, cfoHz: -1500 }] };
		const texts = (r) => r.records.map((x) => [x.text, !!x.damaged]);
		const big = run({ ...opts, chunk: 48000 });
		expect(big.records.length).toBeGreaterThanOrEqual(5);
		expect(texts(run({ ...opts, chunk: 7 }))).toEqual(texts(big));
		expect(texts(run({ ...opts, chunk: 0 }))).toEqual(texts(big));
	}, 120_000);

	it('finds nothing in noise alone', () => {
		const records = [];
		const statuses = [];
		const dec = new AeroDecoder({ record: (r) => records.push(r), status: (message, locked) => statuses.push({ message, locked }) });
		const noise = gaussian(3);
		for (let s = 0; s < 40; s++) dec.process(Float32Array.from({ length: 2 * AERO_RATE }, () => 0.1 * noise()));
		expect(records).toEqual([]);
		expect(statuses.every((s) => !s.locked)).toBe(true);
		expect(dec.receiver.chans.length).toBe(0);
	}, 60_000);
});
