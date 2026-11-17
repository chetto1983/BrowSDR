// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir tests/psk/test_psk_rx.cpp (four BPSK31 signals across the
// passband, one drifting and one with a clock error; a tuning error; two signals 70 Hz apart; weak signals at 9 and
// 7 dB; fast drift with a large clock error; PSK63; QPSK31 and QPSK63; BPSK125, BPSK250 and QPSK125; the chat lines and
// callsigns; noise alone), https://github.com/adswill/OnAir; see third_party/onair. Changes: the receiver gets its
// 24 kHz channel directly (no 250 kHz front end); the text is read from the records; the focus and Listen parts are
// replaced by small blocks and the status line.

import { describe, expect, it } from 'vitest';
import { feed, field, pskBand, pskTestSignals, recordingSink, sig, textNear } from './fixtures';
import { PSK_MODES, PskDecoder } from '@/worker/decoders/digimode/psk';

/** OnAir's run(): the band through a receiver of `mode`, the lines of every signal ended at the end. */
function run(signals, secs, mode = 0, cfo = 0, seed = 3, block = 2400) {
	const sink = recordingSink();
	const dec = new PskDecoder(sink, PSK_MODES[mode]);
	feed(dec, pskBand(secs, signals, { cfoHz: cfo, seed }), block);
	dec.reset();
	return sink;
}

const expectText = (sink, hz, want, tol = 20) => expect(textNear(sink.records, hz, tol), `${hz} Hz`).toContain(want);

