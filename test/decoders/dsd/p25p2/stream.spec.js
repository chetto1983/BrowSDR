// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR from OnAir tests/p25p2/test_p25p2_rx.cpp, https://github.com/adswill/OnAir; see
// third_party/onair.
// Changes: the generated signal goes through BrowSDR's DSD stream at 48 kHz (so OnAir's checks of other input rates are
// left out: BrowSDR's DDC brings every channel to 48 kHz), the calls come from the stream's status reports and the voice
// from the receiver's tap; what reaches mbelib is recorded; the private MAC layout fallback is not ported. BrowSDR's own
// cases: a scrambled channel without a seed (the seed is solved from a MAC burst), valid AMBE+2 voice through the real
// mbelib, other DSD protocols and noise give no P25 Phase 2 sync, and the CPU time.
//
// P25 Phase 2 receiver against the generated signal: clean, with noise, with carrier offsets, with the slot choice,
// scrambled with and without the right seed, a call joined without its PTT.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DSDDecoder } from '@/worker/decoders/dsd/dsd-decoder';
import { FMDiscriminator } from '@/worker/decoders/dsd/dsd-dsp';
import { ambeFrame } from '@/worker/decoders/dsd/ambe';
import { ambeFlatten } from '@/worker/decoders/dsd/p25p2/protocol';
import { ambeEncode, loadMbelib, noiseIq, randomBits } from '../voice-fixtures.js';
import { dpmrSignal, dpmrTestSchedule } from '../dpmr/fixtures.js';
import { p25p2Signal, p25p2VoiceFrames } from './fixtures.js';
import { baseConfig, checkDecode, findCall, matchedFrames, run, sentFrames } from './helpers.js';

const codec = vi.hoisted(() => ({ calls: [], resets: 0 }));
vi.mock('@/worker/decoders/mbelib-init', async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		decodeAmbe: (frame) => {
			const audio = actual.decodeAmbe(frame);
			codec.calls.push({ input: Array.from(frame).join(''), errors: actual.getMbeErrors() });
			return audio;
		},
		resetMbe: () => {
			codec.resets++;
			actual.resetMbe();
		},
	};
});

beforeAll(async () => {
	await loadMbelib();
});
beforeEach(() => {
	codec.calls.length = 0;
	codec.resets = 0;
});

