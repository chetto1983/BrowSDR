// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR from OnAir tests/dmr/test_dmr_lrrp.cpp, tests/dmr/test_dmr_nmea.cpp,
// tests/dmr/test_dmr_vendor.cpp, tests/dmr/test_dmr_xpt.cpp (the parser part) and rust/onair_dmr/src/tests.rs
// (text_formats, utf16_le_sent_under_a_be_label_is_read_as_le), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the random fuzz loops are shorter; added: talker alias in all four formats, the GPS info LC, the Tier III
// grant and Aloha layouts (TS 102 361-4 as DSD-FME reads it) and the message CRC conventions of finishMessage.
import { describe, expect, it } from 'vitest';
import { dmrIpv4HeaderOk, parseDmrLrrp, parseDmrLrrpCompressed, parseDmrNmea } from '@/worker/decoders/dsd/dmr/position';
import { CapPlus, conPlusParse, ipService } from '@/worker/decoders/dsd/dmr/vendor';
import {
	XPT_ADJACENT_OP,
	XPT_FID,
	xptCallLc,
	xptParseCall,
	xptParseCsbk,
	xptSiteStatusCsbk,
	xptState,
} from '@/worker/decoders/dsd/dmr/xpt';
import { TalkerAlias, textFromBytes } from '@/worker/decoders/dsd/dmr/text';
import { gpsInfoParse, parseFullLc } from '@/worker/decoders/dsd/dmr/lc';
import { shortLcText, tier3Grant, tier3SystemCode, tier3Text } from '@/worker/decoders/dsd/dmr/control';
import { finishMessage } from '@/worker/decoders/dsd/dmr/message';
import { crc32Msg } from '@/worker/decoders/dsd/dmr/codes';
import * as D from '@/worker/decoders/dsd/dmr/data';
import { dmrLrrpEncode, dmrLrrpEncodeNoFix, gpsInfoLc, talkerAliasPdus, tmsPacket } from './fixtures.js';

const hex = (s) => Uint8Array.from({ length: s.length >> 1 }, (_, i) => parseInt(s.slice(2 * i, 2 * i + 2), 16));
const csbk = (opcode, fid, data, lb = true, pf = false) => ({ lb, pf, opcode, fid, data: Uint8Array.from(data) });

describe('LRRP over IP (real packets of a 2026-10-23 capture, 161.600 MHz)', () => {
	it('reads a fix with speed and heading as DSDPlus did', () => {
		const loc = parseDmrLrrp(hex('45000033DE660000401187A20C0000B70D00FAFA0FA10FA1001FEB370D152203000001514BE3B6DC3B811656602D6C00485647'));
		expect(loc.hasFix).toBe(true);
		expect(loc.lat).toBeCloseTo(53.35981, 4);
		expect(loc.lon).toBeCloseTo(83.67785, 4);
		expect(loc.speedMs).toBeCloseTo(0.5625, 3);
		expect(loc.headingDeg).toBeCloseTo(142, 0);
		const moving = parseDmrLrrp(
			hex('45000033441C0000401122310C0000730D00FAFA0FA10FA1001F376F0D152203000001514BE79AC13B829044025C6C06115632'),
		);
		expect(moving.lat).toBeCloseTo(53.3705, 4);
		expect(moving.lon).toBeCloseTo(83.68596, 4);
		expect(moving.speedMs).toBeCloseTo(6.1328, 3);
		expect(moving.headingDeg).toBe(100);
	});
	it('checks the IPv4 header checksum and reads NoFix, rejecting empty and foreign data', () => {
		const d = hex('45000033DE660000401187A20C0000B70D00FAFA0FA10FA1001FEB370D152203000001514BE3B6DC3B811656602D6C00485647');
		expect(dmrIpv4HeaderOk(d)).toBe(true);
		d[15] ^= 0x04;
		expect(dmrIpv4HeaderOk(d)).toBe(false);
		expect(parseDmrLrrp(hex('450000251EBD00004011477A0C0000970D00FAFA0FA10FA100118BB70D0722030000013710'))).toMatchObject({
			hasFix: false,
			resultCode: 16,
		});
		expect(parseDmrLrrp(hex('4500001E00000000401100000C0000970D00FAFA0FA10FA1000A00000D00'))).toBeNull();
		expect(parseDmrLrrp(new Uint8Array(60))).toBeNull();
		expect(parseDmrLrrp(new Uint8Array(4))).toBeNull();
	});
	it('reads the Motorola report behind a compressed header (OnAir #335) and nothing else', () => {
		const d = hex('02011171CC0D1A22' + '04000000' + '01341FAAC4B20251' + '407548BA0651D260015B6C0009');
		const loc = parseDmrLrrpCompressed(d);
		expect(loc.lat).toBeCloseTo(45.32213, 4);
		expect(loc.lon).toBeCloseTo(8.88696, 4);
		expect(loc.speedMs * 3.6).toBeCloseTo(0.25, 1);
		expect(parseDmrLrrpCompressed(d.subarray(0, d.length - 1))).toBeNull();
		expect(parseDmrLrrpCompressed(new Uint8Array(33))).toBeNull();
		const junk = d.slice();
		junk[30] = 0x7e;
		expect(parseDmrLrrpCompressed(junk)).toBeNull();
	});
	it('reads back what the generator encodes', () => {
		expect(parseDmrLrrp(Uint8Array.from(dmrLrrpEncode(-33.8688, 151.2093, 5, 3, 90)))).toMatchObject({
			hasFix: true,
			radiusM: 5,
			speedMs: 3,
			headingDeg: 90,
		});
		expect(parseDmrLrrp(Uint8Array.from(dmrLrrpEncode(-33.8688, 151.2093, 5))).lon).toBeCloseTo(151.2093, 5);
		expect(parseDmrLrrp(Uint8Array.from(dmrLrrpEncodeNoFix()))).toMatchObject({ hasFix: false, resultCode: 16 });
	});
});