describe('PSK receiver (OnAir test_psk_rx)', () => {
	it('decodes four BPSK31 signals across the band, one drifting, one with a clock error', () => {
		const v = [
			sig(700, 'CQ CQ CQ DE LY2ABC LY2ABC KO24 PSE K\n', 14),
			sig(1050, 'DL1XYZ DE G4ABC UR RST 599 NAME JOHN\n', 12, 0, { driftHzPerMin: 4, startSec: 1.2 }),
			sig(1500, 'CQ TEST DE OK1XX OK1XX TEST\n', 11, 0, { clockPpm: 100, startSec: 0.7 }),
			sig(2200, 'SP5AB DE EA3XYZ TNX FER QSO 73 SK\n', 13, 0, { startSec: 2 }),
		];
		const sink = run(v, 17);
		expectText(sink, 700, 'DE LY2ABC LY2ABC KO24');
		expectText(sink, 1050, 'UR RST 599 NAME JOHN');
		expectText(sink, 1500, 'DE OK1XX OK1XX');
		expectText(sink, 2200, 'TNX FER QSO 73');
		const r = sink.records.find((x) => x.text.includes('CQ CQ CQ DE LY2ABC'));
		expect(r.text).toMatch(/^70\d Hz: CQ CQ CQ DE LY2ABC LY2ABC KO24 PSE K$/);
		expect(field(r, 'Mode')).toBe('BPSK31');
		expect(field(r, 'Callsigns')).toBe('LY2ABC');
		expect(Number(field(r, 'SNR').split(' ')[0])).toBeGreaterThan(5);
		expect(sink.statuses.some((s) => s.locked && / Hz: CQ CQ CQ DE/.test(s.message))).toBe(true);
	});

	it('follows a tuning error of +37 Hz', () => {
		expectText(run([sig(1200, 'LY2ABC DE DL1XYZ GM ES TNX\n', 12)], 10, 0, 37), 1237, 'LY2ABC DE DL1XYZ');
	});

	it('separates two signals 70 Hz apart', () => {
		const sink = run([sig(1000, 'QRL? DE F5ABC F5ABC\n', 14), sig(1070, 'UR 599 599 BK DE I2XYZ\n', 14)], 10);
		expectText(sink, 1000, 'DE F5ABC');
		expectText(sink, 1070, '599 BK DE I2XYZ');
	});

	it('decodes weak signals: 9 dB and 7 dB in 31 Hz', () => {
		expectText(run([sig(1400, 'CQ CQ DE LY3QRP LY3QRP K\n', 9)], 12, 0, 0, 9), 1400, 'LY3QRP');
		expectText(run([sig(1400, 'CQ CQ CQ DE LY3QRP LY3QRP LY3QRP K\n', 7)], 16, 0, 0, 9), 1400, 'LY3QRP');
	});

	it('follows a fast drift with a 300 ppm symbol clock', () => {
		const s = sig(1800, 'DRIFTY DE OH2XX OH2XX TEST TEST\n', 13, 0, { driftHzPerMin: 12, clockPpm: 300 });
		expectText(run([s], 13), 1800 + (12 * 6.5) / 60, 'DE OH2XX OH2XX', 25);
	});

	it('decodes PSK63', () => {
		const sink = run([sig(900, 'PSK63 TEST DE HB9ABC HB9ABC QRZ?\n', 13, 1), sig(2000, 'CQ DE YU1XYZ YU1XYZ K\n', 13, 1)], 8, 1);
		expectText(sink, 900, 'DE HB9ABC HB9ABC');
		expectText(sink, 2000, 'CQ DE YU1XYZ');
		expect(field(sink.records[0], 'Mode')).toBe('BPSK63');
	});

	it('decodes QPSK31 and QPSK63 (the K = 5 code)', () => {
		expectText(run([sig(1300, 'QPSK31 DE ES1ABC ES1ABC PSE K\n', 15, 2)], 13, 2), 1300, 'DE ES1ABC ES1ABC');
		expectText(run([sig(1600, 'QPSK63 DE YL2XYZ YL2XYZ PSE K\n', 16, 3)], 8, 3), 1600, 'DE YL2XYZ YL2XYZ');
	});

	it('decodes BPSK125, BPSK250 and QPSK125', () => {
		const a = run([sig(1000, 'PSK125 DE LY2ABC LY2ABC PSE K\n', 14, 4), sig(2200, 'CQ DE OH1XYZ OH1XYZ K\n', 14, 4)], 6, 4);
		expectText(a, 1000, 'DE LY2ABC LY2ABC');
		expectText(a, 2200, 'CQ DE OH1XYZ');
		const b = run([sig(1200, 'PSK250 DE SP3XYZ SP3XYZ PSE K PSK250 TEST\n', 14, 5), sig(2600, 'CQ DE DL9ABC DL9ABC K\n', 14, 5)], 5, 5);
		expectText(b, 1200, 'DE SP3XYZ SP3XYZ');
		expectText(b, 2600, 'CQ DE DL9ABC');
		expectText(run([sig(1500, 'QPSK125 DE ES5QQ ES5QQ PSE K\n', 16, 6)], 6, 6), 1500, 'DE ES5QQ ES5QQ');
		expect(PSK_MODES[6]).toMatchObject({ name: 'QPSK125', baud: 125, qpsk: true });
		expect(PSK_MODES[5].baud).toBe(250);
	});

	it('gives nothing on noise alone', () => {
		const sink = run([], 12);
		expect(sink.records).toEqual([]);
	});

	it("decodes OnAir's test band 14 dB stronger, in small blocks the same as in large ones", () => {
		const band = pskTestSignals().map((s) => ({ ...s, snrDb: s.snrDb + 14 }));
		const iq = pskBand(14, band, { seed: 5 });
		const a = recordingSink();
		const b = recordingSink();
		const da = new PskDecoder(a);
		const db = new PskDecoder(b);
		feed(da, iq, 24000);
		feed(db, iq, 41);
		da.reset();
		db.reset();
		expect(textNear(a.records, 700)).toContain('CQ CQ CQ DE LY2ABC LY2ABC KO24 PSE K');
		expect(textNear(a.records, 2200)).toContain('SP5AB DE EA3XYZ TNX FER QSO 73 SK');
		expect(b.records).toEqual(a.records);
	});
});
