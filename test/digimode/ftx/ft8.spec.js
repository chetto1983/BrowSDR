// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir tests/hfdig/test_hfdig_ft8.cpp (FT8 end to end: the generator's
// stations in one slot, DT +-1.5 s and the clock error shown, a start in the middle of a slot, upside down, noise alone
// with a carrier and bad samples), https://github.com/adswill/OnAir; see third_party/onair. Changes: one or two slots
// each; the threshold case is several stations down to -18 dB in 2500 Hz; the slot decoded a step at a time between
// blocks of audio; of the receiver's faults only the dial error; no slot search.
import { describe, expect, it } from 'vitest';
import { field, FT8, ftxChannel, ftxTestStations, generatorStations, RATE, receive, T0 } from './fixtures';
import { DIGIMODES, digimodeInfo } from '@/worker/decoders/digimode/catalog';
import { Ft8Decoder, FTX_BANDWIDTH, FTX_OFFSET_HZ, FTX_RATE } from '@/worker/decoders/digimode/ftx';

const ft8 = (sink, options) => new Ft8Decoder(sink, options);
/** The message of a record ("-12 dB +0.3 s 900 Hz K1ABC W9XYZ -12"). */
const message = (r) => field(r, 'Message');
const hzOf = (r) => Number(field(r, 'Audio frequency').split(' ')[0]);
const dtOf = (r) => Number(field(r, 'DT').split(' ')[0]);

describe('FT8 catalog entry', () => {
	it('lists the WSJT-X dial frequencies of OnAir with the USB channel', () => {
		const info = digimodeInfo('ft8');
		expect(info).toMatchObject({ family: 'Amateur', rate: FTX_RATE, bandwidth: FTX_BANDWIDTH, offsetHz: FTX_OFFSET_HZ });
		expect(info.presets.map((p) => p.freqMHz)).toEqual([1.84, 3.573, 7.074, 10.136, 14.074, 18.1, 21.074, 24.915, 28.074, 50.313]);
		expect(DIGIMODES.filter((m) => m.id === 'ft8')).toHaveLength(1);
	});
});

