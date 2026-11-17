// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR from OnAir tests/p25p2/test_p25p2_rx.cpp (baseConfig, run, findCall, checkDecode),
// https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the signal goes through BrowSDR's DSD stream at 48 kHz; the calls are collected from the stream's status
// reports (the slot of each report) instead of OnAir's call log; the voice frames come from the receiver's tap, and what
// reached mbelib from a mock around decodeAmbe (the tests that import this file set it up).
import { expect } from 'vitest';
import { DSDStream } from '@/worker/decoders/dsd/dsd-stream';
import { ambeUnflatten } from '@/worker/decoders/dsd/p25p2/protocol';
import {
	genCall,
	genConfig,
	msgAdjSts,
	msgGrpVGrant,
	msgIdenUp,
	msgNetSts,
	msgRfssSts,
	msgUuVGrant,
	p25p2Signal,
	p25p2VoiceFrames,
} from './fixtures.js';

export function baseConfig(over = {}) {
	return genConfig({
		snrDb: 60,
		superframes: 14,
		calls: [genCall(), genCall({ channel: 2, startSf: 2, nSf: 5, src: 777, group: 2002, algId: 0x84 })],
		sysMsgs: [
			msgIdenUp(1, 100, 0x100 | 6, 100, 170202500), // base 851.0125 MHz, 12.5 kHz steps, transmit offset +1.5 MHz
			msgNetSts(0x11, 0xbee00, 0x3a5, 0x1005, 0x70),
			msgRfssSts(0x11, 0x3a5, 1, 7, 0x1005, 0x70),
			msgAdjSts(0x11, 0x3a5, 1, 8, 0x1010, 0x70),
			msgGrpVGrant(0x00, 0x1005, 3003, 55555),
			msgUuVGrant(0x1006, 4004, 66666),
		],
		...over,
	});
}

/** Every call of the reports: the last report of each (slot, start). */
function callLog(p2) {
	const log = new Map();
	for (const s of p2)
		s.slots.forEach((c, i) => {
			if (c.startSec > 0) log.set(`${i}/${c.startSec}`, { ...c, slot: i + 1 });
		});
	return [...log.values()];
}

/** The signal (or interleaved I/Q) through a DSD stream; system: the seed to set; listen: the slot choice. */
export async function run(c, { listen = 0, system = null, chunk = 1920, iq = null } = {}) {
	const statuses = [];
	const stream = new DSDStream((s) => statuses.push(s));
	await stream.decoder.mbeInitPromise;
	const rx = stream.decoder.p25p2;
	const frames = { bits: [[], [], []], clear: [[], [], []] };
	rx.tap = (slot, bits, clear) => {
		frames.bits[slot].push(bits);
		frames.clear[slot].push(clear);
	};
	rx.setListenSlot(listen);
	if (system) rx.setSystem(...system);
	const input = iq ?? p25p2Signal(c);
	let audio = 0;
	let lockAt = -1;
	for (let i = 0; i < input.length; i += chunk) {
		const out = stream.process(input.subarray(i, i + chunk));
		if (stream.audioActive) audio += out.length;
		if (lockAt < 0 && statuses.some((s) => s.synced && s.mode === 'p25p2')) lockAt = (i + chunk) / 2 / 48000;
	}
	const p2 = statuses.filter((s) => s.mode === 'p25p2' && s.p25p2).map((s) => s.p25p2);
	return { statuses, p2, last: p2.at(-1), log: callLog(p2), frames, counters: { ...rx.counters }, audio, lockAt, rx };
}

export const findCall = (r, slot, src) => r.log.filter((c) => c.slot === slot && c.src === src).at(-1);

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Slot 1's frames that match the sent pattern in order (frames that never arrive skip ahead). */
export function matchedFrames(c, frames, ch = 1) {
	let good = 0;
	let next = 0;
	for (const bits of frames.bits[ch])
		for (let k = Math.max(0, next - 2); k < next + 60; k++)
			if (same(bits, c.voiceBits(ch, k))) {
				good++;
				next = k + 1;
				break;
			}
	return good;
}

/** The sent voice frames of a logical channel as mbelib's ambe_fr (strings), for comparing with what reached the codec. */
export function sentFrames(c, ch) {
	return new Set(Array.from({ length: p25p2VoiceFrames(c, ch) }, (_, k) => ambeUnflatten(c.voiceBits(ch, k)).join('')));
}

/** The checks of a good decode; frac: how many of the voice frames must be there. */
export function checkDecode(c, r, frac) {
	expect(r.counters.syncs + 3).toBeGreaterThanOrEqual(c.superframes);
	expect(findCall(r, 1, 1234567)).toMatchObject({ dst: 1001, group: true, encrypted: false, endSeen: true });
	expect(findCall(r, 2, 777)).toMatchObject({ dst: 2002, group: true, encrypted: true, algId: 0x84 });
	const want1 = p25p2VoiceFrames(c, 1);
	const want2 = p25p2VoiceFrames(c, 2);
	expect(r.frames.clear[1].filter(Boolean).length).toBeGreaterThanOrEqual(frac * want1);
	expect(matchedFrames(c, r.frames)).toBeGreaterThanOrEqual(frac * want1);
	// no frame of the encrypted call is handed on as clear
	expect(r.frames.clear[2].filter(Boolean)).toHaveLength(0);
	expect(r.counters.encryptedSkipped + 2).toBeGreaterThanOrEqual(frac * want2);
	expect(r.counters.encryptedSkipped).toBeLessThanOrEqual(want2);
}
