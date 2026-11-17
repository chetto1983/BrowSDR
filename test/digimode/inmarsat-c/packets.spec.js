// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir tests/inmc/test_inmc_pkt.cpp and tests/inmc/test_inmc_egc.cpp,
// https://github.com/adswill/OnAir; see third_party/onair. Changes: vitest cases on the parser's slots (OnAir reads its
// telemetry report); the report-size limits of OnAir's message list are not ported.

import { describe, expect, it } from 'vitest';
import { FRAME_BYTES, packetCheckSet } from '@/worker/decoders/digimode/inmarsat-c/code';
import { areaNumberFromText, classifyEgc, romanNumeral } from '@/worker/decoders/digimode/inmarsat-c/egc';
import { FrameParser } from '@/worker/decoders/digimode/inmarsat-c/packets';
import { addressLength, ita2ToText, lesName, serviceKind, serviceName, textToIta2 } from '@/worker/decoders/digimode/inmarsat-c/tables';
import { buildBulletinBoard, buildEgc, buildSignalling, egcPackets, frameOf } from './fixtures';

const TEXT = 'NAVAREA IX 100/26\nSTRAIT OF HORMUZ. LIGHT UNLIT.\nCANCEL THIS MESSAGE 1 WEEK.';
const split = (service, msgId, text, chunk, priority = 1, presentation = 0) =>
	egcPackets({ service, msgId, text, chunk, priority, presentation }).map(buildEgc);
const find = (fp, id) => fp.slots.find((s) => s.msg.id === id)?.msg;
/** One frame: the bulletin board and the given packets. */
const frame = (fp, packets) => fp.parseFrame(frameOf([buildBulletinBoard(), ...packets]));

