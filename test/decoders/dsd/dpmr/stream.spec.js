// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR from OnAir tests/dpmr/test_dpmr_rx.cpp and tests/dpmr/test_dpmr_sens.cpp,
// https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the generated signal goes through BrowSDR's DSD stream at 48 kHz instead of OnAir's DpmrReceiver, and the
// transmissions are found in the stream's status reports instead of a call log; voice goes to the real mbelib WASM
// (valid AMBE+2 frames) and what reached it is compared with what was sent; the PMR446 scan case is left out (BrowSDR
// has no scan); the sensitivity runs the test schedule once instead of 20 s in a loop.
//
// dPMR receiver against the test signal with real-world faults: +-1 kHz offset, clock errors, noise, symbol errors, a
// call joined late, a call without its end frame, all at once; sensitivity; noise only.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DSDStream } from '@/worker/decoders/dsd/dsd-stream';
import { ambeFrame } from '@/worker/decoders/dsd/ambe';
import { loadMbelib, noiseIq } from '../voice-fixtures.js';
import { dpmrSignal, dpmrTestSchedule } from './fixtures.js';

const codec = vi.hoisted(() => ({ calls: [] }));
vi.mock('@/worker/decoders/mbelib-init', async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		decodeAmbe: (frame) => {
			const audio = actual.decodeAmbe(frame);
			codec.calls.push({ input: Array.from(frame), errors: actual.getMbeErrors() });
			return audio;
		},
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
	return { statuses, seen: statuses.filter((s) => s.mode === 'dpmr' && s.dpmr).map((s) => s.dpmr), audio };
}

const find = (seen, kind, src) => seen.filter((s) => s.kind === kind && s.src === src).at(-1);

function schedule({ late = false, noEnd = false } = {}) {
	return dpmrTestSchedule().map((t) => (t.kind === 'voice' ? { ...t, noHeader: late, noEnd } : t));
}

const CASES = [
	['clean', {}],
	['+1 kHz', { cfoHz: 1000 }],
	['-1 kHz', { cfoHz: -1000 }],
	['+150 ppm', { ppm: 150 }],
	['-150 ppm', { ppm: -150 }],
	['16 dB noise', { cnrDb: 16 }],
	['1 % symbol errors', { symErrRate: 0.01 }],
	['late entry', { late: true }],
	['no end frame', { noEnd: true }],
	['all at once', { cfoHz: 900, ppm: 100, cnrDb: 18, symErrRate: 0.005, late: true }],
];

describe('dPMR through the DSD stream (OnAir test_dpmr_rx)', () => {
	it.each(CASES)('%s: calls, status, short message and packet data', async (_name, k) => {
		const { late = false, noEnd = false, cnrDb = 40, ...impair } = k;
		const { iq, voice } = dpmrSignal(schedule({ late, noEnd }), { cnrDb, validVoice: true, ...impair });
		const { seen } = await run(iq);
		const v1 = find(seen, 'voice', 1001);
		expect(v1).toMatchObject({ dst: 200, callType: 'group', colourCode: 7, lateEntry: late });
		if (!noEnd) expect(v1).toMatchObject({ ended: true, lost: false });
		expect(find(seen, 'status', 1002)).toMatchObject({ dst: 1001, text: 'status 17', callType: 'individual' });
		const sm = find(seen, 'message', 2005);
		expect(sm).toMatchObject({ dst: 2001, colourCode: 12, ended: true });
		if (impair.symErrRate) expect(sm.text.startsWith('HELLO')).toBe(true);
		else expect(sm.text).toBe('HELLO FROM DPMR PMR446 CHANNEL');
		expect(find(seen, 'packet', 2006)).toMatchObject({ dst: 0xffffff, text: 'PACKET DATA', callType: 'all call' });
		expect(find(seen, 'voice', 2001)).toMatchObject({ dst: 2002, callType: 'individual', emergency: true, colourCode: 12 });
		// What reached the codec is what was sent (a call without its end frame may add a few noise frames at its end).
		if (!impair.symErrRate && cnrDb >= 30) {
			const sent = new Set(voice.map((bits) => ambeFrame(bits).join('')));
			const known = codec.calls.filter((c) => sent.has(c.input.join(''))).length;
			expect(known).toBeGreaterThan(0);
			expect(codec.calls.length - known).toBeLessThanOrEqual(noEnd ? 6 : 0);
			if (!late) expect(known).toBe(voice.length);
		}
	});

	it('voice through mbelib at 12 dB in 6.25 kHz with few codec errors', async () => {
		const { iq, voice } = dpmrSignal(schedule(), { cnrDb: 12, validVoice: true, seed: 7 });
		const { seen, audio } = await run(iq);
		expect(find(seen, 'voice', 1001)).toMatchObject({ dst: 200, colourCode: 7 });
		expect(codec.calls.length).toBeGreaterThanOrEqual(voice.length - 8);
		expect(codec.calls.filter((c) => c.errors > 0).length).toBeLessThanOrEqual(voice.length * 0.1);
		expect(audio).toBeGreaterThan(codec.calls.length * 900);
	});

	it('noise alone gives no sync', async () => {
		const { statuses } = await run(noiseIq(48000 * 4, 0.3, 11));
		expect(statuses.some((s) => s.synced)).toBe(false);
		expect(codec.calls).toHaveLength(0);
	});
});

describe('dPMR sensitivity (OnAir test_dpmr_sens)', () => {
	const blocks = async (k) => {
		const { seen } = await run(dpmrSignal(dpmrTestSchedule(), k).iq);
		return Math.max(0, ...seen.map((s) => s.blocks));
	};
	it('9 dB and 8 dB with a 1 kHz offset decode nearly every block of 30 dB', async () => {
		const ref = await blocks({ cnrDb: 30 });
		const a = await blocks({ cnrDb: 9, seed: 21 });
		const b = await blocks({ cnrDb: 8, cfoHz: 1000, seed: 22 });
		expect(ref).toBeGreaterThanOrEqual(60);
		expect(a).toBeGreaterThanOrEqual(ref * 0.9);
		expect(b).toBeGreaterThanOrEqual(ref * 0.75);
	});
});
