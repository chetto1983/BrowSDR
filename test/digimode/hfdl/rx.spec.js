// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir tests/hfdl/test_hfdl_rx.cpp (squitters and ACARS / performance
// data bursts at every rate through the receiver with tuning errors, timing offsets, a sample clock off by 100 ppm,
// noise, two-path HF channels with delay and Doppler spread, noise alone, the traffic generator),
// tests/hfdl/test_hfdl_weak.cpp (weak bursts and the fallback modes) and tests/hfdl/test_hfdl_why.cpp (one reason per
// failed burst), https://github.com/adswill/OnAir; see third_party/onair. Changes: Vitest; one channel at the decoder's
// rate (7200 Hz around the carrier) instead of three channels in a 48 kHz capture; the bursts of a condition are played
// one after the other in one signal; OnAir's PortableRng is not ported, so the noise and fading are BrowSDR's and the
// pass counts of the fading and weak cases are set from runs here; added: the records' text and fields, the same
// records from any block size, and the cost per second of signal.

import { describe, expect, it } from 'vitest';
import { HfdlDecoder } from '@/worker/decoders/digimode/hfdl';
import { burstSeconds, hfdlRate } from '@/worker/decoders/digimode/hfdl/phy';
import { acarsHfnpdu, field, mpduDown, mpduUp, logonConfirm, logonRequest, perfData, play, spdu, traffic, unnumbered } from './fixtures';

/** Runs the decoder over bursts in noise; returns its records, counters and status lines. */
function decode(tx, { secs, chunk = 4096, sliceMs = Infinity, station, ...opts } = {}) {
	const records = [];
	const statuses = [];
	const dec = new HfdlDecoder({ record: (r) => records.push(r), status: (s, locked) => statuses.push([s, locked]) }, sliceMs);
	if (station) dec.setStation(station.lat, station.lon);
	const end = secs ?? Math.max(1, ...tx.map((b) => b.t + burstSeconds(b.m1))) + 1;
	play(tx, { ...opts, secs: end, chunk, each: (b) => dec.process(b) });
	dec.flush();
	return { records, counters: dec.counters, statuses, dec };
}

const SQUITTER = spdu({ gsId: 1, frameIndex: 777, mask: 0x21, other: [{ id: 7, utc: true, mask: 3 }] });
/** OnAir's test PDU: performance data and an ACARS downlink (at 300 bit/s, the ACARS block alone). */
function dataPdu(m1) {
	const acars = unnumbered(acarsHfnpdu('N123UA', 'H1', '2', m1 % 4 === 0 ? 'M01AUA0901OK' : 'M01AUA0901#DFB TEST HFDL LOOPBACK FL350'));
	return mpduDown(1, 23, m1 % 4 === 0 ? [acars] : [unnumbered(perfData('UA0901', 51.5, -30.25, 40000, 1, 2)), acars]);
}
const isSquitter = (r) => r.text.startsWith('Squitter San Francisco, frame 777');
const isAcars = (r) => r.text.includes('ACARS H1') && !r.damaged;
const carrier = (r) => Number(field(r, 'Signal').match(/carrier ([+-]?\d+) Hz/)[1]);

/** A squitter (600 bit/s) and the data burst of each rate in `rates`, one per 5 s. */
function rateSchedule(rates, cfo, tOff = 0) {
	return rates.flatMap((m1, i) => [
		{ m1: 1, pdu: SQUITTER, t: 10 * i + 0.3 + tOff, cfo },
		{ m1, pdu: dataPdu(m1), t: 10 * i + 3 + tOff, cfo },
	]);
}

/** Every burst of the schedule decoded: a squitter and an ACARS block per rate, the position, the carrier. */
function expectRates(rates, out, cfo) {
	const sq = out.records.filter(isSquitter);
	const acars = out.records.filter(isAcars);
	expect(sq).toHaveLength(rates.length);
	expect(acars).toHaveLength(rates.length);
	const pos = out.records.filter((r) => field(r, 'Position'));
	expect(pos).toHaveLength(rates.filter((m1) => m1 % 4 !== 0).length);
	for (const r of pos) expect(field(r, 'Position')).toMatch(/^51\.5\d+, -30\.25\d+ \(Performance data\)$/);
	for (const r of [...sq, ...acars]) expect(Math.abs(carrier(r) - cfo)).toBeLessThanOrEqual(3);
	expect(out.counters.bad).toBe(0);
}

const ALL = [0, 1, 2, 3, 4, 5, 6, 7];

