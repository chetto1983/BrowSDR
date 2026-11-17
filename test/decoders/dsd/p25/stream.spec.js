// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR from OnAir tests/p25/test_p25_rx.cpp and tests/p25/test_p25_sens.cpp,
// https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the generated signal goes through BrowSDR's DSD stream at 48 kHz instead of OnAir's P25Receiver, and the
// calls, grants and site are found in the stream's status reports and events instead of a call log and talkgroup table;
// the voice frames that reached mbelib are compared with those sent; the off-centre dial cases are left out (BrowSDR's
// DDC centres the channel); the sensitivity runs the schedule once.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DSDStream } from '@/worker/decoders/dsd/dsd-stream';
import { extractP25IMBE } from '@/worker/decoders/dsd/dsd-p25';
import { noiseIq } from '../voice-fixtures.js';
import { p25Signal, p25TestSchedule, tx } from './fixtures.js';

const codec = vi.hoisted(() => ({ frames: [] }));
vi.mock('@/worker/decoders/mbelib-init', () => ({
	ensureMbelibInitialized: async () => {},
	decodeAmbe: () => new Float32Array(160),
	decodeAmbe2400: () => new Float32Array(160),
	decodeImbe: (frame) => {
		codec.frames.push(Array.from(frame).join(''));
		return new Float32Array(160);
	},
	resetMbe: () => {},
	getMbeErrors: () => 0,
}));

beforeEach(() => {
	codec.frames.length = 0;
});

async function run(iq, chunk = 1920) {
	const statuses = [];
	const stream = new DSDStream((status) => statuses.push(status));
	await stream.decoder.mbeInitPromise;
	for (let i = 0; i < iq.length; i += chunk) stream.process(iq.subarray(i, i + chunk));
	for (let i = 0; i < 40; i++) stream.process(new Float32Array(3840)); // the end of the last call
	return { statuses, seen: statuses.filter((s) => s.p25).map((s) => s.p25) };
}

/** The last report of each call (by source and destination). */
const callOf = (seen, src, dst) => seen.filter((s) => s.call?.src === src && s.call?.dst === dst).at(-1)?.call;

function schedule({ late = false, noTerm = false } = {}) {
	return p25TestSchedule().map((t, i) => (t.kind === 'voice' ? { ...t, noHeader: late, noTerm, voiceBase: 1000 * i } : t));
}

const CASES = [
	['clean', {}],
	['+1 kHz', { cfoHz: 1000 }],
	['-1 kHz', { cfoHz: -1000 }],
	['100 ppm', { ppm: 100 }],
	['-100 ppm', { ppm: -100 }],
	['14 dB', { cnrDb: 14 }],
	['joined late', { late: true }],
	['no terminator', { noTerm: true }],
	['all at once', { cfoHz: -1000, ppm: 100, cnrDb: 14, late: true }],
];

