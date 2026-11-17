// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR from OnAir tests/fusion/test_fusion_rx.cpp, test_fusion_codec.cpp and
// test_fusion_sweep.cpp, https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the generated C4FM signal goes through BrowSDR's DSD stream (FM discriminator, RRC filter, clock recovery)
// at 48 kHz instead of OnAir's FusionReceiver; voice goes to the real mbelib WASM instead of a fake codec plug-in, so
// the voice sub-frames are valid codec frames and their mbelib error counts are checked; noise is a carrier-to-noise
// ratio in the 12.5 kHz channel; the sweep is a smaller grid.
//
// Yaesu Fusion receiver against the generated signal: every data type, callsigns, DG-ID, slow data and GPS, noise,
// tuning error, a mirrored spectrum, a start in the middle of a transmission, two transmissions in a row, and noise alone.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DSDStream } from '@/worker/decoders/dsd/dsd-stream';
import { ambeFrame, imbeFrame, unpackBits } from '@/worker/decoders/dsd/ambe';
import { channel, fmIq, loadMbelib, noiseIq } from '../voice-fixtures.js';
import { baseParams, genTransmission, gpsBlock, ysfSignal } from './fixtures.js';

const codec = vi.hoisted(() => ({ calls: [] }));
vi.mock('@/worker/decoders/mbelib-init', async (importOriginal) => {
	const actual = await importOriginal();
	const wrap =
		(kind, fn) =>
		(...args) => {
			const audio = fn(...args);
			codec.calls.push({ kind, input: Array.from(args[0]), errors: actual.getMbeErrors(), audio });
			return audio;
		};
	return {
		...actual,
		decodeAmbe: wrap('ambe', actual.decodeAmbe),
		decodeAmbe2450: wrap('ambe2450', actual.decodeAmbe2450),
		decodeImbe: wrap('imbe', actual.decodeImbe),
	};
});

beforeAll(async () => {
	await loadMbelib();
});
beforeEach(() => {
	codec.calls.length = 0;
});

async function run(iq, chunk = 1920) {
	const statuses = [];
	const stream = new DSDStream((status) => statuses.push(status));
	await stream.decoder.mbeInitPromise;
	let audio = 0;
	for (let i = 0; i < iq.length; i += chunk) {
		const out = stream.process(iq.subarray(i, i + chunk));
		if (stream.audioActive) audio += out.length;
	}
	const ysf = statuses.filter((s) => s.mode === 'ysf' && s.synced && s.ysf);
	return { statuses, ysf, last: ysf.at(-1)?.ysf, audio };
}

/** What the generator sent as mbelib input, in order. */
function expectedVoice(p) {
	const out = [];
	for (const frame of genTransmission(p, { validVoice: true }).frames)
		for (const v of frame.voice) {
			if (v.kind === 1) out.push(Array.from(ambeFrame(unpackBits(v.bytes, 72))));
			else if (v.kind === 2) out.push(Array.from(unpackBits(v.bytes, 49)));
			else out.push(Array.from(imbeFrame(unpackBits(v.bytes, 144))));
		}
	return out;
}

function base(dt, overrides = {}) {
	return baseParams({
		dt,
		commFrames: 12,
		src: 'LY1ABC',
		down: 'DB0XYZ',
		up: 'DB0UPL',
		rem: ['11111', '22222', '33333', '44444'],
		slow: '55.0N 25.3E LY1ABC',
		cm: 3,
		mr: 1,
		voip: 1,
		sqlOff: 0,
		sqlCode: 42,
		seed: 11 + dt,
		...overrides,
	});
}

function expectCalls(t, p) {
	expect(t).toMatchObject({ src: p.src, dest: p.dest, down: p.down, up: p.up });
	expect([t.rem[0], t.rem[3]]).toEqual([p.rem[0], p.rem[3]]);
}

const CODECS = ['ambe', null, 'ambe2450', 'imbe'];
const errorFrames = () => codec.calls.filter((c) => c.errors > 0).length;

