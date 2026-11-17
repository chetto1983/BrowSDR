// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR from OnAir tests/p25p2/test_p25p2_impair.cpp and tests/p25p2/test_p25p2_audit.cpp,
// https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the signal goes through BrowSDR's DSD stream at 48 kHz, so the scenarios at other input rates are run at
// 48 kHz and the carrier offsets beyond BrowSDR's 12.5 kHz channel filter (OnAir's +-5 and +6 kHz) are left out; the
// signals are 20 superframes instead of 40; the time to the first sync is the time to the first P25 Phase 2 status of
// the stream; OnAir's event texts are checked through the call state (key ID, message indicator, "encryption unknown").
//
// P25 Phase 2 (H-DQPSK TDMA voice channel, scrambled) under real-world impairments: carrier offsets, noise, a simulcast
// echo, Rayleigh fading, a sample drop-out and a symbol clock error, with one clear call on slot 1 and one encrypted call
// on slot 2; and the audit fixes: joining mid-superframe, keyed calls, lost and missing encryption syncs, and MAC message
// lengths in a signalling PDU.
import { beforeAll, describe, expect, it } from 'vitest';
import { loadMbelib } from '../voice-fixtures.js';
import { genCall, genConfig, msgGrpVGrant, msgNetSts, p25p2VoiceFrames, put16, put24 } from './fixtures.js';
import { findCall, matchedFrames, run } from './helpers.js';

beforeAll(async () => {
	await loadMbelib();
});

const SEED = { wacn: 0xbee00, sysId: 0x3a5, colorCode: 0x293 };
const system = [SEED.wacn, SEED.sysId, SEED.colorCode];

async function scenario(over) {
	const c = genConfig({
		snrDb: 30,
		superframes: 20,
		scramble: true,
		calls: [genCall({ nSf: 14 }), genCall({ channel: 2, startSf: 2, nSf: 13, src: 777, group: 2002, algId: 0x84 })],
		sysMsgs: [msgGrpVGrant(0x00, 0x1005, 3003, 55555)],
		...over,
	});
	const r = await run(c, { system });
	const { essOk, essBad } = r.counters;
	return {
		r,
		lockSec: r.lockAt,
		voicePct: (100 * matchedFrames(c, r.frames)) / Math.max(1, p25p2VoiceFrames(c, 1)),
		essPct: (100 * essOk) / Math.max(1, essOk + essBad),
		falseClear: r.frames.clear[2].filter(Boolean).length,
		falseCalls: r.log.filter((k) => k.src >= 0 && k.src !== 1234567 && k.src !== 777).length,
		callsOk: !!findCall(r, 1, 1234567) && !!findCall(r, 2, 777),
	};
}

const SCENARIOS = [
	['clean', {}, false],
	['cfo +1 kHz', { cfoHz: 1000 }, false],
	['cfo -2 kHz', { cfoHz: -2000 }, false],
	['cfo +2.6 kHz', { cfoHz: 2600 }, false],
	['cfo -2.6 kHz, snr 16 dB', { cfoHz: -2600, snrDb: 16 }, false],
	['cfo +4 kHz', { cfoHz: 4000 }, false],
	['clock +30 ppm, cfo +1 kHz', { ppm: 30, cfoHz: 1000 }, false],
	['snr 14 dB', { snrDb: 14 }, false],
	['snr 10 dB, cfo -1.5 kHz', { snrDb: 10, cfoHz: -1500 }, true],
	['snr 7 dB', { snrDb: 7 }, true],
	['simulcast echo 10 us -6 dB', { echoUs: 10, echoDf: 20 }, false],
	['simulcast echo 30 us -6 dB', { echoUs: 30, echoDf: 20 }, true],
	['fading 5 Hz, snr 20', { fadeHz: 5, snrDb: 20 }, true],
	['fading 60 Hz, snr 20', { fadeHz: 60, snrDb: 20 }, true],
	['drop-out 0.3 s every 2 s', { dropSec: 0.3 }, true],
];

describe('P25 Phase 2 under real-world impairments (OnAir test_p25p2_impair)', () => {
	it.each(SCENARIOS)('%s', async (name, over, harsh) => {
		const s = await scenario(over);
		console.log(
			`${name}: lock ${s.lockSec.toFixed(2)} s, voice ${s.voicePct.toFixed(1)} %, ESS ${s.essPct.toFixed(1)} %, cfo ${s.r.last?.cfoHz.toFixed(0)} Hz`,
		);
		expect(s.falseClear).toBe(0);
		expect(s.falseCalls).toBe(0);
		if (harsh) return;
		expect(s.lockSec).toBeGreaterThanOrEqual(0);
		expect(s.lockSec).toBeLessThan(1.5);
		expect(s.callsOk).toBe(true);
		expect(s.essPct).toBeGreaterThan(90);
	});
});

