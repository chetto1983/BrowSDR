// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir tests/aero/test_aero_su_layers.cpp (SU CRC, block sizes, ISU / SSU
// assembly, ACARS reassembly, log-ons, system tables), tests/aero/test_aero_acars_real.cpp (the real block of JAERO's
// ParserISU comment), tests/aero/test_aero_adsc.cpp (libacars' ADS-C examples, builders, text positions from the
// airframes decoder tests) and tests/aero/test_aero_cpdlc.cpp (libacars' real CPDLC messages),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: vitest cases; the CPDLC tests check the envelope and
// its CRC only (the ASN.1 body is not decoded here); ACARS text is BrowSDR's reading of the block.

import { describe, expect, it } from 'vitest';
import { aeroAdscTagName, aeroDecodeAdsc } from '@/worker/decoders/digimode/aero/adsc';
import { aeroArincCrc, aeroDecodeCpdlc, aeroDescribeCpdlc } from '@/worker/decoders/digimode/aero/arinc';
import { aeroAcarsLabelText, aeroParseAcarsBlock, AeroSuDecoder } from '@/worker/decoders/digimode/aero/isu';
import { aeroCrc16 } from '@/worker/decoders/digimode/aero/phy';
import { aeroParseTextPosition, aeroPositionFromMessage } from '@/worker/decoders/digimode/aero/pos';
import { aeroBlockBytes, aeroDescribeSu, aeroParseSystemSu, aeroSplitSus, aeroSusPerBlock } from '@/worker/decoders/digimode/aero/su';
import { acarsCrc } from '@/worker/decoders/digimode/vdl2/acars';
import { xorshift } from '../inmarsat-c/fixtures';
import {
	adscBasicGroup,
	adscEarthRefGroup,
	adscFlightIdGroup,
	adscMeteoGroup,
	adscPredictedRouteGroup,
	aeroAcarsToSus,
	aeroBuildAcarsBlock,
	aeroBuildAdscText,
	aeroBuildBlock,
	aeroChannelControlSu,
	aeroFillSu,
	aeroLogonSu,
	aeroSatelliteIdSu,
	aeroSystemTableSu,
	makeSu,
} from './fixtures';

const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const REAL =
	'FF FF 01 32 AE C8 C2 AD 4A C8 CD 15 C1 B6 51 02 2F D0 49 CB 43 D0 D9 C1 AE C1 C4 D3 AE C8 C2 AD 4A C8 CD B0 37 B0 34 B0 C2 B0 B0 B0 43 B0 B0 B0 C4 B0 31 B0 45 B0 31 31 B0 B0 B0 34 34 B0 C4 83 93 AB 7F';
const real = () => Uint8Array.from(REAL.split(' '), (h) => parseInt(h, 16));
const realMsg = () => ({
	aesId: 0x4b1a2c,
	gesId: 0x12,
	uplink: true,
	mode: '2',
	registration: 'HB-JHM',
	label: 'A6',
	blockId: 'Q',
	text: '/PIKCPYA.ADS.HB-JHM07040B000C000D010E011000440D',
});

/** SUs through blocks of the rate (fill-in pads the last), into the decoder. */
function runRate(rate, sus, dec, t0 = 0) {
	const acars = [],
		logons = [];
	let t = t0;
	for (let i = 0; i < sus.length; i += aeroSusPerBlock(rate)) {
		const blk = aeroBuildBlock(sus.slice(i, i + aeroSusPerBlock(rate)), rate);
		for (const s of aeroSplitSus(blk, rate)) {
			const out = dec.feed(s, t);
			acars.push(...out.acars);
			logons.push(...out.logons);
		}
		t += 0.5;
	}
	return { acars, logons };
}