describe('NMEA in short data', () => {
	it('reads the logged RMC sentence and the Trimble examples', () => {
		const log = parseDmrNmea('DMR TEXT: "$GNRMC,093919.000,A,5315.93271,N,08332.15710,E,0.00,93.55,241026,,,A*46"');
		expect(log.lat).toBeCloseTo(53.2655452, 5);
		expect(log.lon).toBeCloseTo(83.5359517, 5);
		expect([log.speedMs, log.headingDeg]).toEqual([0, 93.55]);
		const rmc = parseDmrNmea('$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W');
		expect([rmc.lat, rmc.lon, rmc.speedMs].map((v) => +v.toFixed(4))).toEqual([48.1173, 11.5167, 11.5235]);
		const gga = parseDmrNmea('$GPGGA,172814.0,3723.46587704,N,12202.26957864,W,2,6,1.2,18.893,M,-25.669,M,2.0,0031');
		expect(gga.lat).toBeCloseTo(37.3910979, 5);
		expect(gga.lon).toBeCloseTo(-122.0378263, 5);
		expect(gga.speedMs).toBeUndefined();
		expect(
			parseDmrNmea('$GPGSA,A,3,04,05,,09,12,,,24,,,,,2.5,1.3,2.1*39 $GPRMC,123519,A,4807.038,N,01131.000,E,0,0,230394,,').lat,
		).toBeCloseTo(48.1173, 4);
	});
	it('rejects void, no-fix, bad checksum and malformed sentences', () => {
		const bad = [
			'$GPRMC,123519,V,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W',
			'$GPGGA,172814.0,3723.46587704,N,12202.26957864,W,0,6,1.2,18.893,M,-25.669,M,2.0,0031',
			'$GNRMC,093919.000,A,5315.93271,N,08332.15710,E,0.00,93.55,241026,,,A*00',
			'$GPRMC,123519,A,4807.038,N,01131.000,E,0,0,230394,,*',
			'$GPRMC,123519,A,4807.038,N,01131.000,E,0,0,230394,,*4',
			'$GPRMC,123519,A,4807.038,N,01131.000,E,0,0,230394,,*ZZ',
			'no position here',
			'$GPRMC,123519,A,0000.000,N,00000.000,E,0,0,230394,,',
			'$GPRMC,123519,A,9500.000,N,01131.000,E,0,0,230394,,',
			'$GPRMC,123519,A,5365.000,N,01131.000,E,0,0,230394,,',
			'$GPRMC,123519,A,4807.038,N,01199.000,E,0,0,230394,,',
			'$GPRMC,123519,A,nan,N,01131.000,E,0,0,230394,,',
			'$GPRMC,123519,A,5315.93X,N,01131.000,E,0,0,230394,,',
			'$GPRMC,123519,A,4807.038,,01131.000,,0,0,230394,,',
		];
		for (const s of bad) expect(parseDmrNmea(s)).toBeNull();
	});
});

