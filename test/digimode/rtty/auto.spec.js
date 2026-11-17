// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir tests/hfdig/test_hfdig_rttyauto.cpp (rttyAutoAnalyse on every
// speed, shift and polarity at 15 dB, the noise sweep, noise alone and a steady tone, Auto through the decoder with a
// wrong setting), https://github.com/adswill/OnAir; see third_party/onair. Changes: the noise is Gaussian from this
// file's generator; the 85 Hz shift BrowSDR adds is checked as well; Auto runs through the BrowSDR receiver (OnAir's
// one-click autoLock is not ported).

import { describe, expect, it } from 'vitest';
import { addNoise, feed, recordingSink, rttyChannel, rttySigma, rttySignal, gauss } from './fixtures';
import { rttyAutoAnalyseNow } from '@/worker/decoders/digimode/rtty/auto';
import { RTTY_BAUDS, RTTY_SHIFTS } from '@/worker/decoders/digimode/rtty/decoder';
import { RttyReceiver } from '@/worker/decoders/digimode/rtty';

/** OnAir's rtty(): seconds of the transmission at an SNR in 3 kHz. */
const rtty = (baudIdx, shiftIdx, reverse, lowHz, snrDb, seconds, seed) =>
	addNoise(rttySignal(seconds, { baudIdx, shiftIdx, reverse, lowHz, text: '' }), rttySigma(snrDb), seed);
/** 170 / 200 and 425 / 450 Hz are told apart by the spacing of two broad lines: the decoder works with either. */
const shiftNear = (a, b) => Math.abs(RTTY_SHIFTS[a] - RTTY_SHIFTS[b]) <= 30;

describe('RTTY Auto (OnAir test_hfdig_rttyauto)', () => {
	it('finds every speed, shift and polarity at 15 dB', () => {
		let [ok, okNear, n, lowOk] = [0, 0, 0, 0];
		const misses = [];
		for (let b = 0; b < 4; b++)
			for (let s = 0; s < 5; s++)
				for (const rv of [false, true]) {
					const low = 400 + 45 * ((b * 5 + s) * 2 + (rv ? 1 : 0));
					const h = rttyAutoAnalyseNow(rtty(b, s, rv, low, 15, 14, 100 + n));
					n++;
					const top = h[0];
					const good = top && top.baudIdx === b && top.shiftIdx === s && top.reverse === rv;
					if (good) ok++;
					else misses.push(`${RTTY_BAUDS[b]}/${RTTY_SHIFTS[s]}${rv ? ' rev' : ''}: ${top ? `${top.baud}/${top.shiftHz}` : 'nothing'}`);
					if (top && top.baudIdx === b && top.reverse === rv && shiftNear(top.shiftIdx, s)) okNear++;
					if (top && Math.abs(top.lowHz - low) < 15) lowOk++;
				}
		expect(okNear, misses.join('; ')).toBe(n);
		expect(ok, misses.join('; ')).toBeGreaterThanOrEqual(36);
		expect(lowOk).toBeGreaterThanOrEqual(n - 1);
	});

	it('finds 50 Bd with an 85 Hz shift, both polarities', () => {
		for (const rv of [false, true]) {
			const h = rttyAutoAnalyseNow(rtty(1, 5, rv, 1800, 15, 14, rv ? 7 : 8));
			expect(h[0]).toMatchObject({ baudIdx: 1, shiftIdx: 5, reverse: rv });
		}
	});

	it('finds 45.45/170 and reversed 75/425 at 10 dB', () => {
		let [g, tot] = [0, 0];
		for (let c = 0; c < 2; c++)
			for (let k = 0; k < 4; k++) {
				const [b, s] = c ? [2, 2] : [0, 0];
				const h = rttyAutoAnalyseNow(rtty(b, s, c === 1, 1400 + 130 * k, 10, 16, 300 + k + 10 * c));
				tot++;
				if (h[0] && h[0].baudIdx === b && shiftNear(h[0].shiftIdx, s) && h[0].reverse === (c === 1)) g++;
			}
		expect(g).toBe(tot);
	});

	it('finds nothing in noise alone or in a steady tone', () => {
		let bad = 0;
		for (let k = 0; k < 6; k++) {
			const g = gauss(900 + k);
			const a = new Float32Array(16 * 8000);
			for (let i = 0; i < a.length; i++) a[i] = 0.2 * g() + (k >= 3 ? 0.3 * Math.sin((2 * Math.PI * 1500 * i) / 8000) : 0);
			if (rttyAutoAnalyseNow(a).length) bad++;
		}
		expect(bad).toBe(0);
	});

	it('moves the receiver from a wrong setting to 75 Bd, 450 Hz, reversed', () => {
		const sink = recordingSink();
		const rx = new RttyReceiver(sink, { start: { baudIdx: 0, shiftIdx: 0, reverse: false }, sliceMs: Infinity });
		feed(rx, rttyChannel(24, { baudIdx: 2, shiftIdx: 3, reverse: true, lowHz: 1900, text: '' }, 12, 77));
		expect(rx.autoState).toBe(2);
		expect(RTTY_BAUDS[rx.current.baudIdx]).toBe(75);
		expect(Math.abs(RTTY_SHIFTS[rx.current.shiftIdx] - 450)).toBeLessThanOrEqual(30);
		expect(rx.current.reverse).toBe(true);
		expect(rx.dec.chars).toBeGreaterThan(100);
		expect(sink.records.some((r) => r.text.includes('THE QUICK BROWN FOX'))).toBe(true);
	});
});