describe('Aero ACARS blocks', () => {
	it('reads the real block of JAERO’s comment and rebuilds it byte for byte', () => {
		expect(acarsCrc(ascii('123456789'))).toBe(0x2189);
		const b = aeroParseAcarsBlock(real());
		expect(b).toMatchObject({
			parityOk: true,
			crcOk: true,
			mode: '2',
			registration: 'HB-JHM',
			tak: 0x15,
			label: 'A6',
			blockId: 0x51,
			hasText: true,
			moreToCome: false,
		});
		expect(b.text).toBe('/PIKCPYA.ADS.HB-JHM07040B000C000D010E011000440D');
		expect(aeroAcarsLabelText('A6')).toBe('ADS-C uplink');
		expect([...aeroBuildAcarsBlock({ ...b, blockId: 0x51 })]).toEqual([...real()]);
		const flip = (i, x) => {
			const v = real();
			v[i] ^= x;
			return aeroParseAcarsBlock(v);
		};
		expect(flip(30, 0x01)).toMatchObject({ parityOk: false, crcOk: false });
		expect(flip(64, 0x10)).toMatchObject({ parityOk: true, crcOk: false });
		expect(flip(0, 0xff)).toBeUndefined();
		expect(aeroParseAcarsBlock(real().subarray(0, 10))).toBeUndefined();
	});

	it('handles a block without text, the DEL of label _d, and an ETB block of 220 characters', () => {
		const g = aeroBuildAcarsBlock({ registration: 'A6-EEB', label: '_d', blockId: 0x41 });
		expect(g.length).toBe(19);
		expect(g[13] & 0x7f).toBe(0x7f);
		expect(aeroParseAcarsBlock(g)).toMatchObject({ label: '_d', crcOk: true, parityOk: true, hasText: false });
		const m = aeroParseAcarsBlock(
			aeroBuildAcarsBlock({ registration: 'N123AB', label: 'H1', blockId: 0x42, moreToCome: true, text: 'x'.repeat(220) }),
		);
		expect(m).toMatchObject({ moreToCome: true, crcOk: true });
		expect(m.text.length).toBe(220);
	});
});

