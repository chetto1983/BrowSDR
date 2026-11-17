// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR from OnAir tests/dstar/test_dstar_rx.cpp and tests/dstar/test_dstar_sens.cpp,
// https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the generated signal goes through BrowSDR's DSD stream at 48 kHz instead of OnAir's DstarReceiver, and the
// calls are found in the stream's status reports instead of a call log; the voice bits are the AMBE matrices that reach
// mbelib (mocked: BrowSDR's mbelib build has no D-STAR AMBE 3600x2400 decoder); "swapped I/Q" is an inverted frequency.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DSTAR_W, DSTAR_X } from '@/worker/decoders/dsd/constants';
import { DSDStream } from '@/worker/decoders/dsd/dsd-stream';
import { noiseIq } from '../voice-fixtures.js';
import { dstarSignal, dstarTestSchedule } from './fixtures.js';

const codec = vi.hoisted(() => ({ frames: [] }));
vi.mock('@/worker/decoders/mbelib-init', () => ({
	ensureMbelibInitialized: async () => {},
	decodeAmbe: (frame) => {
		codec.frames.push(Array.from(frame).join(''));
		return new Float32Array(160);
	},
	decodeImbe: () => new Float32Array(160),
	resetMbe: () => {},
	getMbeErrors: () => 0,
}));

beforeEach(() => {
	codec.frames.length = 0;
});

const ambeKey = (bits) => {
	const fr = new Int8Array(96);
	for (let i = 0; i < 72; i++) fr[DSTAR_W[i] * 24 + DSTAR_X[i]] = bits[i];
	return Array.from(fr).join('');
};

async function run(iq, chunk = 1920) {
	const statuses = [];
	const stream = new DSDStream((status) => statuses.push(status));
	await stream.decoder.mbeInitPromise;
	for (let i = 0; i < iq.length; i += chunk) stream.process(iq.subarray(i, i + chunk));
	return { statuses, seen: statuses.filter((s) => s.dstar).map((s) => s.dstar) };
}

/** The last report of each transmission (by MY), and every position heard. */
function calls(seen) {
	const byMy = new Map();
	for (const s of seen) if (s.my) byMy.set(s.my, s);
	return byMy;
}

function schedule({ headerErrors = 0, dropBlock = 0, noEnd = false } = {}) {
	return dstarTestSchedule().map((t) => ({ ...t, headerErrors, dropBlock, endPattern: !noEnd }));
}

const CASES = [
	['clean', {}],
	['+2 kHz', { cfoHz: 2000 }],
	['-2 kHz', { cfoHz: -2000 }],
	['+50 ppm clock', { ppm: 50 }],
	['14 dB noise', { cnrDb: 14 }],
	['inverted', { invert: true }],
	['header 25 bit errors', { headerErrors: 25 }],
	['header ruined', { headerErrors: 160 }],
	['slow data blocks lost', { dropBlock: 9 }],
	['no end pattern', { noEnd: true }],
	['late start', { skipSec: 1.0 }],
	['all at once', { cfoHz: -2000, ppm: -40, cnrDb: 16, invert: true, headerErrors: 25, dropBlock: 11 }],
];

describe('D-STAR through the DSD stream (OnAir test_dstar_rx)', () => {
	it.each(CASES)('%s: header, message, positions, squelch and the end', async (_name, k) => {
		const { headerErrors, dropBlock, noEnd, cnrDb = 30, ...impair } = k;
		const { iq, voice } = dstarSignal(schedule({ headerErrors, dropBlock, noEnd }), { cnrDb, ...impair });
		const { seen } = await run(iq);
		const byMy = calls(seen);
		const a = byMy.get('N0CALL');
		const b = byMy.get('LY1TST');
		const late = impair.skipSec > 0;
		expect(b).toBeDefined();
		expect(b).toMatchObject({ ur: 'CQCQCQ', rpt1: 'DIRECT', text: 'Hello via simplex', squelch: 12, active: false, endSeen: !noEnd });
		expect(b.flag[0] & 0x40).toBe(0);
		expect(b.voiceFrames).toBeGreaterThanOrEqual(145);
		expect(b.voiceFrames).toBeLessThanOrEqual(noEnd ? 157 : 151);
		expect(b.inverted).toBe(!impair.invert); // OnAir's polarity is DSD's inverted D-STAR sync
		if (!late) expect(a).toBeDefined();
		if (a) {
			expect(a).toMatchObject({ sfx: 'ID51', ur: 'CQCQCQ', rpt1: 'LY0VNO B', rpt2: 'LY0VNO G', flags: 'via repeater' });
			expect(a).toMatchObject({ text: 'OnAir D-STAR test 73', endSeen: !noEnd, lateEntry: late });
			expect(a.headerFromSlow).toBe(headerErrors > 100 || late);
			if (!late) expect(a.voiceFrames).toBeGreaterThanOrEqual(195);
			if (!late) expect(a.voiceFrames).toBeLessThanOrEqual(201);
			if (!late) expect(Math.abs(a.durSec - 4)).toBeLessThan(0.05);
		}
		const events = seen.at(-1).events.map((e) => e.text);
		if (!late) expect(events).toContain('position N0CALL 54.68720, 25.27970 (NMEA)');
		expect(events.some((e) => /^position LY1TST-7 54\.898\d\d, 23\.903\d\d \(D-PRS\): OnAir D-PRS test$/.test(e))).toBe(true);
		expect(b.position).toMatchObject({ call: 'LY1TST-7', dprs: true, comment: 'OnAir D-PRS test' });
		expect(Math.abs(b.position.lat - 54.8985)).toBeLessThan(2e-4);
		expect(Math.abs(b.position.lon - 23.9036)).toBeLessThan(2e-4);
		if (a) expect(a.position).toMatchObject({ call: 'N0CALL', dprs: false, altM: 112, course: 90 });
		// What reached the codec is what was sent (a call without its end pattern may add a few noise frames at its end).
		if (!late && cnrDb >= 30) {
			const sent = new Set(voice.flat().map(ambeKey));
			const known = codec.frames.filter((f) => sent.has(f)).length;
			expect(codec.frames.length - known).toBeLessThanOrEqual(noEnd ? 12 : 0);
			expect(known).toBe(voice.flat().length);
		}
	});

	it('noise alone gives no D-STAR call', async () => {
		const { statuses } = await run(noiseIq(48000 * 6, 0.3, 3));
		expect(statuses.some((s) => s.dstar)).toBe(false);
		expect(codec.frames.length).toBeLessThanOrEqual(1);
	});
});

describe('D-STAR sensitivity (OnAir test_dstar_sens)', () => {
	const frames = async (k) => {
		codec.frames.length = 0;
		await run(dstarSignal(dstarTestSchedule(), k).iq);
		return codec.frames.length;
	};
	it('8 dB keeps nearly every voice frame of 30 dB, 7 dB most, also 2 kHz off tune', async () => {
		const ref = await frames({ cnrDb: 30 });
		const a = await frames({ cnrDb: 8, seed: 21 });
		const b = await frames({ cnrDb: 7, seed: 23 });
		const c = await frames({ cnrDb: 9, cfoHz: 2000, seed: 22 });
		console.log(`D-STAR frames: 30 dB ${ref}, 8 dB ${a}, 7 dB ${b}, 9 dB +2 kHz ${c}`);
		expect(ref).toBeGreaterThanOrEqual(345);
		expect(a).toBeGreaterThanOrEqual(ref * 0.9);
		expect(b).toBeGreaterThanOrEqual(ref * 0.7);
		expect(c).toBeGreaterThanOrEqual(ref * 0.85);
	});
});