describe('P25 Phase 2 through the DSD stream (OnAir test_p25p2_rx)', () => {
	it('clean: everything the generator sends comes out', async () => {
		const c = baseConfig();
		const r = await run(c);
		checkDecode(c, r, 1);
		const { last, counters } = r;
		expect(r.statuses.at(-1)).toMatchObject({ mode: 'p25p2', synced: true, syncName: 'P25P2' });
		expect(Math.abs(last.cfoHz)).toBeLessThan(20);
		expect(last.snrDb).toBeGreaterThan(25);
		expect(counters.macBad).toBe(0);
		expect(last.endNac).toBe(0x293);
		expect(last.site).toMatchObject({ sysId: 0x3a5, wacn: 0xbee00, rfss: 1, site: 7, channel: 0x1005, freqHz: 851012500 + 5 * 12500 });
		const grants = r.p2.map((s) => s.grant).filter(Boolean);
		expect(grants).toContainEqual(
			expect.objectContaining({ group: true, dst: 3003, src: 55555, channel: 0x1005, freqHz: 851012500 + 5 * 12500 }),
		);
		expect(grants).toContainEqual(expect.objectContaining({ group: false, dst: 4004, src: 66666, channel: 0x1006 }));
		expect(counters.v4 * counters.v2 * counters.sacch * counters.facch).toBeGreaterThan(0);
		// every clear frame of slot 1, and nothing else, reached mbelib; the codec started afresh at the call's FACCHs
		const sent = sentFrames(c, 1);
		expect(codec.calls).toHaveLength(p25p2VoiceFrames(c, 1));
		expect(codec.calls.every((k) => sent.has(k.input))).toBe(true);
		expect(r.p2.some((s) => s.audioSlot === 1)).toBe(true);
		expect(codec.resets).toBeGreaterThan(0);
	});

	it.each([
		[20, 0.95],
		[15, 0.95],
		[12, 0.7],
	])('%d dB SNR: the Reed-Solomon codes and the sync carry it', async (snr, frac) => {
		const c = baseConfig({ snrDb: snr, seed: 11 });
		checkDecode(c, await run(c), frac);
	});

	it('9 dB and 6 dB: where the decode falls apart (reported only)', async () => {
		for (const snr of [9, 6]) {
			const c = baseConfig({ snrDb: snr, seed: 11 });
			const r = await run(c);
			expect(r.frames.clear[2].filter(Boolean)).toHaveLength(0);
			console.log(
				`P25 Phase 2 at ${snr} dB: ${matchedFrames(c, r.frames)} of ${p25p2VoiceFrames(c, 1)} voice frames of slot 1, MAC ok ${r.counters.macOk} bad ${r.counters.macBad}`,
			);
		}
	});

	it.each([-400, -250, -100, 60, 180, 350])('carrier offset %d Hz: measured on the sync', async (cfo) => {
		const c = baseConfig({ snrDb: 25, cfoHz: cfo, seed: 3 });
		const r = await run(c);
		checkDecode(c, r, 0.97);
		expect(Math.abs(r.last.cfoHz - cfo)).toBeLessThan(25);
	});

	it.each([0, 5, 90])('unit to unit and emergency call (lead-in %d dibits)', async (lead) => {
		const c = baseConfig({ leadDibits: lead, seed: 2 + lead });
		Object.assign(c.calls[0], { unitToUnit: true, group: 424242, svcOpts: 0x80 });
		expect(findCall(await run(c), 1, 1234567)).toMatchObject({ group: false, dst: 424242, emergency: true });
	});

	it('the slot choice: only the chosen logical channel is played', async () => {
		const c = baseConfig();
		c.calls[1].algId = 0x80; // both calls clear now
		for (const listen of [0, 1, 2]) {
			codec.calls.length = 0;
			const r = await run(c, { listen });
			expect(r.frames.bits[1].length).toBeGreaterThan(20);
			expect(r.frames.bits[2].length).toBeGreaterThan(20);
			const played = listen || 1; // the first slot heard
			const sent = sentFrames(c, played);
			expect(codec.calls.length).toBe(p25p2VoiceFrames(c, played));
			expect(codec.calls.every((k) => sent.has(k.input))).toBe(true);
		}
	});

	it('scrambled: decodes with the seed of the control channel; with a wrong one the voice and the ESS fail', async () => {
		const c = baseConfig({ scramble: true, snrDb: 30, seed: 9 });
		const r = await run(c, { system: [c.wacn, c.sysId, c.colorCode] });
		checkDecode(c, r, 0.95);
		expect(r.last).toMatchObject({ wacn: c.wacn, sysId: c.sysId, nac: c.colorCode, seed: 'set' });
		expect(r.counters.essOk).toBeGreaterThanOrEqual(8);
		expect(r.counters.essBad).toBe(0);
		const w = await run(c, { system: [c.wacn, c.sysId, c.colorCode ^ 1] });
		expect(w.counters.essOk).toBe(0);
		expect(w.counters.macOk).toBe(0);
		expect(matchedFrames(c, w.frames)).toBe(0);
		expect(w.counters.ischExact).toBeGreaterThan(10);
		expect(w.counters.duidBad).toBe(0);
		expect(w.counters.unknownSkipped).toBeGreaterThan(0); // the voice of a call whose ESS never decodes is skipped
	});

	it('scrambled without a seed: the seed is solved from a MAC burst (BrowSDR)', async () => {
		const c = baseConfig({ scramble: true, snrDb: 20, seed: 9 });
		const r = await run(c);
		checkDecode(c, r, 0.9);
		expect(r.last).toMatchObject({ wacn: 0xbee00, sysId: 0x3a5, nac: 0x293, seed: 'recovered' });
		expect(r.counters.seedsRecovered).toBe(1);
		const sent = sentFrames(c, 1);
		expect(codec.calls.every((k) => sent.has(k.input))).toBe(true);
	});

	it('a call joined without its PTT: the voice is held until the ESS says clear (or dropped when it says encrypted)', async () => {
		const c = baseConfig();
		Object.assign(c.calls[0], { startSf: -1, nSf: 8 });
		Object.assign(c.calls[1], { startSf: -1, nSf: 8 });
		const r = await run(c);
		const a = r.log.find((x) => x.slot === 1);
		const b = r.log.find((x) => x.slot === 2);
		expect(a).toMatchObject({ encrypted: false, algId: 0x80 });
		expect(a.clearFrames + 4).toBeGreaterThanOrEqual(a.voiceFrames);
		expect(b).toMatchObject({ encrypted: true, algId: 0x84, keyId: 0x1234, clearFrames: 0 });
		expect(r.frames.clear[2].filter(Boolean)).toHaveLength(0);
		const sent = sentFrames(c, 1);
		expect(codec.calls.length).toBeGreaterThan(0);
		expect(codec.calls.every((k) => sent.has(k.input))).toBe(true);
	});

	it('voice through mbelib at 15 dB with few codec errors', async () => {
		const voiceBits = (ch, k) => ambeFlatten(ambeFrame(ambeEncode(randomBits(ch * 100003 + k * 7919 + 5, 49))));
		const c = baseConfig({ snrDb: 15, seed: 21, voiceBits });
		const r = await run(c);
		const want = p25p2VoiceFrames(c, 1);
		const sent = sentFrames(c, 1);
		expect(findCall(r, 1, 1234567)).toMatchObject({ dst: 1001, voice: true });
		expect(codec.calls.length).toBeGreaterThanOrEqual(want - 4);
		expect(codec.calls.filter((k) => sent.has(k.input)).length).toBeGreaterThanOrEqual(want * 0.9);
		expect(codec.calls.filter((k) => k.errors > 0).length).toBeLessThanOrEqual(want * 0.1);
		expect(r.audio).toBeGreaterThan(codec.calls.length * 900);
	});
});