describe('Yaesu Fusion through the DSD stream (OnAir test_fusion_rx, test_fusion_codec)', () => {
	it.each([0, 1, 2, 3])('data type %i, clean: every frame, callsigns, DG-ID, slow data and the voice as sent', async (dt) => {
		const p = base(dt);
		const { last, audio } = await run(ysfSignal([p], { cnrDb: 30, validVoice: true, preamble: 24 }));
		expect(last).toMatchObject({ mode: ['DN', 'Data', 'DN', 'VW'][dt], dataType: dt, dgId: 42, callMode: 3, routing: 1, voip: true });
		expectCalls(last, p);
		expect(last).toMatchObject({ ended: true, frames: p.commFrames + 2 });
		if (dt !== 3) expect(last.text).toContain('55.0N 25.3E');
		const expected = expectedVoice(p);
		// Every voice sub-frame reached mbelib, as sent, through the codec of its kind, with no error left.
		expect(codec.calls.map((c) => c.kind)).toEqual(expected.map(() => CODECS[dt]));
		expect(codec.calls.map((c) => c.input)).toEqual(expected);
		expect(errorFrames()).toBe(0);
		expect(audio).toBeGreaterThanOrEqual(expected.length * 960 - 4800);
	});

	it.each([0, 2, 3])('data type %i at 12 dB in 12.5 kHz: callsigns and voice with few codec errors', async (dt) => {
		const p = base(dt, { commFrames: 20 });
		const { last } = await run(ysfSignal([p], { cnrDb: 12, validVoice: true, seed: 9, preamble: 24 }));
		expectCalls(last, p);
		expect(last.dgId).toBe(42);
		const expected = expectedVoice(p).length;
		expect(codec.calls.length).toBeGreaterThanOrEqual(expected - 5);
		expect(errorFrames()).toBeLessThanOrEqual(expected * 0.1);
		expect(codec.calls.filter((c) => c.errors > 3)).toHaveLength(0);
	});

	it('without a transmit preamble the header is lost to clock training; the communication frames still give the callsigns', async () => {
		const p = base(2);
		const { ysf, last } = await run(ysfSignal([p], { cnrDb: 20 }));
		expect(last.frames).toBeGreaterThanOrEqual(p.commFrames);
		expectCalls(last, p);
		expect(ysf.some((s) => s.ysf.frameType === 1)).toBe(true);
	});

	it.each([
		['tuning +1.5 kHz', { cfoHz: 1500, cnrDb: 20 }],
		['tuning -1.5 kHz', { cfoHz: -1500, cnrDb: 20 }],
		['mirrored spectrum', { mirrored: true, cnrDb: 20 }],
		['tuning +1 kHz and 14 dB', { cfoHz: 1000, cnrDb: 14 }],
	])('%s', async (_name, impairments) => {
		for (const dt of [0, 2]) {
			const p = base(dt);
			const { last } = await run(ysfSignal([p], { preamble: 24, ...impairments }));
			expect(last.frames).toBeGreaterThanOrEqual(p.commFrames);
			expectCalls(last, p);
			expect(last.inverted).toBe(!!impairments.mirrored);
		}
	});

	it('a start in the middle: the later callsign cycle gives the callsigns', async () => {
		const p = base(0, { commFrames: 24 });
		const { ysf, last } = await run(ysfSignal([p], { cnrDb: 25, skipSec: 0.35 }));
		expect(ysf.every((s) => s.ysf.frameType !== 0)).toBe(true);
		expect(last.frames).toBeGreaterThanOrEqual(18);
		expect([last.src, last.dest]).toEqual([p.src, p.dest]);
	});

	it('two transmissions in a row: the status follows the second', async () => {
		const a = base(0);
		const b = base(2, { src: 'DL9XYZ', dest: 'LY1BWB', down: '', up: '', commFrames: 14, slow: 'hello' });
		const { ysf, last } = await run(ysfSignal([a, b], { cnrDb: 25, preamble: 24 }));
		expect(new Set(ysf.filter((s) => s.ysf.frameType === 0).map((s) => s.ysf.src))).toEqual(new Set(['LY1ABC', 'DL9XYZ']));
		expect(last).toMatchObject({ src: 'DL9XYZ', dest: 'LY1BWB', down: '', ended: true, frames: 16 });
		expect(last.text).toContain('hello');
		expect(last.text).not.toContain('55.0N');
	});

	it('the slow data GPS block gives a position and the radio model', async () => {
		const block = gpsBlock(54, 41, 25, true, 25, 16, 50, true, 0x25);
		const p = base(0, { slow: String.fromCharCode(...block), commFrames: 6 });
		const { last } = await run(ysfSignal([p], { cnrDb: 25 }));
		expect(last.gps).toMatchObject({ radio: 'FTM-400D' });
		expect(last.gps.lat).toBeCloseTo(54 + 41.25 / 60, 5);
		expect(last.gps.lon).toBeCloseTo(25 + 16.5 / 60, 5);
	});

	it('noise alone and an unmodulated carrier give no sync', async () => {
		for (const iq of [noiseIq(48000 * 4, 0.5, 4), channel(fmIq(new Float32Array(48000 * 3).fill(300)), { cnrDb: 10, seed: 3 })]) {
			const { statuses } = await run(iq);
			expect(statuses.some((s) => s.synced)).toBe(false);
			expect(codec.calls).toHaveLength(0);
		}
	});
});

describe('Yaesu Fusion sweep (OnAir test_fusion_sweep, smaller grid)', () => {
	// Tuning error +-1.5 kHz and symbol clock error +-100 ppm. OnAir sweeps +-2.5 kHz with its own carrier follow-up and
	// +-600 ppm; BrowSDR's DSD stream has no carrier follow-up (tune the VFO within about 1.5 kHz), real clocks are within
	// tens of ppm, and its clock recovery deliberately follows the symbol rate slowly.
	const cases = [];
	for (const dt of [0, 1, 2, 3])
		for (const cfoHz of [-1500, 1500])
			for (const [devScale, rateScale] of [
				[0.85, 0.9999],
				[1.15, 1.0001],
			])
				for (const mirrored of [false, true]) cases.push([dt, cfoHz, devScale, rateScale, mirrored]);
	it('every data type with tuning, deviation and clock errors and a mirrored spectrum at 18 dB', async () => {
		const misses = [];
		for (const [dt, cfoHz, devScale, rateScale, mirrored] of cases) {
			const p = baseParams({ dt, src: 'LY2ABC', dest: 'CQCQCQ', commFrames: 6, cm: misses.length % 2 ? 3 : 0, slow: '54.7N 25.3E' });
			const { last } = await run(ysfSignal([p], { cfoHz, devScale, rateScale, mirrored, cnrDb: 18, preamble: 48, seed: 9 + dt }));
			const ok = last && last.frames === 8 && last.ended && last.src === 'LY2ABC' && last.dest === 'CQCQCQ' && last.dataType === dt;
			if (!ok) misses.push(`dt ${dt} cfo ${cfoHz} dev ${devScale} clk ${rateScale} mirrored ${mirrored}: ${last?.frames} frames`);
		}
		expect(misses).toEqual([]);
	});
});
