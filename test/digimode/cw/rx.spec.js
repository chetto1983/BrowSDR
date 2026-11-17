// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir tests/cw/test_cw_rx.cpp (several speeds across the window at
// once, two signals 150 Hz apart, a tuning error with signals near the window edges, QSB and drift, a weak signal,
// hand keying with Farnsworth spacing, noise only) and tests/cw/test_cw_fistrx.cpp (the receiver's character error rate
// near the decoding limit on steady, hand, Farnsworth and sloppy keying; the first character after each pause),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: the skimmer gets its 24 kHz channel directly (no
// 250 kHz front end); the text is read from the records; the 0.2.7 timing is not ported, so the error rates are held
// to OnAir's published figures for it (4 seeds) instead of a live run; the focus and sidetone parts are replaced by
// small blocks and the status line.

import { describe, expect, it } from 'vitest';
import { cwBand, cwSig, cwTestSignals, editDistance, feed, field, messageSec, norm, recordingSink, textNear } from './fixtures';
import { CwDecoder } from '@/worker/decoders/digimode/cw';

/** The band through a skimmer; every signal's line ended at the end. */
function run(signals, secs, { cfo = 0, seed = 11, block = 2400 } = {}) {
	const sink = recordingSink();
	const dec = new CwDecoder(sink);
	feed(dec, cwBand(secs, signals, { cfoHz: cfo, seed }), block);
	const signalsAtEnd = dec.signals;
	dec.reset();
	return { sink, signals: signalsAtEnd };
}

const sig = (hz, wpm, text, snr, extra = {}) => cwSig(hz, wpm, text, snr, { pauseSec: 1.5, ...extra });

/** The signal at hz sent `want` at least once, at its speed. */
function expectSignal({ sink }, hz, want, wpm) {
	expect(textNear(sink.records, hz), `${hz} Hz`).toContain(want);
	const r = sink.records.find(
		(x) => Math.abs(Number(field(x, 'Offset').split(' ')[0].replace('−', '-')) - hz) <= 30 && field(x, 'Speed').endsWith('WPM'),
	);
	expect(Math.abs(Number(field(r, 'Speed').split(' ')[0]) - wpm), `${hz} Hz speed`).toBeLessThan(0.12 * wpm + 0.5);
}

describe('CW skimmer (OnAir test_cw_rx)', () => {
	it('reads five speeds at once across the window', () => {
		const r = run(
			[
				sig(-5200, 6, 'CQ LY2ABC', 22),
				sig(-2600, 14, 'CQ DE DL1XYZ K', 20),
				sig(300, 22, 'TEST OK1XX TEST', 18),
				sig(2400, 35, '5NN TU G4ABC <SK>', 20),
				sig(5100, 50, 'CQ TEST SP9ZZZ SP9ZZZ', 24),
			],
			48,
		);
		expectSignal(r, -5200, 'CQ LY2ABC', 6);
		expectSignal(r, -2600, 'CQ DE DL1XYZ K', 14);
		expectSignal(r, 300, 'TEST OK1XX TEST', 22);
		expectSignal(r, 2400, '5NN TU G4ABC <SK>', 35);
		expectSignal(r, 5100, 'CQ TEST SP9ZZZ SP9ZZZ', 50);
		const rec = r.sink.records.find((x) => x.text.includes('SP9ZZZ'));
		expect(rec.text).toMatch(/^\+51\d\d Hz: /);
		expect(field(rec, 'Callsigns')).toBe('SP9ZZZ');
		expect(r.sink.statuses.some((s) => s.locked && /^CW: \d+ signals?, \d decoding · [+−]\d+ Hz \d+ WPM: /.test(s.message))).toBe(true);
	});

	it('separates two signals 150 Hz apart, one 10 dB stronger', () => {
		const r = run([sig(1000, 18, 'CQ DE LY2ABC LY2ABC K', 28), sig(1150, 26, 'TEST DL1XYZ DL1XYZ', 18)], 30);
		expectSignal(r, 1000, 'DE LY2ABC LY2ABC K', 18);
		expectSignal(r, 1150, 'DL1XYZ DL1XYZ', 26);
	});

	it('hears signals where they are: a 137 Hz tuning error, near the window edges', () => {
		const r = run([sig(-6600, 20, 'CQ DE 9A1AA K', 20), sig(6500, 24, 'CQ DE W1AW K', 20)], 24, { cfo: 137 });
		expectSignal(r, -6600 + 137, 'CQ DE 9A1AA K', 20);
		expectSignal(r, 6500 + 137, 'CQ DE W1AW K', 24);
	});

	it('reads through 20 dB of QSB and follows a drifting transmitter', () => {
		const a = sig(-1500, 20, 'CQ CQ DE LY2ABC LY2ABC <AR> K', 30, { qsbDepthDb: 20, qsbPeriodSec: 6 });
		const b = sig(1800, 16, 'CQ DE OH2XYZ K', 22, { driftHzPerMin: 40 });
		const r = run([a, b], 40);
		expectSignal(r, -1500, 'DE LY2ABC LY2ABC', 20);
		expectSignal(r, 1800 + (40 * 40) / 60, 'CQ DE OH2XYZ K', 16);
	});

	it('reads a weak signal: 8 dB in 500 Hz', () => {
		expectSignal(run([sig(-800, 18, 'CQ DE LY2ABC LY2ABC K', 8)], 36), -800, 'LY2ABC', 18);
	});

	it('reads hand keying with Farnsworth spacing and finds the callsigns', () => {
		const s = sig(700, 18, 'LY2ABC DE G4ABC UR 599 599 <BT> NAME JOHN <KN>', 22, { jitter: 0.12, dashRatio: 3.5, farnsworthWpm: 10 });
		const r = run([s], 60);
		expectSignal(r, 700, 'UR 599 599', 18);
		const rec = r.sink.records.find((x) => x.text.includes('G4ABC'));
		expect(field(rec, 'Spacing')).toMatch(/^Farnsworth/);
		expect(field(rec, 'Callsigns').split(' ').length).toBeGreaterThanOrEqual(2);
	});

	it('makes no text from noise only', () => {
		const r = run([], 30);
		expect(
			r.sink.records
				.map((x) => x.text)
				.join('')
				.replace(/[^A-Z0-9]/g, '').length,
		).toBeLessThanOrEqual(2);
	});

	it("reads OnAir's test band 20 dB stronger the same in small blocks as in large ones", () => {
		const band = cwTestSignals().map((s) => ({ ...s, snrDb: s.snrDb + 20 }));
		const iq = cwBand(20, band, { seed: 3 });
		const a = recordingSink();
		const b = recordingSink();
		const da = new CwDecoder(a);
		const db = new CwDecoder(b);
		feed(da, iq, 24000);
		feed(db, iq, 53);
		da.reset();
		db.reset();
		expect(textNear(a.records, -3000)).toContain('DE LY2ABC LY2ABC <AR> K');
		expect(textNear(a.records, 2500)).toContain('5NN TU OK1XX <SK>');
		expect(b.records).toEqual(a.records);
	});
});