describe('P25 Phase 2 audit fixes (OnAir test_p25p2_audit)', () => {
	const base = (over) => genConfig({ snrDb: 60, superframes: 14, scramble: true, ...over });

	it.each([3, 4, 7])('A2: joined %d slots into a superframe, the first bursts are not read on a guessed slot', async (drop) => {
		const c = base({ calls: [genCall({ channel: 2, startSf: 0, nSf: 12, src: 777, group: 2002 })], dropFirstSlots: drop });
		const r = await run(c, { system });
		expect(r.log.filter((k) => k.slot === 1)).toHaveLength(0);
		expect(r.rx.locked).toBe(true);
		expect(r.counters.slotsSkipped).toBeGreaterThanOrEqual(drop % 4 >= 2 || drop === 3 ? 1 : 0);
		expect(findCall(r, 2, 777)?.voiceFrames).toBeGreaterThan(40);
		expect(r.counters.slotsBad).toBe(0);
		expect(r.counters.duidBad).toBe(0);
	});

	it('a keyed call: the PTT carries algorithm, key ID and MI; no voice is decoded', async () => {
		const c = base({ calls: [genCall({ nSf: 8, src: 100, group: 3003, algId: 0x84, keyId: 0x0abc, pttInfo: true })] });
		const r = await run(c, { system });
		expect(findCall(r, 1, 100)).toMatchObject({ encrypted: true, algId: 0x84, keyId: 0x0abc, mi: '112233445566778899' });
		expect(r.counters.voiceDecoded).toBe(0);
		expect(r.counters.encryptedSkipped).toBeGreaterThan(20);
	});

	it('B8: a late entry learns the encryption from the ESS; one lost ESS later does not make it unknown again', async () => {
		const c = base({ calls: [genCall({ nSf: 10, src: 100, group: 3003, algId: 0x84, noPtt: true, essBadSf: 5 })] });
		const r = await run(c, { system });
		expect(r.log.find((k) => k.slot === 1)).toMatchObject({ cryptoKnown: true, encrypted: true, keyId: 0x1234, essMissing: false });
		expect(r.counters.essOk).toBeGreaterThanOrEqual(3);
		expect(r.counters.essBad).toBeGreaterThanOrEqual(1);
		expect(r.counters.essReused).toBeGreaterThanOrEqual(1);
		expect(r.counters.voiceDecoded).toBe(0);
	});

	it('B9: an ESS that never decodes: after three superframes the call is labelled and its voice skipped', async () => {
		const c = base({ calls: [genCall({ nSf: 10, src: 100, group: 3003, noPtt: true, noEss: true })] });
		const r = await run(c, { system });
		expect(r.log.find((k) => k.slot === 1)).toMatchObject({ cryptoKnown: false, essMissing: true });
		expect(r.counters.unknownSkipped).toBeGreaterThan(20);
		expect(r.counters.voiceDecoded).toBe(0);
	});

	it('a signalling PDU with a 0x08 and a 0x11 in front of the messages that matter, and an extended grant', async () => {
		const grant = [0xc0, 0x04, ...new Array(9).fill(0)];
		put16(grant, 2, 0x1010);
		put16(grant, 4, 0x1020);
		put16(grant, 6, 4004);
		put24(grant, 8, 555);
		const lead1 = [0x08, 0x02];
		const lead2 = [0x11, 0x00, 0, 0];
		// each sysMsgs entry is wrapped in one MAC_SIGNAL: the receiver has to step over the 0x08 and the 0x11 to reach the rest
		const c = base({
			sysMsgs: [
				[...lead1, ...lead2, ...msgNetSts(0x11, 0xbee00, 0x3a5, 0x1005, 0x70)],
				[...lead1, ...grant],
			],
		});
		const r = await run(c, { system });
		expect(r.last.site).toMatchObject({ wacn: 0xbee00, sysId: 0x3a5 });
		expect(r.p2.map((s) => s.grant)).toContainEqual(expect.objectContaining({ dst: 4004, src: 555, channel: 0x1010, group: true }));
	});
});
