// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir tests/hfdig/test_hfdig_rtty.cpp (the generator's audio with
// noise into the decoder: three speeds and shifts, tuning offsets, reversed, other tone places, noise alone, the
// settings), https://github.com/adswill/OnAir; see third_party/onair. Changes: the engine and "Listen" parts are
// replaced by the BrowSDR receiver on its 8 kHz channel (records per line, status, small blocks, a 50 Bd 85 Hz signal).

import { describe, expect, it } from 'vitest';
import { addNoise, feed, field, recordingSink, rttyChannel, rttySigma, rttySignal, RTTY_TEST_TEXT, textOk } from './fixtures';
import { RTTY_BAUDS, RTTY_SHIFTS, RttyDecoder } from '@/worker/decoders/digimode/rtty/decoder';
import { RttyReceiver } from '@/worker/decoders/digimode/rtty';
import { digimodeInfo } from '@/worker/decoders/digimode/catalog';

const CASES = [
	[0, 0, 0, false, 0, '45.45/170'],
	[0, 0, 100, false, 0, '45.45/170 +100 Hz'],
	[0, 0, -100, false, 0, '45.45/170 -100 Hz'],
	[1, 3, 0, false, 0, '50/450'],
	[1, 3, 100, false, 0, '50/450 +100 Hz'],
	[1, 3, -100, false, 0, '50/450 -100 Hz'],
	[2, 4, 0, false, 0, '75/850'],
	[2, 4, 100, false, 0, '75/850 +100 Hz'],
	[2, 4, -100, false, 0, '75/850 -100 Hz'],
	[0, 0, 0, true, 0, '45.45/170 reversed'],
	[3, 1, 0, false, 1500, '100/200 at 1500 Hz'],
	[0, 2, 0, false, 700, '45.45/425 at 700 Hz'],
];

/** OnAir's run(): seconds of the test audio at 10 dB into a decoder, 800 samples at a time. */
function run(dec, audio) {
	for (let i = 0; i < audio.length; i += 800) dec.run(audio.subarray(i, i + 800));
	return dec.status();
}

describe('RTTY decoder (OnAir test_hfdig_rtty)', () => {
	it.each(CASES)('baud %i shift %i offset %i reversed %s low %i: %s', (baudIdx, shiftIdx, off, reverse, low) => {
		const lowHz = low > 0 ? low + off : 2125 + off;
		const secs = 2300 / RTTY_BAUDS[baudIdx] + 6;
		const audio = addNoise(rttySignal(secs, { baudIdx, shiftIdx, reverse, lowHz }), rttySigma(10), 12345);
		const dec = new RttyDecoder();
		dec.configure({ baudIdx, shiftIdx, reverse });
		const t = run(dec, audio);
		const shift = RTTY_SHIFTS[shiftIdx];
		expect(textOk(dec.text, 2), dec.text).toBe(true);
		expect(Math.abs(t.markHz - (reverse ? lowHz + shift : lowHz))).toBeLessThan(8);
		expect(Math.abs(t.spaceHz - (reverse ? lowHz : lowHz + shift))).toBeLessThan(8);
		expect(t.framingErrors).toBeLessThanOrEqual(6);
		expect(t.quality).toBeGreaterThan(0.2);
	});

	it('noise alone: no lock, no text', () => {
		const dec = new RttyDecoder();
		const noise = addNoise(new Float32Array(80000), 0.2 * Math.sqrt(2), 77);
		const t = run(dec, noise);
		expect(dec.text).toBe('');
		expect(t.state).toBe(0);
	});

	it('keeps its settings', () => {
		const dec = new RttyDecoder();
		dec.configure({ baudIdx: 2, shiftIdx: 4, reverse: false, unshift: true });
		expect([dec.baud, dec.shift, dec.rev]).toEqual([75, 850, false]);
		dec.configure({ baudIdx: 1, shiftIdx: 5, reverse: true });
		expect([dec.baud, dec.shift, dec.rev]).toEqual([50, 85, true]);
	});
});

describe('RTTY receiver on its channel', () => {
	const amateur = { start: { baudIdx: 0, shiftIdx: 0, reverse: true }, sliceMs: Infinity };

	it('gives a record per line with the speed, shift and tones, and the live line in the status', () => {
		const sink = recordingSink();
		const rx = new RttyReceiver(sink, amateur);
		feed(rx, rttyChannel(30, { reverse: true, lowHz: 1415 }, 8, 3));
		const lines = sink.records.map((r) => r.text);
		const msg = RTTY_TEST_TEXT.trim();
		expect(lines.filter((l) => l === msg).length).toBeGreaterThanOrEqual(2);
		const r = sink.records.find((x) => x.text === msg);
		expect(field(r, 'Speed')).toBe('45.45 Bd');
		expect(field(r, 'Shift')).toBe('170 Hz');
		expect(Math.abs(Number(field(r, 'Mark').split(' ')[0]) - 1585)).toBeLessThan(8);
		expect(Math.abs(Number(field(r, 'Space').split(' ')[0]) - 1415)).toBeLessThan(8);
		expect(field(r, 'Polarity')).toMatch(/^reversed/);
		expect(sink.statuses.some((s) => s.locked && s.message.includes(': RYRYRY CQ'))).toBe(true);
	});

	it('decodes the same in small blocks', () => {
		const iq = rttyChannel(40, { reverse: true, lowHz: 900 }, 10, 5);
		const a = recordingSink();
		const b = recordingSink();
		feed(new RttyReceiver(a, amateur), iq, 4000);
		feed(new RttyReceiver(b, amateur), iq, 37);
		expect(a.records.length).toBeGreaterThan(2);
		expect(b.records).toEqual(a.records);
	});

	it('finds the 50 Bd 85 Hz signal of DWD on 147.3 kHz', () => {
		const sink = recordingSink();
		const rx = new RttyReceiver(sink, { start: { baudIdx: 1, shiftIdx: 5, reverse: false }, sliceMs: Infinity });
		feed(rx, rttyChannel(36, { baudIdx: 1, shiftIdx: 5, lowHz: 1957 }, 12, 9));
		const lines = sink.records.map((r) => r.text);
		expect(lines.filter((l) => l === RTTY_TEST_TEXT.trim()).length).toBeGreaterThanOrEqual(2);
		expect(rx.current).toMatchObject({ baudIdx: 1, shiftIdx: 5, reverse: false });
		expect(digimodeInfo('rtty-dwd-lf')).toMatchObject({ rate: 8000, offsetHz: 2000 });
	});

	it('noise alone gives nothing', () => {
		const sink = recordingSink();
		const rx = new RttyReceiver(sink, amateur);
		feed(rx, addNoise(new Float32Array(2 * 8000 * 20), rttySigma(0), 21));
		expect(sink.records).toEqual([]);
		expect(sink.statuses.at(-1).locked).toBe(false);
	});
});