const TEXT = 'CQ DE LY2ABC LY2ABC K';
const CASES = {
	machine: { wpm: 22, fw: 0, jitter: 0, ratio: 3 },
	hand: { wpm: 20, fw: 0, jitter: 0.12, ratio: 3.4 },
	sloppy: { wpm: 20, fw: 0, jitter: 0.22, ratio: 2.7 },
	farnsworth: { wpm: 20, fw: 12, jitter: 0, ratio: 3 },
};
const fistSig = (c, snr, hz = 500) =>
	cwSig(hz, c.wpm, TEXT, snr, { farnsworthWpm: c.fw, jitter: c.jitter, dashRatio: c.ratio, pauseSec: 1 });

/** OnAir's run() of test_cw_fistrx: the CER (%) of the copies after the first. */
function cer(c, snr, seed, secs, hz = 500, cfo = 0) {
	const { sink, signals } = run([fistSig(c, snr, hz)], secs, { cfo, seed });
	const text = norm(textNear(sink.records, hz + cfo, 40));
	const per = messageSec(fistSig(c, 20, hz)) + 1;
	const copies = Math.floor((secs - 0.3 - 1) / per);
	const ref = new Array(Math.max(0, copies - 1)).fill(TEXT).join(' ');
	return { text, signals, cer: ref ? (100 * editDistance(ref, text)) / ref.length : 0 };
}

describe('CW skimmer near the decoding limit (OnAir test_cw_fistrx)', () => {
	// OnAir's bound is its 0.2.7 timing's CER on the same signals (docs/SENSITIVITY-3.9-E.md, 4 seeds): the adaptive
	// decoder must read better. The mean is over 4 seeds of this suite's noise.
	it.each([
		['machine', 2, 13.2],
		['hand', 2, 13.8],
		['farnsworth', 4, 18],
		['sloppy', 10, 20.4],
	])(
		"%s keying at %i dB: CER under the 0.2.7 timing's %f %%",
		(name, snr, bound) => {
			let mean = 0;
			for (let seed = 1; seed <= 4; seed++) mean += cer(CASES[name], snr, seed, 80).cer / 4;
			expect(mean).toBeLessThan(bound);
		},
		20_000,
	);

	it('reads the first character after every pause', () => {
		const o = cer(CASES.machine, 6, 3, 60);
		const copies = Math.floor(60 / (messageSec(fistSig(CASES.machine, 6)) + 1));
		expect(o.text.split('K CQ DE').length - 1).toBeGreaterThanOrEqual(copies - 2);
	});

	it('reads Farnsworth 15 dB, 90 Hz off', () => {
		expect(cer(CASES.farnsworth, 15, 2, 50, -1300, 90).cer).toBeLessThan(2);
	});
});