describe('HFDL receiver: clean and offset bursts at every rate', { timeout: 60_000 }, () => {
	it('decodes every rate clean', () => {
		const out = decode(rateSchedule(ALL, 0), { snrDb: 40 });
		expectRates(ALL, out, 0);
		expect(out.counters.byRate).toEqual([2, 10, 2, 2]);
	});

	for (const [name, cfo, tOff, ppm] of [
		['+100 Hz, timing 0.37 samples', 100, 0.37 / 7200, 0],
		['-100 Hz, timing 13.6 samples', -100, 13.6 / 7200, 0],
		['+200 Hz', 200, 0, 0],
		['-200 Hz', -200, 0, 0],
		['clock +100 ppm, +150 Hz', 150, 0, 100],
		['clock -100 ppm, -150 Hz', -150, 0, -100],
	])
		it(`decodes every rate at 25 dB, ${name}`, () => {
			expectRates(ALL, decode(rateSchedule(ALL, cfo, tOff), { snrDb: 25, ppm }), cfo);
		});

	for (const [name, m1, snrDb, cfo] of [
		['noise 7 dB (BPSK 600)', 1, 7, 20],
		['noise 4 dB (BPSK 300)', 0, 4, -20],
		['noise 11 dB (QPSK 1200)', 2, 11, 40],
		['noise 16 dB (8PSK 1800)', 3, 16, -40],
		['noise 10 dB, +180 Hz (BPSK 600)', 1, 10, 180],
		['noise 10 dB, -180 Hz (BPSK 300 x2)', 4, 10, -180],
		['noise 13 dB, +120 Hz (QPSK 1200)', 2, 13, 120],
		['noise 15 dB, -120 Hz (8PSK 1800 x2)', 7, 15, -120],
	])
		it(`decodes ${name}`, () => {
			expectRates([m1], decode(rateSchedule([m1], cfo), { snrDb }), cfo);
		});

	for (const [name, m1, cfo, paths] of [
		[
			'2 paths static 1 ms -3 dB (8PSK 1800)',
			3,
			70,
			[
				{ delaySec: 0, gainDb: 0, spreadHz: 0 },
				{ delaySec: 0.001, gainDb: -3, spreadHz: 0 },
			],
		],
		[
			'2 paths static 2.5 ms -1 dB (QPSK 1200)',
			2,
			-70,
			[
				{ delaySec: 0, gainDb: 0, spreadHz: 0 },
				{ delaySec: 0.0025, gainDb: -1, spreadHz: 0 },
			],
		],
	])
		it(`decodes ${name} at 20 dB`, () => {
			const tx = rateSchedule([m1], cfo).map((b) => ({ ...b, paths }));
			expectRates([m1], decode(tx, { snrDb: 20 }), cfo);
		});
});

describe('HFDL receiver: fading', { timeout: 60_000 }, () => {
	const good = [
		{ delaySec: 0, gainDb: 0, spreadHz: 0.1 },
		{ delaySec: 0.0005, gainDb: 0, spreadHz: 0.1 },
	];
	const moderate = [
		{ delaySec: 0, gainDb: 0, spreadHz: 0.5 },
		{ delaySec: 0.001, gainDb: 0, spreadHz: 0.5 },
	];
	/** One ACARS burst per trial, each with its own fading, 6 s apart. */
	function fading(m1, cfo, paths, trials, seed) {
		const tx = Array.from({ length: trials }, (_, i) => ({ m1, pdu: dataPdu(m1), t: 0.3 + 6 * i, cfo, paths, seed: seed + 17 * i }));
		return decode(tx, { snrDb: 25, seed }).records.filter(isAcars).length;
	}

	it('decodes most bursts through a CCIR good channel (0.5 ms, 0.1 Hz) at 25 dB', () => {
		const ok = ALL.map((m1) => fading(m1, 60, good, 4, 100 + m1));
		for (const n of ok) expect(n).toBeGreaterThanOrEqual(3);
	});

	it('decodes many bursts through a CCIR moderate channel (1 ms, 0.5 Hz) at 25 dB', () => {
		// OnAir over 40 bursts: 300 bit/s 98-100 %, 600 and 1200 bit/s 72-92 %, 1800 bit/s 58-60 %; here over 40 bursts
		// 600 bit/s 92 %, 1200 bit/s 80 %, 1800 bit/s 55 %, and these 8 give 8, 8, 4 and 6
		const ok = [0, 1, 2, 3].map((m1) => fading(m1, -60, moderate, 8, 200 + m1));
		expect(ok[0]).toBeGreaterThanOrEqual(7);
		expect(ok[1]).toBeGreaterThanOrEqual(5);
		expect(ok[2]).toBeGreaterThanOrEqual(4);
		expect(ok[3]).toBeGreaterThanOrEqual(3);
	});

	it('gets about half through a poor channel (2 ms, 1 Hz, Doppler shifts) at 25 dB', () => {
		const poor = [
			{ delaySec: 0, gainDb: 0, spreadHz: 1, shiftHz: 0.2 },
			{ delaySec: 0.002, gainDb: -1, spreadHz: 1, shiftHz: -0.3 },
		];
		const ok = [0, 1, 2, 5].map((m1) => fading(m1, 100, poor, 8, 300 + m1));
		// OnAir: 4.2 s at 1 Hz spread, about half get through (needs 4 of 8, 3 for the two-slot burst); here 8, 6, 7 and 5
		for (const [i, n] of ok.entries()) expect(n).toBeGreaterThanOrEqual(i === 3 ? 3 : 4);
	});
});