describe('P25 Phase 2 auto-detection', () => {
	it('noise alone gives no sync (14 s)', async () => {
		const r = await run(null, { iq: noiseIq(48000 * 14, 0.3, 11) });
		expect(r.statuses.some((s) => s.synced)).toBe(false);
		expect(r.counters.syncs).toBe(0);
		expect(codec.calls).toHaveLength(0);
	});

	it('a dPMR signal is not taken for P25 Phase 2', async () => {
		const { iq } = dpmrSignal(dpmrTestSchedule(), { cnrDb: 20 });
		const r = await run(null, { iq });
		expect(r.statuses.some((s) => s.mode === 'dpmr' && s.synced)).toBe(true);
		expect(r.statuses.some((s) => s.mode === 'p25p2')).toBe(false);
	});

	it('CPU: the P25 Phase 2 receiver against the rest of the DSD chain', () => {
		const c = baseConfig({ snrDb: 20, superframes: 28 });
		const signal = p25p2Signal(c);
		const noise = noiseIq(48000 * 10, 0.3, 5);
		const time = (iq, withIq) => {
			const decoder = new DSDDecoder(
				() => {},
				() => {},
			);
			const fm = new FMDiscriminator();
			const t0 = performance.now();
			for (let i = 0; i < iq.length; i += 1920) {
				const chunk = iq.subarray(i, i + 1920);
				const audio = new Float32Array(chunk.length / 2);
				fm.process(chunk, audio);
				decoder.process(audio, withIq ? chunk : undefined);
			}
			return (performance.now() - t0) / (iq.length / 2 / 48000);
		};
		const ms = {
			noiseWithout: time(noise, false),
			noiseWith: time(noise, true),
			signalWithout: time(signal, false),
			signalWith: time(signal, true),
		};
		console.log(`DSD CPU per second of signal (ms): ${JSON.stringify(ms)}`);
		expect(ms.signalWith).toBeLessThan(250);
	});
});