describe('Capacity Plus, Connect Plus and Motorola IP services', () => {
	it('reads DSD-FME’s Connect Plus grant sample and the data grant', () => {
		expect(conPlusParse(0x03, Uint8Array.of(0x01, 0xb9, 0xda, 0x00, 0x04, 0xc0, 0x28, 0x02))).toMatchObject({
			src: 113114,
			dst: 1216,
			lcn: 2,
			slot: 1,
		});
		expect(conPlusParse(0x06, Uint8Array.of(0, 0, 0x63, 0x30, 0, 0, 0, 0))).toMatchObject({ dst: 99, lcn: 3, slot: 0 });
		expect(conPlusParse(0x02, new Uint8Array(8))).toBeNull();
	});
	it('accumulates Capacity Plus channel status blocks', () => {
		const block = (fl, ts, rest, bytes) => Uint8Array.from([(fl << 6) | (ts << 5) | rest, ...bytes, 0, 0, 0, 0, 0, 0, 0].slice(0, 8));
		const cp = new CapPlus();
		expect(cp.feed(block(3, 0, 4, [0xa0, 5, 9]))).toEqual({
			rest: 4,
			grants: [
				{ lsn: 1, tg: 5 },
				{ lsn: 3, tg: 9 },
			],
		});
		expect(cp.feed(block(3, 1, 2, [0]))).toEqual({ rest: 2, grants: [] });
		expect(cp.feed(block(2, 0, 1, [0xf0, 11, 12, 13, 14]))).toBeNull();
		expect(cp.feed(block(1, 0, 1, [])).grants.at(-1)).toEqual({ lsn: 4, tg: 14 });
		expect(cp.feed(block(3, 0, 1, [0x80, 7, 0x80, 21])).grants).toEqual([
			{ lsn: 1, tg: 7 },
			{ lsn: 9, tg: 21 },
		]);
		let x = 1;
		for (let i = 0; i < 20000; i++) {
			const d = Uint8Array.from({ length: 8 }, () => ((x = (x * 1103515245 + 12345) >>> 0), x >>> 24));
			expect((cp.feed(d)?.grants.length ?? 0) <= 16).toBe(true);
		}
	});
	it('reads ARS and TMS datagrams', () => {
		const ip = (sp, dp, body) =>
			Uint8Array.from([
				0x45,
				0,
				0,
				0,
				0,
				0,
				0,
				0,
				64,
				17,
				0,
				0,
				1,
				2,
				3,
				4,
				5,
				6,
				7,
				8,
				sp >> 8,
				sp & 0xff,
				dp >> 8,
				dp & 0xff,
				0,
				0,
				0,
				0,
				...body,
			]);
		expect(
			ipService(
				ip(
					4005,
					4005,
					[...'RADIO12'].map((c) => c.charCodeAt(0)),
				),
			),
		).toMatchObject({ port: 4005, text: 'RADIO12' });
		expect(ipService(ip(4007, 4007, [0x00, 0x08, 0xa0, 0x00, 0x00, 0x48, 0x00, 0x49]))).toMatchObject({
			port: 4007,
			ack: false,
			text: 'HI',
		});
		expect(ipService(ip(4007, 4007, [0x00, 0x02, 0xa1, 0x00]))).toMatchObject({ ack: true });
		expect(ipService(ip(4001, 4001, [1, 2, 3]))).toBeNull();
		expect(ipService(ip(4005, 4005, [1]).subarray(0, 10))).toBeNull();
		expect(ipService(Uint8Array.from(tmsPacket('Meet at gate 3')))?.text).toBe('Meet at gate 3');
	});
});