describe('Aero SU layer', () => {
	it('checks SUs and knows the block sizes', () => {
		expect(aeroCrc16(ascii('123456789'))).toBe(0x906e);
		expect([600, 1200, 10500, 5].map(aeroBlockBytes)).toEqual([24, 36, 312, 0]);
		expect([600, 1200, 10500].map(aeroSusPerBlock)).toEqual([2, 3, 26]);
		expect(aeroFillSu()).toMatchObject({ crcOk: true, type: 1 });
		expect(aeroSplitSus(new Uint8Array(12), 600)[0]).toMatchObject({ crcOk: true, type: 0 });
		expect(aeroSplitSus(new Uint8Array(5), 600)).toEqual([]);
		expect(aeroSplitSus(new Uint8Array(24), 77)).toEqual([]);
	});

	it('hands on log-ons and log-offs', () => {
		const l = aeroLogonSu(0x4b1a2c, 0x12, true);
		expect(l).toMatchObject({ type: 0x11, aesId: 0x4b1a2c, gesId: 0x12 });
		const { acars, logons } = runRate(600, [l, aeroLogonSu(0x4b1a2c, 0x12, false), aeroFillSu()], new AeroSuDecoder());
		expect(logons).toEqual([
			{ aesId: 0x4b1a2c, gesId: 0x12, logon: true },
			{ aesId: 0x4b1a2c, gesId: 0x12, logon: false },
		]);
		expect(acars).toEqual([]);
	});

	it('assembles the real message from its ISU and SSUs at every rate', () => {
		for (const rate of [600, 1200, 10500]) {
			const m = realMsg();
			const sus = aeroAcarsToSus(m);
			expect(sus.length).toBe(10);
			expect([sus[0].type, sus[0].bytes[6], sus[0].bytes[7] >> 4, sus[1].type, sus[9].type]).toEqual([0x71, 9, 1, 0xc8, 0xc0]);
			const { acars, logons } = runRate(
				rate,
				[aeroSystemTableSu(0x12, 0), aeroLogonSu(m.aesId, m.gesId, true), ...sus, aeroFillSu()],
				new AeroSuDecoder(),
			);
			expect(logons.length).toBe(1);
			expect(acars).toHaveLength(1);
			expect(acars[0]).toMatchObject({
				aesId: m.aesId,
				gesId: m.gesId,
				uplink: true,
				registration: 'HB-JHM',
				label: 'A6',
				blockId: 'Q',
				mode: '2',
				text: m.text,
				crcOk: true,
				labelText: 'ADS-C uplink',
			});
		}
	});

	it('keeps interleaved ISUs apart and joins a message of two blocks', () => {
		const a1 = realMsg();
		const a2 = {
			aesId: 0x710123,
			gesId: 0x12,
			uplink: true,
			registration: 'A6-EEB',
			label: 'H1',
			text: 'METAR OMDB 071200Z 31008KT 9999 FEW040 36/18 Q1004 NOSIG',
		};
		const a3 = {
			aesId: 0x710124,
			gesId: 0x12,
			uplink: true,
			registration: 'VT-ANA',
			label: '5Z',
			text: Array.from({ length: 40 }, (_, i) => `ATIS INFORMATION ${i} `).join(''),
		};
		expect(a3.text.length).toBeGreaterThan(220);
		const s1 = aeroAcarsToSus(a1, 1, 3),
			s2 = aeroAcarsToSus(a2, 2, 5);
		const mix = [];
		for (let i = 0; i < Math.max(s1.length, s2.length); i++) mix.push(...[s1[i], s2[i]].filter(Boolean));
		const { acars } = runRate(10500, [...mix, ...aeroAcarsToSus(a3, 0, 9)], new AeroSuDecoder());
		expect(acars).toHaveLength(3);
		expect(acars.find((r) => r.registration === 'HB-JHM').text).toBe(a1.text);
		expect(acars.find((r) => r.registration === 'A6-EEB')).toMatchObject({ text: a2.text, blockId: 'A' });
		expect(acars.find((r) => r.registration === 'VT-ANA')).toMatchObject({ text: a3.text, crcOk: true, label: '5Z' });
	});

	it('drops a message with a damaged SSU and decodes the next', () => {
		const raw = aeroBuildBlock(aeroAcarsToSus(realMsg()), 10500);
		raw[12 * 4 + 5] ^= 0x04;
		const sus = aeroSplitSus(raw, 10500);
		expect([sus[4].crcOk, sus[4].typeName, sus[3].crcOk]).toEqual([false, 'Bad CRC', true]);
		const dec = new AeroSuDecoder();
		expect(sus.flatMap((s) => dec.feed(s, 0).acars)).toEqual([]);
		const after = aeroAcarsToSus({ ...realMsg(), text: 'AFTER' }).flatMap((s) => dec.feed(s, 1).acars);
		expect(after.map((m) => m.text)).toEqual(['AFTER']);
	});

	it('reads a downlink’s message number and flight, and passes other user data on as hex', () => {
		const m = {
			aesId: 0x4b1a2c,
			gesId: 0x12,
			uplink: false,
			registration: 'HB-JHM',
			label: 'H1',
			msgNo: 'M12A',
			flight: 'LX123',
			text: 'POS N2512E05530',
		};
		const { acars } = runRate(1200, aeroAcarsToSus(m), new AeroSuDecoder());
		expect(acars).toHaveLength(1);
		expect(acars[0]).toMatchObject({ uplink: false, msgNo: 'M12A', flight: 'LX123', text: m.text });
		const head = makeSu(0x71, [0x4b, 0x1a, 0x2c, 0x12, 0x01, 0x01, 0x30, 0xde, 0xad]);
		const tail = makeSu(0xc0, [0x01, 0xbe, 0xef, 0x55]);
		const dec = new AeroSuDecoder();
		const out = [head, tail].flatMap((s) => dec.feed(s, 0).acars);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ text: 'DEADBEEF55', labelText: 'Non-ACARS user data', binary: true });
	});

	it('reads the system table as JAERO does', () => {
		expect(aeroParseSystemSu(aeroSystemTableSu(0x12, 0))).toMatchObject({ kind: 1, gesId: 0x12, lsu: 0, names: 'Psmc Rsmc0 Rsmc1' });
		const g = aeroParseSystemSu(aeroSystemTableSu(0x12, 0));
		expect(g.freqMHz[0]).toBeGreaterThan(1544.9);
		expect(g.freqMHz[0]).toBeLessThan(1546.1);
		expect(g.freqMHz[1]).toBeGreaterThan(1620);
		expect(aeroParseSystemSu(aeroSystemTableSu(0x12, 3))).toMatchObject({ kind: 1, lsu: 3, names: 'Rsmc5 Rsmc6 Rsmc7' });
		const sat = aeroParseSystemSu(aeroSatelliteIdSu(5, 64.5, 1545.0125, 1545.5, 3));
		expect(sat).toMatchObject({ kind: 2, satId: 5, seq: 3 });
		expect(sat.lonDeg).toBeCloseTo(64.5, 1);
		expect(sat.freqMHz[0]).toBeCloseTo(1545.0125, 4);
		expect(sat.freqMHz[1]).toBeCloseTo(1545.5, 4);
		const west = aeroParseSystemSu(aeroSatelliteIdSu(2, -98, 1545));
		expect(west.lonDeg).toBeCloseTo(-97.5, 0);
		expect(west.freqMHz[1]).toBe(0);
		const cc = aeroChannelControlSu(0x12, 10500, 1545.075, true);
		expect(aeroParseSystemSu(cc)).toMatchObject({ kind: 3, bitRate: 10500, gesId: 0x12, spotBeam: true });
		for (const r of [600, 1200, 5250, 8400]) expect(aeroParseSystemSu(aeroChannelControlSu(1, r, 1545)).bitRate).toBe(r);
		expect(aeroDescribeSu(cc)).toContain('10500 bit/s');
		expect(aeroDescribeSu(aeroLogonSu(0x4b1a2c, 0x12, true))).toContain('4B1A2C');
		for (let p = 0; p < 6; p++) expect(aeroSystemTableSu(7, p).crcOk).toBe(true);
	});

	it('takes hardly any SU of random blocks', () => {
		const rng = xorshift(7);
		const dec = new AeroSuDecoder();
		let ok = 0;
		for (let b = 0; b < 3000; b++)
			for (const s of aeroSplitSus(
				Uint8Array.from({ length: 312 }, () => rng() & 0xff),
				10500,
			)) {
				ok += s.crcOk ? 1 : 0;
				dec.feed(s, b * 0.5);
			}
		expect(ok).toBeLessThanOrEqual(5);
	});
});

