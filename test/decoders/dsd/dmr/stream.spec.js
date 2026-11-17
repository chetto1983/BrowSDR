// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR from OnAir tests/dmr/test_dmr_rx.cpp (calls, talker alias, text messages and
// control blocks of the generated base station at several signal-to-noise ratios), tests/dmr/test_dmr_xpt.cpp (the
// receiver part) and tests/dmr/test_dmr_lrrp_air.cpp, https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the generated signal goes through BrowSDR's DSD stream (FM discriminator, RRC filter, clock recovery and
// slicer) at 48 kHz instead of OnAir's DmrReceiver; the script is fixed so each test knows what was sent; noise is a
// carrier-to-noise ratio in the 12.5 kHz channel; Tier III, Capacity Plus and Connect Plus blocks are added.
import { beforeAll, describe, expect, it } from 'vitest';
import { DSDStream } from '@/worker/decoders/dsd/dsd-stream';
import { loadMbelib, noiseIq } from '../voice-fixtures.js';
import { dmrLrrpEncode, dmrSignal, SlotScript, tmsPacket } from './fixtures.js';

beforeAll(async () => {
	await loadMbelib();
});

async function run(iq, chunk = 1920) {
	const statuses = [];
	const stream = new DSDStream((status) => statuses.push(status));
	await stream.decoder.mbeInitPromise;
	for (let i = 0; i < iq.length; i += chunk) stream.process(iq.subarray(i, i + chunk));
	const dmr = statuses.filter((s) => s.dmr).at(-1)?.dmr;
	return { statuses, dmr, events: (dmr?.events ?? []).map((e) => e.text) };
}

/** Calls one after another on slot 1 while slot 2 idles or sends control blocks. */
function callsScript() {
	const s1 = new SlotScript(1).idle(4);
	s1.voiceCall({ src: 2145007, dst: 2149, alias: 'Test Station 1', aliasFormat: 0, superframes: 4 }).idle(3);
	s1.voiceCall({ kind: 1, src: 2623266, dst: 2145016, svc: 0x80, alias: 'Café Ops', aliasFormat: 2, header: false }).idle(3);
	s1.voiceCall({ src: 250997, dst: 262, alias: 'Truck 12', aliasFormat: 3, gps: { lat: 54.68719, lon: 25.27971 } }).idle(3);
	s1.voiceCall({ kind: 2, src: 2504105, dst: 0xffffff, svc: 0x40, alias: 'Base North', aliasFormat: 1 }).idle(4);
	const s2 = new SlotScript(2).idle(12).standardCsbk(0x04, 9990, 31337).idle(30).standardCsbk(0x38, 91, 3100).idle(4);
	return [s1, s2];
}

function messagesScript() {
	const s1 = new SlotScript(3).idle(4);
	s1.text('OnAir DMR test message #1', { dd: 3, dt: 7, src: 2145007, dst: 2145016 }).idle(2);
	s1.text('Café is open, 20% off today #2', { dd: 18, dt: 8, src: 2308155, dst: 2145016 }).idle(2);
	s1.text('Meeting at the main gate at 14:30 #3', { dd: 21, dt: 10, src: 2504105, dst: 3101234 }).idle(2);
	s1.packet(dmrLrrpEncode(-33.8688, 151.2093, 5, 6.1, 100), { dpf: 2, sap: 4, src: 115, dst: 64250 }).idle(2);
	s1.motoLrrp().idle(2);
	s1.text('$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6A', { dd: 3, src: 22001, dst: 100 }).idle(2);
	s1.packet(tmsPacket('Meet at gate 3'), { dpf: 2, sap: 4, src: 7001, dst: 7002 }).idle(2);
	s1.status(42, 2145007, 9).idle(4);
	const s2 = new SlotScript(4).idle(60);
	return [s1, s2];
}

function trunkingScript() {
	const s1 = new SlotScript(5)
		.idle(4)
		.xpt()
		.idle(2)
		.aloha(0, 5, 2)
		.idle(2)
		.grant(0x31, 12, 1, 2149, 2145007)
		.grant(0x30, 13, 0, 2145016, 2145007, true);
	s1.idle(2).capPlus(4, 0xa0, [5, 9]).idle(2).conPlusGrant().idle(4);
	const s2 = new SlotScript(6).idle(4).voiceCall({ src: 2145007, dst: 2149, superframes: 2, hang: 0 }).idle(4);
	return [s1, s2];
}

const CALL_EVENTS = [
	'Group call TG 2149 ← 2145007',
	'Talker alias "Test Station 1" (2145007)',
	'Private call 2145016 ← 2623266 (late entry) EMERGENCY',
	'Talker alias "Café Ops" (2623266)',
	'Group call TG 262 ← 250997',
	'Talker alias "Truck 12" (250997)',
	'250997: 54.68719, 25.27971 (GPS LC)',
	'All call ← 2504105 encrypted',
	'Talker alias "Base North" (2504105)',
];

