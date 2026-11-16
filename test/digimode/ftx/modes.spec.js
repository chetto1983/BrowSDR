// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir tests/hfdig/test_hfdig_ft4.cpp and test_hfdig_wspr.cpp (FT4 and
// WSPR end to end: the generator's stations, WSPR message types 1, 2 and 3 with the hashed call known from the type 1
// message of the same slot, WSPR beacons at the threshold, noise alone), https://github.com/adswill/OnAir; see
// third_party/onair. Changes: one slot each; the WSPR beacons at -25 dB; no receiver faults or slot search.
import { describe, expect, it } from 'vitest';
import { field, FT4, ftxChannel, generatorStations, receive, T0, WSPR } from './fixtures';
import { digimodeInfo } from '@/worker/decoders/digimode/catalog';
import { Ft4Decoder } from '@/worker/decoders/digimode/ftx';
import { WsprDecoder } from '@/worker/decoders/digimode/wspr';

const ft4 = (sink, options) => new Ft4Decoder(sink, options);
const wspr = (sink, options) => new WsprDecoder(sink, options);
const hzOf = (r) => Number(field(r, 'Audio frequency').split(' ')[0]);
const dtOf = (r) => Number(field(r, 'DT').split(' ')[0]);

describe('FT4 decoder', () => {
	it("decodes OnAir's five generator stations of a 7.5 s slot", () => {
		const stations = generatorStations(FT4, -2);
		const { sink, decoder } = receive(ft4, ftxChannel(FT4, stations, { slots: 1, tail: 2, seed: 9 }));
		expect(sink.records.map((r) => field(r, 'Message')).sort()).toEqual(stations.map((s) => s.msg).sort());
		for (const s of stations) {
			const r = sink.records.find((x) => field(x, 'Message') === s.msg);
			expect(Math.abs(hzOf(r) - s.hz), s.msg).toBeLessThanOrEqual(2);
			expect(Math.abs(dtOf(r) - s.dt), s.msg).toBeLessThan(0.051);
			expect(field(r, 'Mode')).toBe('FT4');
		}
		expect(decoder.last).toMatchObject({ slotUtc: T0, decodes: 5 });
		expect(digimodeInfo('ft4').presets.map((p) => p.freqMHz)).toEqual([3.575, 7.0475, 14.08, 21.14, 28.18]);
	});
});

describe('WSPR decoder', () => {
	it("decodes OnAir's generator beacons: type 1, prefix and suffix calls, and a hashed call with a 6-character grid", () => {
		const stations = generatorStations(WSPR, -12);
		const { sink, decoder } = receive(wspr, ftxChannel(WSPR, stations, { slots: 1, tail: 2, seed: 3 }));
		expect(sink.records.map((r) => r.text).sort()).toEqual(stations.map((s) => s.msg).sort());
		for (const s of stations) {
			const r = sink.records.find((x) => x.text === s.msg);
			expect(Math.abs(Number(field(r, 'Audio frequency').split(' ')[0]) - s.hz), s.msg).toBeLessThan(0.3);
			expect(Math.abs(dtOf(r) - s.dt), s.msg).toBeLessThan(0.15);
		}
		const k = sink.records.find((x) => x.text === 'K1ABC FN42 37');
		expect(k.fields).toEqual(
			expect.arrayContaining([
				['Mode', 'WSPR'],
				['UTC slot', '00:00:00'],
				['Call', 'K1ABC'],
				['Grid', 'FN42'],
				['Power', '37 dBm (5 W)'],
			]),
		);
		expect(
			field(
				sink.records.find((x) => x.text === '<K1ABC> FN42AX 37'),
				'Grid',
			),
		).toBe('FN42AX');
		expect(decoder.last).toMatchObject({ slotUtc: T0, decodes: 5 });
		expect(digimodeInfo('wspr').presets.map((p) => p.freqMHz)).toEqual([3.5686, 7.0386, 10.1387, 14.0956, 21.0946, 28.1246]);
	}, 30_000);

	it('decodes four beacons at -25 dB in 2500 Hz with DT up to 1.5 s, and their SNR', () => {
		const stations = [
			{ msg: 'K1ABC FN42 37', hz: 1420, snrDb: -25, dt: 0 },
			{ msg: 'G4XYZ IO91 23', hz: 1470, snrDb: -25, dt: 1.5 },
			{ msg: 'PJ4/K1ABC 30', hz: 1530, snrDb: -25, dt: -1.5 },
			{ msg: 'DL1XYZ JO62 10', hz: 1580, snrDb: -25, dt: 0.7 },
		];
		const { sink } = receive(wspr, ftxChannel(WSPR, stations, { slots: 1, tail: 2, seed: 11 }));
		expect(sink.records.map((r) => r.text).sort()).toEqual(stations.map((s) => s.msg).sort());
		for (const r of sink.records) expect(Math.abs(Number(field(r, 'SNR').split(' ')[0]) + 25), r.text).toBeLessThanOrEqual(3);
	}, 30_000);

	it('decodes nothing from noise alone', () => {
		const { sink, decoder } = receive(wspr, ftxChannel(WSPR, [], { slots: 1, tail: 2, seed: 21 }));
		expect(sink.records).toHaveLength(0);
		expect(decoder.last).toMatchObject({ slotUtc: T0, decodes: 0 });
	}, 30_000);
});