describe('P25 Phase 1 through the DSD stream (OnAir test_p25_rx)', () => {
	it.each(CASES)('%s: site, identifiers, grant, clear, encrypted and unit calls, data', async (_name, k) => {
		const { late = false, noTerm = false, cnrDb = 40, ...impair } = k;
		const { iq, voice } = p25Signal(schedule({ late, noTerm }), { cnrDb, ...impair });
		const { seen } = await run(iq);
		const last = seen.at(-1);
		expect(last.site).toMatchObject({ wacn: 0xbee00, sysId: 0x3a1, rfss: 1, site: 5, nac: 0x293 });
		expect(last.adjacent).toEqual([expect.objectContaining({ site: 6, channel: 0x1009 })]);
		expect(last.idens[1]).toMatchObject({ baseHz: 851006250, spacingHz: 12500, txOffsetHz: -45e6 });
		expect(last.idens[2]).toMatchObject({ vu: true, baseHz: 460e6, txOffsetHz: 5e6 });
		const grant = last.grant;
		expect(grant).toMatchObject({ src: 1234567, dst: 1201, group: true, channel: 0x1010 });
		expect(Math.abs(grant.freqHz - 851206250)).toBeLessThan(1);
		const clear = callOf(seen, 1234567, 1201);
		expect(clear).toMatchObject({ group: true, encrypted: false, lateEntry: late });
		// how it ended: a call without its terminator ends when the next one starts (an event), or a second after its last frame
		const ended = seen.flatMap((s) => s.events.map((e) => e.text)).find((e) => e.startsWith('call 1234567 → TG 1201'));
		expect(ended?.endsWith(', signal lost')).toBe(noTerm);
		const enc = callOf(seen, 7654321, 1300);
		expect(enc).toMatchObject({ encrypted: true, algId: 0x84, keyId: 0x1234 });
		expect(enc.voiceFrames).toBeGreaterThan(50);
		expect(callOf(seen, 2002, 2003)).toMatchObject({ group: false, emergency: true });
		// A lone one-frame transmission after silence: with a 100 ppm clock error the chain's clock recovery may not have
		// settled on its sync yet.
		if (!impair.ppm) expect(seen.some((s) => s.events.some((e) => e.text.startsWith('PDU to LLID 2002')))).toBe(true);
		// Clear voice reaches the codec as sent; the encrypted call's never does.
		const sent = voice.map((v) => v.map((d) => Array.from(extractP25IMBE(d, 0)).join('')));
		const encrypted = new Set(sent[2]);
		expect(codec.frames.some((f) => encrypted.has(f))).toBe(false);
		const clearSent = new Set([...sent[1], ...sent[4]]);
		// (a 100 ppm clock error: the first LDU pair after the silence before a call may be missed)
		if (cnrDb >= 40) expect(codec.frames.filter((f) => clearSent.has(f)).length).toBeGreaterThanOrEqual(late || impair.ppm ? 140 : 160);
	});

	it('the events: site, identifiers, neighbour, grant, header, link control, encryption and the end of each call', async () => {
		const { seen } = await run(p25Signal(schedule(), { cnrDb: 40 }).iq);
		const events = seen.at(-1).events.map((e) => e.text);
		expect(events).toEqual(
			expect.arrayContaining([
				'NET_STS_BCST WACN BEE00 system 3A1, NAC 293, control channel 1-1',
				'RFSS_STS_BCST system 3A1, RFSS 1, site 5',
				'IDEN_UP 1: base 851.00625 MHz, spacing 12.50 kHz, transmit offset -45.000 MHz',
				'ADJ_STS_BCST system 3A1, RFSS 1, site 6 on channel 1-9',
				'GRP_V_CH_GRANT 1234567 → TG 1201 on channel 1-16 (851.20625 MHz)',
				'HDU NAC 293 talkgroup 1201, clear',
				'LDU1 group 1234567 → 1201',
				'call 1234567 → TG 1201, 2.2 s',
				'HDU NAC 293 talkgroup 1300, encrypted: AES-256 (0x84), key 4660',
				'call 2002 → 2003, 1.1 s',
			]),
		);
	});

	it('valid IMBE voice through the stream reaches the codec exactly', async () => {
		const { iq, voice } = p25Signal([tx({ durSec: 1 })], { cnrDb: 30, cfoHz: 700, validVoice: true });
		await run(iq);
		const sent = voice[0].map((d) => Array.from(extractP25IMBE(d, 0)).join(''));
		expect(codec.frames).toEqual(sent);
	});

	it('noise alone gives nothing', async () => {
		const { statuses } = await run(noiseIq(48000 * 6, 0.3, 13));
		expect(statuses.some((s) => s.p25 || s.synced)).toBe(false);
		expect(codec.frames).toHaveLength(0);
	});
});

describe('P25 Phase 1 sensitivity (OnAir test_p25_sens)', () => {
	const blocks = async (k) => {
		const { seen } = await run(p25Signal(p25TestSchedule(), k).iq);
		return Math.max(0, ...seen.map((s) => s.blocksOk));
	};
	// OnAir also holds 3 kHz off tune (its frequency capture); BrowSDR's 4800 symbols/s chain is documented to about 1.5 kHz.
	it('7 dB decodes most blocks of 30 dB, also 1.5 kHz off tune at 8 dB', async () => {
		const ref = await blocks({ cnrDb: 30 });
		const a = await blocks({ cnrDb: 7, seed: 21 });
		const b = await blocks({ cnrDb: 8, cfoHz: 1500, seed: 22 });
		const c = await blocks({ cnrDb: 8, cfoHz: -1500, seed: 23 });
		console.log(`P25 blocks: 30 dB ${ref}, 7 dB ${a}, 8 dB +1.5 kHz ${b}, -1.5 kHz ${c}`);
		expect(ref).toBeGreaterThanOrEqual(100);
		expect(a).toBeGreaterThanOrEqual(ref * 0.8);
		expect(b).toBeGreaterThanOrEqual(ref * 0.75);
		expect(c).toBeGreaterThanOrEqual(ref * 0.75);
	});
});