const MESSAGE_EVENTS = [
	'short data, ISO 8859-1 2145007 → 2145016: OnAir DMR test message #1',
	'short data, UTF-8 2308155 → 2145016: Café is open, 20% off today #2',
	'short data, UTF-16LE 2504105 → 3101234: Meeting at the main gate at 14:30 #3',
	'115: -33.86880, 151.20930 (LRRP)',
	'204: 45.32213, 8.88696 (LRRP)',
	'22001: 48.11730, 11.51667 (NMEA)',
	'Text message (TMS) 7001 → 7002: Meet at gate 3',
	'Status 42: 2145007 → 9',
];

describe('DMR link layer through the DSD stream', () => {
	it('follows calls: header, late entry, talker alias in four formats, GPS info, emergency and privacy', async () => {
		const [s1, s2] = callsScript();
		const { statuses, dmr, events } = await run(dmrSignal(s1, s2, { cnrDb: 30 }));
		for (const e of CALL_EVENTS) expect(events).toContain(e);
		expect(events).toContain('unit to unit voice request (opcode 04): 9990 → 31337');
		expect(dmr.alias).toEqual({ text: 'Base North', slot: 0, src: 2504105 });
		expect(dmr.position).toMatchObject({ source: 'GPS LC', src: 250997, radiusM: 200 });
		expect(statuses.some((s) => s.dmrCall?.lateEntry && s.dmrCall.source === 2623266 && !s.dmrCall.group && s.dmrCall.emergency)).toBe(
			true,
		);
		expect(dmr.activity).toMatch(/^activity: slot 1 /);
		// the voice still goes through mbelib without errors
		const bars = statuses.map((s) => s.mbeErrors ?? '').join('');
		expect(bars.match(/=/g)?.length).toBeGreaterThan(200);
		expect(bars).not.toMatch(/[EX]/);
	});
	it('assembles text messages at rates 1/2, 3/4 and 1, LRRP, NMEA and TMS positions and texts', async () => {
		const [s1, s2] = messagesScript();
		const { dmr, events } = await run(dmrSignal(s1, s2, { cnrDb: 30 }));
		for (const e of MESSAGE_EVENTS) expect(events).toContain(e);
		expect(dmr.message).toMatchObject({ text: 'status 42', format: 'status / precoded' });
		expect(dmr.position).toMatchObject({ source: 'NMEA', src: 22001 });
		expect(events.filter((e) => e.includes('CRC wrong'))).toEqual([]);
	});
	it('reads Hytera XPT, Tier III, Capacity Plus and Connect Plus control blocks', async () => {
		const [s1, s2] = trunkingScript();
		const { statuses, dmr, events } = await run(dmrSignal(s1, s2, { cnrDb: 30 }));
		const systems = new Set(statuses.map((s) => s.dmr?.system && `${s.dmr.system.kind}: ${s.dmr.system.text}`).filter(Boolean));
		expect([...systems]).toEqual([
			'Hytera XPT: free LCN 5, 3 slots in use',
			'Tier III: Tiny network 6 site 3 (AB)',
			'Capacity Plus: rest channel 4',
			'Connect Plus: control channel',
		]);
		expect(events).toContain('TV_GRANT talkgroup voice: TG 2149 ← 2145007 on channel 12 slot 2');
		expect(events).toContain('PV_GRANT private voice: ID 2145016 ← 2145007 on channel 13 slot 1 EMERGENCY');
		expect(events).toContain('Capacity Plus: channel status: TG 5 on channel 1 slot 1, TG 9 on channel 3 slot 1');
		expect(events).toContain('Connect Plus: voice grant: TG 1216 ← 113114 on channel 2 slot 2');
		expect(events).toContain('Group call TG 2149 ← 2145007');
		expect(dmr.control.text).toMatch(/^Connect Plus/);
	});
	it.each([14, 10])('keeps the calls and messages at %i dB carrier to noise', async (cnrDb) => {
		const [c1, c2] = callsScript();
		const calls = await run(dmrSignal(c1, c2, { cnrDb, seed: cnrDb }));
		const [m1, m2] = messagesScript();
		const messages = await run(dmrSignal(m1, m2, { cnrDb, seed: cnrDb + 1 }));
		const found = [...CALL_EVENTS.filter((e) => calls.events.includes(e)), ...MESSAGE_EVENTS.filter((e) => messages.events.includes(e))];
		expect(found.length).toBeGreaterThanOrEqual(cnrDb >= 14 ? 17 : 14);
		// nothing made up: every event is one that was sent, a control block, or a message marked as damaged
		const sent = new Set([...CALL_EVENTS, ...MESSAGE_EVENTS]);
		const extra = [...calls.events, ...messages.events].filter(
			(e) => !sent.has(e) && !/opcode|Group call|Private call|All call|CRC wrong/.test(e),
		);
		expect(extra).toEqual([]);
	});
	it('gives nothing from noise', async () => {
		const { statuses } = await run(noiseIq(48000 * 4, 0.3, 7));
		expect(statuses.some((s) => s.dmr || s.dmrCall)).toBe(false);
	});
});