const near = (a, b, tol) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

describe('Aero ADS-C and positions', () => {
	it('decodes libacars’ ADS-C examples with their CRC', () => {
		expect(aeroArincCrc(ascii('123456789'))).toBe(0x29b1);
		const ex1 = '/LPAFAYA.ADS.VQ-BPJ1423CCA85D2D090886301D0D24C7D0704309088442255CC87CE2C90880DF97';
		const m = aeroDecodeAdsc(ex1, false);
		expect(m).toMatchObject({
			found: true,
			crcOk: true,
			complete: true,
			groundAddr: 'LPAFAYA',
			airReg: 'VQ-BPJ',
			tags: [20, 13],
			hasPos: true,
			posTag: 20,
			altFt: 37000,
		});
		near(m.lat, 50.3429604, 1e-6);
		near(m.lon, 16.3785553, 1e-6);
		expect([m.timeSec, m.accuracy, m.redundancyOk, m.tcasOk]).toEqual([396, 6, true, true]);
		near(m.route[0].lat, 51.7226028, 1e-6);
		near(m.route[0].lon, 19.7335052, 1e-6);
		expect([m.route[0].altFt, m.route[0].etaSec, m.route[1].altFt]).toEqual([37000, 1090, 37000]);
		near(m.route[1].lat, 52.5409126, 1e-6);
		near(m.route[1].lon, 21.9525719, 1e-6);
		const bad = ex1.replace('C90880DF97', 'C90881DF97');
		expect(aeroDecodeAdsc(bad, false)).toMatchObject({ found: true, crcOk: false });
		expect(aeroPositionFromMessage('B6', bad, false).pos).toBeNull();
		const n572 = aeroPositionFromMessage('H1', '#M1B/B6 LHWE1YA.ADS.N572UP07263B5872A048C9F21C1F0E5B88D700000239', false);
		expect(n572.pos).toMatchObject({ source: 1, altFt: 35996, speedKt: 430, secPastHour: 3207 });
		near(n572.pos.lat, 53.763485, 1e-6);
		near(n572.pos.lon, 20.1490974, 1e-6);
		near(n572.pos.trackDeg, 257.4, 0.05);
		expect(n572.adsc).toMatchObject({ accuracy: 7, groundAddr: 'LHWE1YA', airReg: 'N572UP' });
		expect(n572.adsc.earth.vsFpm).toBe(0);
		expect(aeroAdscTagName(7)).toBe('Basic report');
		for (const e of [
			'/BOMASAI.ADS.VT-ANB072501A070A988CA73248F0E5DC10200000F5EE1ABC000102B885E0A19F5',
			'/AUHASMO.ADS.A6-PFE0724D9586A36C92B2DCF1F0E74A8E4807C0F7219AF407C10422E9E08A1C4',
			'/CTUE1YA.ADS.HB-JNB1424AB686D9308CA2EBA1D0D24A2C06C1B48CA004A248050667908CA004BF6',
			'/YQXE2YA.ADS.SP-LRH1424FD087806C0B527769F0D2500B877ED00B5401E2516707755C01340B768',
		]) {
			const x = aeroDecodeAdsc(e, false);
			expect(x).toMatchObject({ found: true, crcOk: true, complete: true, hasPos: true });
			expect(x.lat > 49 && x.lat < 55 && x.lon > 14 && x.lon < 24).toBe(true);
		}
		const up = aeroDecodeAdsc('/PIKCPYA.ADS.HB-JHM07040B000C000D010E011000440D', true);
		expect(up).toMatchObject({ found: true, uplink: true, crcOk: true, hasPos: false, airReg: 'HB-JHM' });
		expect(up.requests[0]).toMatchObject({ kind: 7, contract: 4 });
	});

	it('round-trips the builders at the field resolutions', () => {
		const g = [
			...adscBasicGroup(-33.94612, 151.17722, 37004, 1234.375, 5),
			...adscFlightIdGroup('QFA1'),
			...adscEarthRefGroup(287.3, 471.5, -1200),
			...adscPredictedRouteGroup({ lat: -33.5, lon: 150.2, altFt: 37000, etaSec: 600 }, { lat: -32.9, lon: 148.8, altFt: 39000 }),
			...adscMeteoGroup(42.5, 265, -54.25),
		];
		const m = aeroDecodeAdsc(aeroBuildAdscText('SYDCAYA', 'VH-OQA', g), false);
		const lsb = 90 / 2 ** 19;
		expect(m).toMatchObject({
			crcOk: true,
			complete: true,
			altFt: 37004,
			timeSec: 1234.375,
			accuracy: 5,
			flightId: 'QFA1',
			airReg: 'VH-OQA',
		});
		near(m.lat, -33.94612, lsb);
		near(m.lon, 151.17722, lsb);
		near(m.earth.trackDeg, 287.3, 90 / 1024);
		expect([m.earth.groundKt, m.earth.vsFpm]).toEqual([471.5, -1200]);
		near(m.route[0].lat, -33.5, lsb);
		near(m.route[1].lon, 148.8, lsb);
		expect([m.route[0].etaSec, m.route[1].altFt]).toEqual([600, 39000]);
		expect([m.meteo.windKt, m.meteo.tempC]).toEqual([42.5, -54.25]);
		near(m.meteo.windDeg, 265, 90 / 128);
	});

	it('reads the text position reports of the airframes decoder tests', () => {
		const cases = [
			['H1', 'POSN43312W123174,EASON,215754,370,EBINY,220601,ELENN,M48,02216,185/TS215754,0921227A40', 43.52, -123.29, 1e-3, 37000],
			['H1', 'POSN45209W122550,PEGTY,220309,134,MINNE,220424,HISKU,M6,060013,269,366,355K,292K,730A5B', 45.348, -122.917, 5e-3, 13400],
			['H1', 'POSN33225W079428,SCOOB,232933,340,ENEME,235712,FETAL,M42,003051,15857F6', 33.375, -79.713, 5e-3, 34000],
			[
				'H1',
				'F37AMCLL93#M1BPOS/ID746026,,/DC03032024,173207/MR1,/ET031846/PSN42579W108090,173207,320,WAIDE,031759,WEDAK,M49,267070,T468/CG264,110,360/FB742/VR324E17',
				42.965,
				-108.15,
				1e-9,
				32000,
			],
			[
				'H1',
				'/.POS/TS100316,210324/PSS35333W058220,,100316,250,S37131W059150,101916,S39387W060377,M23,27282,241,780,MANUAL,0,813E711',
				-35.555,
				-58.367,
				1e-3,
				25000,
			],
			['20', 'POSN38160W077075,,211733,360,OTT,212041,,N42,19689,40,544', 38.16, -77.075, 1e-3, null],
			['16', 'N 44.203,W 86.546,31965,6, 290', 44.203, -86.546, 1e-9, 31965],
			['16', 'N 28.177/W 96.055', 28.177, -96.055, 1e-9, null],
			['16', 'N 44.988,W121.644,35940,6, 170', 44.988, -121.644, 1e-9, 35940],
		];
		for (const [label, text, lat, lon, tol, alt] of cases) {
			const p = aeroParseTextPosition(label, text);
			near(p.lat, lat, tol);
			near(p.lon, lon, tol);
			if (alt !== null) expect(p.altFt).toBe(alt);
		}
		for (const [label, text] of [
			['H1', 'POS Bogus message'],
			['H1', '#M1BPOS Bogus message'],
			['H1', 'WX OMDB 071300Z 32012KT CAVOK 35/17 Q1008 NOSIG'],
			['20', 'POSUNKNOWN'],
		])
			expect(aeroParseTextPosition(label, text)).toBeNull();
		expect(aeroParseTextPosition('H1', 'POSN43312W123174,EASON,215754,370').secOfDay).toBe(21 * 3600 + 57 * 60 + 54);
	});
});