describe('Inmarsat-C packets', () => {
	it('reads the bulletin board, and drops a corrupt one', () => {
		const p = buildBulletinBoard({
			frameNo: 1000,
			sat: 3,
			les: 44,
			channelType: 1,
			signallingChannel: 5,
			count: 6,
			services: 0xe001,
			randomInterval: 9,
		});
		expect([p.length, p[0], p[2], p[3], p[7], p[6] >> 5]).toEqual([14, 0x7d, 0x03, 0xe8, (3 << 6) | 44, 1]);
		const fp = new FrameParser();
		const f = frameOf([p]);
		expect(fp.parseFrame(f)).toBe(true);
		expect(fp.ncs).toMatchObject({ valid: true, frameNo: 1000, sat: 3, lesId: 44, channelType: 1, lesName: 'NCS', channelTypeName: 'NCS' });
		expect(fp.ncs).toMatchObject({ signallingChannel: 5, count: 6, randomInterval: 9, services: 0xe001, frameTime: '2:24:00.0' });
		expect(fp.ncs.region).toContain('IOR');
		expect(fp.ncs.servicesText).toContain('SafetyNET');
		expect(fp.ncs.statusText).toContain('operational');
		expect(fp.packets).toEqual({ ok: 1, bad: 0 });
		f[5] ^= 0x10;
		const fp2 = new FrameParser();
		expect(fp2.parseFrame(f)).toBe(false);
		expect(fp2.ncs.valid).toBe(false);
		expect(fp2.packets.bad).toBe(1);
	});

	it('reads the signalling channel uplink', () => {
		const fp = new FrameParser();
		fp.parseFrame(frameOf([buildBulletinBoard(), buildSignalling(0xe0, 1626.5 + 0.0025 * 120, new Array(28).fill(0))]));
		expect(fp.ncs.signallingUplinkMhz).toBeCloseTo(1626.8, 6);
	});

	it('assembles an EGC message over two frames, and counts its repeat', () => {
		const pk = split(0x31, 4242, TEXT, 25);
		expect(pk).toHaveLength(4);
		const fp = new FrameParser();
		for (let pass = 0; pass < 2; pass++) {
			frame(fp, [pk[0], pk[1]]);
			const m = fp.slots[0].msg;
			if (pass === 0) expect([fp.slots.length, m.complete, m.packets]).toEqual([1, false, 2]);
			else expect([m.complete, m.text, m.seen]).toEqual([true, TEXT, 1]); // a repeat keeps the text until it is whole again
			frame(fp, [pk[2], pk[3]]);
			expect(fp.slots).toHaveLength(1);
			expect(fp.slots[0].msg).toMatchObject({
				complete: true,
				text: TEXT,
				id: 4242,
				serviceCode: 0x31,
				kind: 1,
				priority: 1,
				packets: 4,
				seen: pass + 1,
			});
			expect(fp.slots[0].msg).toMatchObject({ area: '11 11 11', addr0: 0x11, sat: 0, lesId: 17 });
			expect(fp.slots[0].msg.serviceText).toContain('NAVAREA');
			expect(fp.messageCount).toBe(1);
		}
		const gap = new FrameParser();
		gap.parseFrame(frameOf([pk[0], pk[2], pk[3]]));
		expect(gap.slots[0].msg.complete).toBe(false);
	});

	it('keeps priorities and FleetNET, and reads ITA2 with its shifts', () => {
		const fp = new FrameParser();
		fp.parseFrame(frameOf([0, 1, 2, 3].map((pr) => split(0x02, 10 + pr, 'HELLO', 48, pr)[0])));
		expect(fp.slots.map((s) => [s.msg.kind, s.msg.priority, s.msg.complete, s.msg.text])).toEqual(
			[0, 1, 2, 3].map((pr) => [2, pr, true, 'HELLO']),
		);
		const s = 'FLEET 14 PORT: DUBAI, ETA 0630.';
		expect(ita2ToText(textToIta2(s))).toBe(s);
		expect(ita2ToText([0x1f, 0x01, 0x03, 0x1b, 0x01, 0x13])).toBe('EA32');
	});

	it('assembles an EGC packet carried in multiframe packets of two frames', () => {
		const inner = split(0x31, 777, 'MULTIFRAME TEXT THAT IS CARRIED IN SEVERAL PACKETS', 60)[0];
		const cut = 20;
		const bd = Uint8Array.from([0xbd, cut + 2, ...inner.subarray(0, cut), 0, 0]);
		packetCheckSet(bd, bd.length);
		const rest = inner.subarray(cut, inner.length - 2);
		const be = Uint8Array.from([0xbe, rest.length + 2, ...rest, 0, 0]);
		packetCheckSet(be, be.length);
		const fp = new FrameParser();
		fp.parseFrame(frameOf([bd]));
		fp.parseFrame(frameOf([be]));
		expect(fp.slots).toHaveLength(1);
		expect(fp.slots[0].msg).toMatchObject({ id: 777, complete: true });
	});

	it('keeps the newest 150 messages', () => {
		const fp = new FrameParser();
		for (let i = 0; i < 200; i++)
			fp.parseFrame(frameOf([buildEgc({ ...egcPackets({ service: 0x31, msgId: 2000 + i, text: 'X'.repeat(60) })[0] })]));
		expect([fp.slots.length, fp.messageCount]).toEqual([150, 200]);
		expect(fp.slots.at(-1).msg.id).toBe(2199);
		expect(Math.min(...fp.slots.map((s) => s.msg.id))).toBe(2050);
	});

	it('has the service, address and station tables', () => {
		expect(serviceName(0x31)).toContain('NAVAREA');
		expect([serviceKind(0x31), serviceKind(0x02), serviceKind(0x00)]).toEqual([1, 2, 0]);
		expect([addressLength(0x04), addressLength(0x31), addressLength(0x02), addressLength(0x7f)]).toEqual([7, 4, 5, 3]);
		expect([lesName(3, 44), lesName(0, 1), lesName(1, 63)]).toEqual(['NCS', 'Vizada-Telenor, USA', '']);
		expect(FRAME_BYTES).toBe(640);
	});
});