describe('Hytera XPT blocks', () => {
	it('reads the site status, adjacent sites and the call set-up', () => {
		const st = [3, 0, 2, 0, 1, 3];
		const tg = [21, 0, 77, 0, 9, 35];
		const x = xptState();
		expect(xptParseCsbk(xptSiteStatusCsbk(1, 6, st, tg), 2, x)).toBe(true);
		expect(x.freeLcn).toBe(6);
		st.forEach((s, i) => expect(x.lsn[6 + i]).toMatchObject({ status: s, tg: tg[i] }));
		expect(x.lsn[0].status).toBe(-1);
		const y = xptState();
		expect(xptParseCsbk(csbk(XPT_ADJACENT_OP, XPT_FID, [0x18, 0x70, 0x28, 0x20, 0, 0, 0, 0]), 1, y)).toBe(true);
		expect(y.adjacent.map((a) => [a.site, a.freeLcn])).toEqual([
			[3, 7],
			[5, 2],
		]);
		expect(xptParseCsbk(csbk(0x3d, XPT_FID, new Uint8Array(8)), 0, y)).toBe(false);
		expect(xptParseCsbk(csbk(0x0a, 0, new Uint8Array(8)), 0, y)).toBe(false);
		const z = xptState();
		expect(xptParseCall(parseFullLc(xptCallLc(3, 5, 2, 0x1234, 0x005678)), 3, z)).toBe(true);
		expect(z.calls[0]).toMatchObject({ lcn: 3, freeLcn: 5, handshake: 2, target: 0x1234, source: 0x5678 });
	});
});

describe('DMR text, talker alias and GPS info', () => {
	it('converts the short data formats', () => {
		expect(textFromBytes(Uint8Array.from([...'Hello'].map((c) => c.charCodeAt(0))), 3)).toBe('Hello');
		expect(textFromBytes(Uint8Array.of(0x00, 0x48, 0x00, 0x69), 3, true)).toBe('Hi');
		expect(textFromBytes(Uint8Array.of(0x43, 0x61, 0x66, 0xe9), 3)).toBe('Café');
		expect(textFromBytes(new TextEncoder().encode('Café ✓'), 18)).toBe('Café ✓');
		expect(textFromBytes(Uint8Array.of(0x12, 0x34), 1)).toBe('1234');
		expect(textFromBytes(Uint8Array.of(1, 2, 0xff), 0)).toBe('[01 02 FF]');
		expect(textFromBytes(Uint8Array.of(0, 0, 0, 0x41, 0, 1, 0xf6, 0x00), 23)).toBe('A😀');
		// OnAir #300: import radios send little-endian text under the big-endian format code
		for (const fmt of [20, 19]) {
			expect(textFromBytes(Uint8Array.of(0x48, 0, 0x69, 0, 0x21, 0), fmt)).toBe('Hi!');
			expect(textFromBytes(Uint8Array.of(0, 0x48, 0, 0x69), fmt)).toBe('Hi');
		}
	});
	it('assembles a talker alias in each of the four formats', () => {
		const cases = [
			['Test Station 1', 0],
			['Base North', 1],
			['Café Ops', 2],
			['Truck 12', 3],
			['Radio 2623266', 1],
		];
		for (const [alias, format] of cases) {
			const ta = new TalkerAlias();
			const pdus = talkerAliasPdus(alias, format);
			// the blocks may come in any order after the header; a new header starts again
			ta.add(parseFullLc(talkerAliasPdus('Ops Desk', 1)[1]));
			ta.add(parseFullLc(pdus[0]));
			for (const lc of pdus.slice(1).reverse()) ta.add(parseFullLc(lc));
			expect(ta.complete()).toBe(true);
			expect(ta.text()).toBe(alias);
		}
		const ta = new TalkerAlias();
		ta.add(parseFullLc(talkerAliasPdus('Test Station 1', 1)[0]));
		expect(ta.complete()).toBe(false);
		// Motorola's opcodes (FID 0x10, FLCO 0x14..0x17) are the standard ones
		const moto = talkerAliasPdus('Dispatch', 1).map((lc) => Uint8Array.from([lc[0] + 0x10, 0x10, ...lc.subarray(2)]));
		const tm = new TalkerAlias();
		moto.forEach((lc) => tm.add(parseFullLc(lc)));
		expect(tm.text()).toBe('Dispatch');
	});
	it('reads the GPS info LC', () => {
		const loc = gpsInfoParse(parseFullLc(gpsInfoLc(-33.8688, -70.6693, 1)));
		expect(loc.lat).toBeCloseTo(-33.8688, 4);
		expect(loc.lon).toBeCloseTo(-70.6693, 4);
		expect(loc.errorM).toBe(20);
		const prot = gpsInfoLc(10, 10);
		prot[0] |= 0x80;
		expect(gpsInfoParse(parseFullLc(prot))).toBeNull();
		expect(gpsInfoParse(parseFullLc(new Uint8Array(9)))).toBeNull();
	});
});