describe('HFDL receiver: weak bursts, noise and reasons', { timeout: 60_000 }, () => {
	/** Weak bursts: the equaliser alone fails most of these; the gain / phase tracker and the known-symbol decoder take them. */
	function weak(m1, snrDb, ppm = 0) {
		const pdu = mpduDown(1, 23, [unnumbered(acarsHfnpdu('N1UA', 'H1', '2', 'M01AUA0901WEAK SIGNAL TEST'))]);
		const tx = Array.from({ length: 12 }, (_, i) => ({ m1, pdu, t: 0.3 + 5 * i, cfo: 40 * ((i % 3) - 1), seed: 10 + i }));
		const out = decode(tx, { snrDb, ppm, seed: 10 + m1 });
		return out.records.filter((r) => r.text.includes('ACARS H1') && !r.damaged);
	}

	it('decodes weak 600 and 300 bit/s bursts with the fallback modes', () => {
		const a = weak(1, 0);
		const b = weak(0, -3);
		expect(a.length).toBeGreaterThanOrEqual(5);
		expect(b.length).toBeGreaterThanOrEqual(8);
		expect([...a, ...b].some((r) => /decoded (without the equaliser|on the known symbols only)/.test(field(r, 'Burst')))).toBe(true);
		expect(weak(1, 4).length).toBe(12);
		expect(weak(0, 2).length).toBe(12);
	});

	it('follows a sample clock 100 ppm fast on weak bursts', () => {
		expect(weak(1, -1, 100).length).toBeGreaterThanOrEqual(1);
	});

	it('gives nothing from noise alone', () => {
		const out = decode([], { snrDb: 10, secs: 40 });
		expect(out.records).toEqual([]);
		expect(out.counters.good + out.counters.bad).toBe(0);
		expect(out.statuses.at(-1)).toEqual(['Searching for bursts', false]);
	});

	it('counts every failed burst under one reason, a clean one under none', () => {
		const clean = decode(rateSchedule([1], 0).slice(1), { snrDb: 20 });
		expect([clean.counters.good, clean.counters.bad, clean.counters.mpduFcs + clean.counters.spduFcs + clean.counters.short]).toEqual([
			1, 0, 0,
		]);
		const pdu = dataPdu(3);
		const tx = Array.from({ length: 10 }, (_, i) => ({ m1: 3, pdu, t: 0.3 + 4 * i, seed: 20 + i }));
		const c = decode(tx, { snrDb: 2, seed: 20 }).counters;
		expect(c.bad).toBeGreaterThan(0);
		expect(c.spduFcs + c.mpduFcs + c.short).toBe(c.bad);
	});
});