describe('FT8 decoder', () => {
	it("decodes OnAir's eight generator stations of one slot: standard, /P, free text and telemetry", () => {
		const stations = generatorStations(FT8, 0);
		const { sink, decoder } = receive(ft8, ftxChannel(FT8, stations, { slots: 1, tail: 2, seed: 5 }));
		expect(sink.records.map(message).sort()).toEqual(
			ftxTestStations(FT8)
				.map((s) => s.msg)
				.sort(),
		);
		for (const s of stations) {
			const r = sink.records.find((x) => message(x) === s.msg);
			expect(Math.abs(hzOf(r) - s.hz), s.msg).toBeLessThanOrEqual(1);
			expect(Math.abs(dtOf(r) - s.dt), s.msg).toBeLessThan(0.051);
		}
		const cq = sink.records.find((x) => message(x) === 'CQ K1ABC FN42');
		expect(cq.text).toMatch(/^-?\d+ dB [+-]?\d\.\d s 600 Hz CQ K1ABC FN42$/);
		expect(cq.fields).toEqual(
			expect.arrayContaining([
				['Mode', 'FT8'],
				['UTC slot', '00:00:00'],
				['Call', 'K1ABC'],
				['Grid', 'FN42'],
			]),
		);
		// best SNR first
		const snr = sink.records.map((r) => Number(r.text.split(' ')[0]));
		expect([...snr].sort((a, b) => b - a)).toEqual(snr);
		expect(decoder.last).toMatchObject({ slotUtc: T0, decodes: 8 });
		expect(sink.statuses.at(-1)).toEqual({ message: 'FT8 slot 00:00:15, 2 of 15 s · 8 decodes in the 00:00:00 slot', locked: true });
	});

	it('decodes several stations of a slot down to -18 dB in 2500 Hz, with their SNR', () => {
		const stations = [
			{ msg: 'CQ K1ABC FN42', hz: 500, snrDb: -10, dt: 0 },
			{ msg: 'K1ABC W9XYZ -12', hz: 1000, snrDb: -14, dt: 0.4 },
			{ msg: 'W9XYZ K1ABC R-05', hz: 1500, snrDb: -18, dt: -0.3 },
			{ msg: 'TNX BOB 73 GL', hz: 2000, snrDb: -16, dt: 0.8 },
			{ msg: 'G4ABC DL1XYZ RR73', hz: 2600, snrDb: -12, dt: 0.2 },
		];
		const { sink } = receive(ft8, ftxChannel(FT8, stations, { slots: 1, tail: 2, seed: 11 }));
		expect(sink.records.map(message).sort()).toEqual(stations.map((s) => s.msg).sort());
		for (const s of stations) {
			const r = sink.records.find((x) => message(x) === s.msg);
			expect(Math.abs(Number(r.text.split(' ')[0]) - s.snrDb), s.msg).toBeLessThanOrEqual(3);
			expect(Math.abs(hzOf(r) - s.hz)).toBeLessThanOrEqual(1);
		}
	});

	it('decodes stations moved by a dial 100 Hz off', () => {
		const stations = [
			{ msg: 'CQ K1ABC FN42', hz: 600, snrDb: -15, dt: 0 },
			{ msg: 'K1ABC W9XYZ -12', hz: 2500, snrDb: -15, dt: 0.4 },
		];
		const { sink } = receive(ft8, ftxChannel(FT8, stations, { slots: 1, tail: 2, dialHz: 100, seed: 13 }));
		expect(sink.records.map((r) => [message(r), hzOf(r)]).sort()).toEqual([
			['CQ K1ABC FN42', 700],
			['K1ABC W9XYZ -12', 2600],
		]);
	});

	it('finds stations 1.5 s early or late and shows the clock error', () => {
		const stations = [
			{ msg: 'CQ K1ABC FN42', hz: 700, snrDb: -12, dt: 1.5 },
			{ msg: 'K1ABC W9XYZ -12', hz: 1500, snrDb: -12, dt: -1.5 },
			{ msg: 'CQ JA1XYZ PM95', hz: 2300, snrDb: -12, dt: 1.4 },
		];
		const { sink } = receive(ft8, ftxChannel(FT8, stations, { slots: 1, tail: 2, seed: 3 }));
		expect(sink.records.map(message).sort()).toEqual(stations.map((s) => s.msg).sort());
		for (const s of stations) expect(Math.abs(dtOf(sink.records.find((x) => message(x) === s.msg)) - s.dt)).toBeLessThan(0.07);
		expect(sink.statuses.at(-1).message).toContain('clock off by +1.4 s');
	});

	it('skips a slot joined after its first second and decodes the next one', () => {
		const stations = [{ msg: 'CQ K1ABC FN42', hz: 800, snrDb: -10, dt: 0 }];
		const iq = ftxChannel(FT8, stations, { slots: 2, tail: 2, startSec: 7, seed: 9 });
		const { sink } = receive(ft8, iq, { startUtc: T0 + 7 });
		expect(sink.records.map((r) => [message(r), field(r, 'UTC slot')])).toEqual([['CQ K1ABC FN42', '00:00:15']]);
	});

	it('decodes an upside-down station (lower sideband) only when asked to look for one', () => {
		const stations = [{ msg: 'CQ DL1XYZ JO62', hz: 1800, snrDb: -10, dt: 0.2 }];
		const iq = ftxChannel(FT8, stations, { slots: 1, tail: 2, mirrored: true, seed: 4 });
		expect(receive(ft8, iq).sink.records).toHaveLength(0);
		const { sink } = receive(ft8, iq, { options: { mirrored: true } });
		expect(sink.records.map(message)).toEqual(['CQ DL1XYZ JO62']);
		expect(field(sink.records[0], 'Sideband')).toBe('Lower (heard upside down)');
		expect(hzOf(sink.records[0])).toBeCloseTo(1800, -1);
	});

	it('decodes nothing from noise with a carrier and a burst of bad samples', () => {
		const iq = ftxChannel(FT8, [], { slots: 3, tail: 2, seed: 21 });
		for (let n = 0; n < iq.length / 2; n++) {
			const a = (2 * Math.PI * (1234.5 - FTX_OFFSET_HZ) * n) / RATE;
			iq[2 * n] += 0.2 * Math.cos(a);
			iq[2 * n + 1] += 0.2 * Math.sin(a);
		}
		iq.fill(NaN, 80000, 80200);
		const { sink, decoder } = receive(ft8, iq);
		expect(sink.records).toHaveLength(0);
		expect(decoder.last).toMatchObject({ slotUtc: T0 + 30, decodes: 0 });
		expect(sink.statuses.at(-1).locked).toBe(false);
	});

	it('decodes a slot a step at a time between blocks of audio, with the same result', () => {
		const stations = generatorStations(FT8, -6).slice(0, 4);
		const iq = ftxChannel(FT8, stations, { slots: 1, tail: 8, seed: 6 });
		const { sink, decoder } = receive(ft8, iq, { options: { sliceMs: 2 } });
		expect(decoder.last).toMatchObject({ slotUtc: T0, decodes: 4 });
		expect(sink.records.map(message).sort()).toEqual(stations.map((s) => s.msg).sort());
		expect(sink.statuses.some((s) => s.message.includes('decoding the 00:00:00 slot'))).toBe(true);
	});
});