describe('Tier III control blocks and the CACH short LC', () => {
	it('reads grants and the Aloha system code', () => {
		const grant = tier3Grant(csbk(0x31, 0, [0xab, 0xc8 | 2, 0, 0x08, 0x65, 0x20, 0xba, 0xef]));
		expect(grant).toMatchObject({ channel: 0xabc, slot: 1, emergency: true, tg: 2149, src: 2145007, group: true, data: false });
		expect(tier3Grant(csbk(0x30, 0, new Uint8Array(8)))).toMatchObject({ group: false, data: false });
		expect(tier3Grant(csbk(0x34, 0, new Uint8Array(8)))).toMatchObject({ group: true, data: true });
		expect(tier3Grant(csbk(0x31, 0x10, new Uint8Array(8)))).toBeNull();
		const d = new Uint8Array(8);
		const code = (1 << 12) | (100 << 5) | 17;
		d[3] = code >> 6;
		d[4] = ((code & 0x3f) << 2) | 1;
		expect(tier3SystemCode(csbk(0x19, 0, d))).toEqual({ model: 'Small', net: 101, site: 18, par: 'A', code });
		expect(tier3Text(csbk(0x28, 0, [6 << 3, 0, 0, 0, 0, 0, 0, 0]))).toBe('C_BCAST: adjacent site');
		expect(tier3Text(csbk(0x3d, 0, new Uint8Array(8)))).toBe('');
	});
	it('names the short LC messages', () => {
		expect(shortLcText(0)).toBe('null');
		expect(shortLcText((1 << 24) | (8 << 20) | (2 << 16))).toBe('activity: slot 1 group voice, slot 2 group CSBK');
		expect(shortLcText(3 << 24)).toBe('short LC opcode 3');
	});
});

describe('finishing a data message', () => {
	const assembled = (bytes, hdr) => ({
		active: false,
		hdr: { ...D.emptyDataHeader(), ...hdr },
		dt: 7,
		bytes,
		got: 1,
		confirmed: false,
		crcAllOk: true,
		prop: null,
	});
	const withCrc = (data, crc32 = crc32Msg) => {
		const c = crc32(data);
		return [...data, c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff, c >>> 24];
	};
	it('reads short data, an LRRP packet and rejects a wrong CRC', () => {
		const text = [...'Battery low'].map((c) => c.charCodeAt(0));
		const short = finishMessage(assembled(withCrc([...text, 0, 0]), { dpf: D.DPF_SHORT_DEFINED, dd: 3, pad: 16 }));
		expect(short).toMatchObject({ format: 'short data, ISO 8859-1', text: 'Battery low', crcOk: true, location: null });
		const lrrp = finishMessage(assembled(withCrc(dmrLrrpEncode(54.68, 25.28, 3)), { dpf: D.DPF_UNCONFIRMED, sap: 4 }));
		expect(lrrp).toMatchObject({ format: 'LRRP GPS', crcOk: true, source: 'LRRP' });
		const broken = withCrc(text);
		broken[0] ^= 1;
		expect(finishMessage(assembled(broken, { dpf: D.DPF_SHORT_DEFINED, dd: 3 })).crcOk).toBe(false);
	});
	it('takes a position report whose CRC follows another convention (OnAir #335)', () => {
		const pkt = dmrLrrpEncode(45.3, 8.9, 2);
		const swapped = withCrc(pkt, (d) => ~crc32Msg(d) >>> 0);
		expect(finishMessage(assembled(swapped, { dpf: D.DPF_UNCONFIRMED, sap: 4 }))).toMatchObject({ crcOk: true, source: 'LRRP' });
	});
});