describe('Aero CPDLC', () => {
	it('finds the application, its ground facility and aircraft in libacars’ real messages, and checks their CRC', () => {
		for (const [text, ground, reg] of [
			['/SOUCAYA.AT1.HL8251243F880C3D903BB412903604FE326C2479F4A64F7F62528B1A9CF8382738186AC28B16668E013DF464D8A7F0', 'SOUCAYA', 'HL8251'],
			[
				'/MSTEC7X.AT1.VT-ANKA094D88C3D903BB465D0723053B2E5123CFA53279400014B0894A2C6A73CBD8F52447AF1244CB4C9B94600089D65C84314892694587510528B1A9CF41169D440C1AB36A08B42',
				'MSTEC7X',
				'VT-ANK',
			],
			['/MELCAYA.AT1.ZK-OKC253C21CC3D903BA178F96618F0B28024B83127CD7886A12E9D85266B927584A9169C1A8EEB2800EEA7', 'MELCAYA', 'ZK-OKC'],
		]) {
			const c = aeroDecodeCpdlc(text);
			expect(c).toMatchObject({ imi: 'AT1', groundAddr: ground, reg, crcOk: true });
			expect(c.bodyHex.length).toBeGreaterThan(10);
			expect(aeroDescribeCpdlc(c)).toContain('FANS-1/A CPDLC message (AT1)');
		}
		expect(aeroDecodeCpdlc('- #MD/AA ATLTWXA.CR1.N856DN203A3AA8E5C1A9323EDD')).toMatchObject({
			imi: 'CR1',
			groundAddr: 'ATLTWXA',
			reg: 'N856DN',
			crcOk: true,
		});
		const damaged = '/SOUCAYA.AT1.HL8251243F880C3D903BB412903604FE326C2479F4A64F7F62528B1A9CF8382738186AC28B16668E013DF464D8A7F1';
		expect(aeroDecodeCpdlc(damaged).crcOk).toBe(false);
		expect(aeroDecodeCpdlc('/AKLCDYA.ADS.9V-SVG21D0755D8')).toBeNull();
		expect(aeroDecodeCpdlc('RANDOM TEXT .AT1. no address')).toBeNull();
	});
});