describe('HFDL records', { timeout: 60_000 }, () => {
	it('names aircraft from their logon, shows positions and distances, dims a bad ACARS block', () => {
		const icao = 0xa1b2c3;
		const acars = unnumbered(acarsHfnpdu('N123UA', 'H1', '2', 'M01AUA0901HELLO'));
		acars[acars.length - 7] ^= 1; // the ACARS check fails, the LPDU's is made again below
		const lp = acars.slice(0, -2);
		const tx = [
			{ m1: 0, pdu: mpduDown(7, 0, [logonRequest(icao)]), t: 0.3 },
			{ m1: 1, pdu: mpduUp(7, 0, [logonConfirm(icao, 45)]), t: 3 },
			{ m1: 2, pdu: mpduDown(7, 45, [unnumbered(perfData('UA0901', 53.5, -15.25, 40000, 7, 2))]), t: 6 },
			{ m1: 1, pdu: mpduDown(7, 45, [unnumbered(lp.slice(1))]), t: 9 },
		];
		const out = decode(tx, { snrDb: 30, station: { lat: 52.7, lon: -8.9 } });
		const texts = out.records.map((r) => r.text);
		expect(texts).toEqual([
			'A1B2C3 → GS 7 Shannon · Logon request from A1B2C3',
			'GS 7 Shannon → A1B2C3 · Logon confirm A1B2C3, aircraft id 45',
			'A1B2C3 → GS 7 Shannon · Performance data UA0901  53.500 -15.250',
			expect.stringMatching(/^A1B2C3 \(N123UA\) → GS 7 Shannon · ACARS H1/),
		]);
		const perf = out.records[2];
		expect(field(perf, 'ICAO address')).toBe('A1B2C3');
		expect(field(perf, 'Flight')).toBe('UA0901');
		expect(field(perf, 'Position')).toBe('53.49998, -15.25005 (Performance data)');
		expect(field(perf, 'Distance')).toMatch(/^4\d\d km, bearing 2\d\d°$/);
		expect(field(perf, 'Ground station')).toBe('7 Shannon, 0 km away');
		expect(out.records[3].damaged).toBe(true);
		expect(out.statuses.at(-1)[0]).toMatch(/^4 PDUs, 0 bad · 1 ground station, 1 aircraft · last 600 bit\/s/);
	});

	it('gives the same records from any block size and slice of time', () => {
		const tx = traffic({ frames: 2, perFrame: 3, aircraft: 3, seed: 4 });
		const texts = (opts) => decode(tx, { snrDb: 20, secs: 66, ...opts }).records.map((r) => [r.text, r.fields]);
		const whole = texts({ chunk: 0 });
		expect(whole.length).toBeGreaterThanOrEqual(8);
		expect(texts({ chunk: 37 })).toEqual(whole);
		expect(texts({ chunk: 1000, sliceMs: 0 })).toEqual(whole);
		expect(texts({ chunk: 20000, sliceMs: 1 })).toEqual(whole);
	});

	it('decodes a busy channel: logons, positions and ACARS both ways at every rate', () => {
		const tx = traffic({ frames: 4, perFrame: 4, aircraft: 4, seed: 2 });
		const out = decode(tx, { snrDb: 25, secs: 130, carHz: 50 });
		expect(out.counters.good).toBe(tx.length);
		expect(out.counters.bad).toBe(0);
		expect(out.counters.byRate.every((n) => n > 0)).toBe(true);
		expect(out.records.filter((r) => r.text.includes('Logon confirm')).length).toBeGreaterThanOrEqual(3);
		expect(out.records.filter((r) => field(r, 'Position')).length).toBeGreaterThanOrEqual(3);
		expect(out.records.filter((r) => r.text.includes('ACARS')).length).toBeGreaterThanOrEqual(3);
		expect(hfdlRate(7).bps).toBe(1800);
	});

	it('costs little per second of signal and keeps each block short', () => {
		const tx = traffic({ frames: 3, perFrame: 3, aircraft: 3, seed: 7 });
		const blocks = [];
		// 20 ms blocks, as the worker hands a 7200 Hz channel on (4 ms of decoding allowed per block)
		play(tx, { snrDb: 20, secs: 96, chunk: 144, each: (b) => blocks.push(b) });
		const idle = [];
		play([], { snrDb: 20, secs: 30, chunk: 144, each: (b) => idle.push(b) });
		// warmed up first: the first bursts include the compilation of the code
		const warm = new HfdlDecoder({ record: () => {}, status: () => {} });
		for (const b of blocks.slice(0, 1000)) warm.process(b);
		const dec = new HfdlDecoder({ record: () => {}, status: () => {} });
		let t0 = performance.now();
		for (const b of idle) dec.process(b);
		const idleMs = (performance.now() - t0) / 30;
		let longest = 0;
		t0 = performance.now();
		for (const b of blocks) {
			const t = performance.now();
			dec.process(b);
			longest = Math.max(longest, performance.now() - t);
		}
		const busyMs = (performance.now() - t0) / 96;
		console.log(
			`HFDL: ${idleMs.toFixed(1)} ms of CPU per second of an idle channel, ${busyMs.toFixed(1)} ms of a busy one (${dec.counters.good} bursts); longest 20 ms block ${longest.toFixed(1)} ms`,
		);
		expect(dec.counters.good).toBe(tx.length);
		expect(idleMs).toBeLessThan(150);
		expect(busyMs).toBeLessThan(150);
		expect(longest).toBeLessThan(100);
	});
});