describe('Inmarsat-C maritime messages', () => {
	it('reads the area, the warning number and the kind from the text', () => {
		expect(['IV', 'xxi', '9', '22', 'XXII', '', 'ABC'].map(areaNumberFromText)).toEqual([4, 21, 9, 0, 0, 0, 0]);
		for (let n = 1; n <= 21; n++) expect(areaNumberFromText(romanNumeral(n))).toBe(n);
		expect(classifyEgc(0x31, 1, 'NAVAREA IV 123/26\nWESTERN NORTH ATLANTIC.\nBUOY ADRIFT.')).toEqual({
			area: 'NAVAREA IV',
			areaNumber: 4,
			ident: '123/26',
			subject: 'Navigational warning',
		});
		expect(classifyEgc(0x31, 1, 'METAREA 9 FORECAST ISSUED 0600 UTC\nSTRAIT OF HORMUZ NW 15 KT')).toMatchObject({
			area: 'METAREA 9',
			subject: 'Weather forecast',
		});
		expect(classifyEgc(0x31, 1, 'navarea xii 5/26 hurricane warning')).toMatchObject({
			area: 'NAVAREA XII',
			ident: '5/26',
			subject: 'Weather warning',
		});
		expect(classifyEgc(0x14, 3, 'MAYDAY RELAY MV EXAMPLE 12N 045E ABANDONING SHIP')).toMatchObject({ subject: 'Distress relay', area: '' });
		expect(classifyEgc(0x44, 2, 'SAR OPERATION IN PROGRESS KEEP A LOOKOUT').subject).toBe('Search and rescue');
		expect(classifyEgc(0x02, 0, 'FLEET 14 ETA 0630')).toMatchObject({ subject: 'FleetNET message', ident: '' });
		expect(classifyEgc(0x00, 0, 'SYSTEM').subject).toBe('');
		expect(classifyEgc(0x31, 1, 'NAVAREAS ARE LISTED. XIV NAVAREA 99 SOMETHING').area).toBe('');
		expect(classifyEgc(0x31, 1, 'ISSUE 12345/26 AND NAVAREA I\n1/26 LATER')).toMatchObject({ area: 'NAVAREA I', ident: '1/26' });
	});

	it('assembles packets out of order and ignores a repeated packet', () => {
		const pk = split(0x31, 5001, TEXT, 25);
		const fp = new FrameParser();
		frame(fp, [pk[3], pk[1]]);
		expect(find(fp, 5001).complete).toBe(false);
		frame(fp, [pk[0], pk[2]]);
		expect(find(fp, 5001)).toMatchObject({
			complete: true,
			text: TEXT,
			navarea: 'NAVAREA IX',
			ident: '100/26',
			subject: 'Navigational warning',
			priority: 1,
		});
		expect(fp.messageCount).toBe(1);
		frame(fp, [pk[0], pk[0]]);
		expect([find(fp, 5001).text, fp.slots.length]).toEqual([TEXT, 1]);
	});

	it('heals a lost packet with the next broadcast, and drops a corrupt one', () => {
		const pk = split(0x31, 5002, TEXT, 25, 2);
		const fp = new FrameParser();
		frame(fp, [pk[0], pk[2], pk[3]]);
		expect(find(fp, 5002)).toMatchObject({ complete: false, priority: 2, packets: 3 });
		frame(fp, [pk[1]]);
		expect(find(fp, 5002)).toMatchObject({ complete: true, text: TEXT });
		const bad = split(0x31, 5003, TEXT, 25);
		const broken = bad[1].slice();
		broken[12] ^= 0x20;
		const fq = new FrameParser();
		frame(fq, [bad[0], broken, bad[2], bad[3]]);
		expect(find(fq, 5003).complete).toBe(false);
		expect(fq.packets.bad).toBeGreaterThanOrEqual(1);
		frame(fq, [bad[1]]);
		expect(find(fq, 5003)).toMatchObject({ complete: true, text: TEXT });
	});

	it('starts afresh when another message takes the number', () => {
		const a = split(0x31, 5004, TEXT, 25);
		const other = 'NAVAREA XI 7/26 TYPHOON WARNING';
		const fp = new FrameParser();
		frame(fp, [a[0], a[1]]);
		frame(fp, [split(0x31, 5004, other, 60)[0]]);
		expect(find(fp, 5004)).toMatchObject({ complete: true, text: other, navarea: 'NAVAREA XI', subject: 'Weather warning' });
	});

	it('reads a distress relay and an ITA2 FleetNET message', () => {
		const fp = new FrameParser();
		frame(fp, [split(0x14, 5005, 'MAYDAY RELAY FISHING VESSEL SINKING 1230N 04500E', 100, 3)[0]]);
		expect(find(fp, 5005)).toMatchObject({ priority: 3, subject: 'Distress relay', kind: 1, complete: true });
		frame(fp, [split(0x02, 5006, 'FLEET 14 PORT: DUBAI, ETA 0630.', 100, 0, 6)[0]]);
		expect(find(fp, 5006)).toMatchObject({ text: 'FLEET 14 PORT: DUBAI, ETA 0630.', kind: 2, subject: 'FleetNET message' });
	});
});
