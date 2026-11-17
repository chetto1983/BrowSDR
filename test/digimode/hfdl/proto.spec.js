// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir tests/hfdl/test_hfdl_proto.cpp (check sequences, the interleaver,
// the code, the PSK maps, the PDU builders and parsers, every rate's bit chain end to end), rust/onair_hfdl/src/tests.rs
// (FCS, rates, the interleaver, the scrambler, Viterbi, the code order, the known symbols, stations and masks, SPDU
// text, logon addresses, mutated input) and tests/hfdl/test_hfdl_table.cpp (the ground station table against the UDXF
// list), https://github.com/adswill/OnAir; see third_party/onair. Changes: Vitest; the golden digest of
// test_hfdl_proto_rs.cpp (recorded from OnAir's C++ layers) is not ported, its families are covered by the cases here.

import { describe, expect, it } from 'vitest';
import {
	PRE_LEN,
	PREKEY,
	SLOT_SEC,
	burstSyms,
	codedBits,
	convEncode,
	decodeSoft,
	hfdlFcs,
	fcsOk,
	hfdlRate,
	interleave,
	mBit,
	payloadOctets,
	preambleRef,
	scramblerSigns,
	viterbi,
	HFDL_BAUD,
	DATA_LEN,
	pskDecide,
	pskIm,
	pskRe,
	pskSoftBits,
} from '@/worker/decoders/digimode/hfdl/phy';
import { HFDL_STATIONS, hfdlStation, maskKhz, stationOnKhz } from '@/worker/decoders/digimode/hfdl/stations';
import { parsePdu } from '@/worker/decoders/digimode/hfdl/parse';
import { CoarseSearch } from '@/worker/decoders/digimode/hfdl/coarse';
import { HfdlSamples } from '@/worker/decoders/digimode/hfdl/front';
import {
	acarsHfnpdu,
	burstSymbols,
	burstSeconds,
	freqData,
	logonConfirm,
	logonRequest,
	mpduDown,
	mpduUp,
	perfData,
	play,
	rng,
	spdu,
	unnumbered,
} from './fixtures';

const bytes = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const parse = (pdu) => parsePdu(Uint8Array.from(pdu));
const line = (m, label) => m.detail.find(([k]) => k === label)?.[1];

describe('HFDL bit layers', () => {
	it('has the CRC-16/X.25 check value and checks frames', () => {
		expect(hfdlFcs(bytes('123456789'))).toBe(0x906e);
		const v = [...bytes('123456789'), 0x6e, 0x90];
		expect(fcsOk(Uint8Array.from(v))).toBe(true);
		v[3] ^= 1;
		expect(fcsOk(Uint8Array.from(v))).toBe(false);
	});

	it('has the eight rates', () => {
		expect(codedBits(3)).toBe(72 * 30 * 3);
		expect(payloadOctets(0)).toBe(Math.trunc((72 * 30) / 4 - 6) >> 3);
		expect(burstSyms(7)).toBe(531 + 168 * 45);
		expect(hfdlRate(99).m1).toBe(7);
		expect(hfdlRate(-4).m1).toBe(0);
		expect([payloadOctets(0), payloadOctets(3)]).toEqual([66, 404]);
		expect(burstSyms(0) + PREKEY).toBeLessThan(SLOT_SEC * HFDL_BAUD);
		expect(burstSyms(4) + PREKEY).toBeLessThan(2 * SLOT_SEC * HFDL_BAUD);
	});

	it('interleaves with a permutation that matches the push / pop state machine of the deployed system', () => {
		for (let m = 0; m < 8; m++) {
			const p = interleave(m);
			const n = codedBits(m);
			expect(new Set(p).size).toBe(n);
			expect(Math.min(...p)).toBe(0);
			expect(Math.max(...p)).toBe(n - 1);
			const cols = n / 40;
			const sh = hfdlRate(m).colShift;
			const t = new Int32Array(n);
			let row = 0;
			let col = 0;
			for (let i = 0; i < n; i++) {
				t[row * cols + col] = i;
				row++;
				if (row === 40) {
					row = 0;
					col++;
				}
				col -= sh;
				if (col < 0) col += cols;
			}
			row = col = 0;
			let bad = 0;
			for (let j = 0; j < n; j++) {
				bad += p[j] !== t[row * cols + col] ? 1 : 0;
				row = (row + 9) % 40;
				if (row === 0) col++;
			}
			expect(bad).toBe(0);
		}
	});

	it('scrambles with liquid msequence(15, 0x4001, 0x4D4B), restarting every 120 symbols', () => {
		const s = scramblerSigns(240);
		const want = '00010011000110111100010000100101';
		for (let i = 0; i < 32; i++) expect(s[i] < 0).toBe(want[i] === '1');
		expect([...s.subarray(0, 120)]).toEqual([...s.subarray(120)]);
	});

	it('codes with 0x6D first, then 0x4F, and the Viterbi decoder undoes it', () => {
		expect([...convEncode([1])]).toEqual([1, 1]);
		expect([...convEncode([1, 0]).subarray(2)]).toEqual([0, 1]);
		const bits = Array.from({ length: 300 }, (_, i) => (Math.imul(i, 2654435761) >>> 13) & 1);
		const soft = [...convEncode(bits)].map((b) => (b ? -1 : 1));
		expect([...viterbi(soft, 300).subarray(0, 294)]).toEqual(bits.slice(0, 294));
		// with noise
		const g = rng(5);
		const noisy = soft.map((v) => v + 0.6 * g.gauss());
		expect([...viterbi(noisy, 300).subarray(0, 294)]).toEqual(bits.slice(0, 294));
	});

	it('maps QPSK on the axes and 8PSK with the first bit the most significant of the Gray label', () => {
		const near = (v, re, im) => Math.abs(pskRe(...v) - re) < 1e-4 && Math.abs(pskIm(...v) - im) < 1e-4;
		expect(near([2, 0], 1, 0) && near([2, 2], 0, 1) && near([2, 3], -1, 0) && near([2, 1], 0, -1)).toBe(true);
		const h = Math.SQRT1_2;
		expect(near([3, 0], 1, 0) && near([3, 4], h, h) && near([3, 6], 0, 1) && near([3, 1], h, -h)).toBe(true);
		const out = new Float32Array(3);
		for (let b = 2; b <= 3; b++)
			for (let v = 0; v < 1 << b; v++) {
				pskSoftBits(b, pskRe(b, v), pskIm(b, v), 1, out, 0);
				let u = 0;
				for (let q = 0; q < b; q++) u |= (out[q] < 0 ? 1 : 0) << q;
				expect([pskDecide(b, pskRe(b, v), pskIm(b, v)), u]).toEqual([v, v]);
			}
	});

	it('tells the M1 shifts apart and has +-1 known symbols', () => {
		for (let a = 0; a < 8; a++)
			for (let b = a + 1; b < 8; b++) {
				let s = 0;
				for (let k = 0; k < 127; k++) s += mBit(a, k) === mBit(b, k) ? 1 : -1;
				expect(Math.abs(s)).toBeLessThan(20);
			}
		for (let m = 0; m < 8; m++) {
			expect(preambleRef(m)).toHaveLength(PRE_LEN);
			expect([...preambleRef(m)].every((v) => v === 1 || v === -1)).toBe(true);
		}
	});
});

describe('HFDL ground stations', () => {
	it('reads masks against the table', () => {
		expect(maskKhz(1, 0b101)).toEqual([21934, 13276]);
		expect(maskKhz(99, 0b11)).toEqual([-1, -2]);
		expect(stationOnKhz(5508)).toBe(1);
		expect(stationOnKhz(1)).toBe(0);
		expect(hfdlStation(9).khz).toHaveLength(19);
		expect(maskKhz(9, 1 << 18)).toEqual([2944]);
	});

	// UDXF Digital-aero.pdf, HFDL table version 51 (station 15 left out: the dumphfdl table version 52 lists other frequencies)
	const UDXF = {
		1: [5508, 6559, 8927, 10081, 11327, 13276, 17919, 21934],
		2: [5514, 6565, 8912, 8936, 10027, 11312, 11348, 13276, 13312, 13324, 17919, 21937],
		3: [3900, 5720, 6712, 8977, 11184, 15025, 17985],
		4: [5652, 6661, 8912, 11387, 13276, 17919, 21931],
		5: [5583, 6535, 8921, 10084, 13351, 17916],
		6: [5655, 6535, 8825, 10066, 13270, 17928, 21949],
		7: [2998, 3455, 5547, 6532, 8843, 8942, 10081, 11384],
		8: [3016, 4681, 5529, 8834, 11321, 13321, 17922, 21949],
		9: [2944, 2992, 3007, 3497, 4654, 4687, 5529, 5538, 5544, 6646, 8927, 8936, 10027, 10093, 11354, 17919, 17934, 21928, 21937],
		10: [2941, 5502, 6619, 8939, 10060, 13342, 17958, 21931],
		11: [5589, 6589, 8894, 10063, 13264, 17901],
		13: [4660, 6628, 8957, 11318, 13315, 17916, 21997],
		14: [5622, 6596, 8886, 10087, 13321, 17912, 21990],
		15: [],
		16: [5451, 6652, 8927, 11306, 13312, 17919, 21928],
		17: [6529, 8948, 11348, 13303, 17928, 21955],
	};

	it('is consistent and holds the frequencies of the UDXF list', () => {
		expect(new Set(HFDL_STATIONS.map((s) => s.id)).size).toBe(HFDL_STATIONS.length);
		for (const s of HFDL_STATIONS) {
			expect(s.khz.length).toBeGreaterThan(0);
			expect(s.khz.length).toBeLessThanOrEqual(20);
			expect(new Set(s.khz).size).toBe(s.khz.length);
			for (const k of s.khz) expect(k >= 2800 && k <= 22000).toBe(true);
		}
		for (const [id, khz] of Object.entries(UDXF)) for (const k of khz) expect(hfdlStation(Number(id)).khz).toContain(k);
	});
});

describe('HFDL PDUs', () => {
	const sq = spdu({
		gsId: 7,
		frameIndex: 1234,
		mask: 0x2b,
		other: [
			{ id: 3, utc: true, mask: 0x5 },
			{ id: 17, utc: false, mask: 0x41 },
		],
	});

	it('reads a squitter', () => {
		const out = parse(sq);
		expect(out).toHaveLength(1);
		const m = out[0];
		expect([m.squitter, m.gsId, m.frameIndex, m.utcSync, m.systable]).toEqual([true, 7, 1234, true, 50]);
		expect(m.activeKhz).toEqual([11384, 10081, 8843, 5547]);
		expect(m.summary).toBe('Squitter Shannon, frame 1234, 4 frequencies in use');
		const stations = m.detail.filter(([k]) => k === 'Station').map(([, v]) => v);
		expect(stations).toEqual(['3 Reykjavik (UTC): 17985 11184 kHz', '17 Canarias: 21955 bit6 kHz']);
		expect(line(m, 'TDMA frame')).toBe('1234 (10:58:08 UTC at 32 s per frame), offset 0, minimum priority 0, system table version 50');
		const bad = [...sq];
		bad[20] ^= 4;
		expect(parse(bad)).toBeUndefined();
		expect(parse(sq.slice(0, 3))).toBeUndefined();
	});

	it("reads OnAir's minimal squitter text", () => {
		const b = new Array(66).fill(0);
		b[0] = 0x20;
		b[1] = 0x81;
		b[2] = 3;
		b[54] = 0x30;
		const f = hfdlFcs(Uint8Array.from(b.slice(0, 64)));
		b[64] = f & 0xff;
		b[65] = f >> 8;
		const [m] = parse(b);
		expect(m.kind).toBe('SPDU');
		expect(m.summary.startsWith('Squitter San Francisco, frame 3')).toBe(true);
		expect(line(m, 'SPDU')).toContain('UTC synchronised');
	});

	it('reads a logon, performance data and ACARS in one downlink MPDU', () => {
		const mp = mpduDown(1, 23, [
			logonRequest(0xa1b2c3),
			unnumbered(perfData('UA0901', 51.4775, -45.25, 37000, 1, 2)),
			unnumbered(acarsHfnpdu('N123UA', 'H1', '2', 'M01AUA0901#DFB HELLO HFDL')),
		]);
		const out = parse(mp);
		expect(out).toHaveLength(3);
		expect([out[0].kind, out[0].icao, out[0].uplink, out[0].acId]).toEqual(['Logon request', 0xa1b2c3, false, 23]);
		expect(out[0].summary).toBe('Logon request from A1B2C3');
		const p = out[1];
		expect([p.hfnpdu, p.hasPos, p.flight, p.utcSec, p.posKind]).toEqual(['Performance data', true, 'UA0901', 37000, 'Performance data']);
		expect(Math.abs(p.lat - 51.4775)).toBeLessThan(0.001);
		expect(Math.abs(p.lon + 45.25)).toBeLessThan(0.001);
		expect(p.summary).toBe('Performance data UA0901  51.477 -45.250');
		expect(line(p, 'Performance')).toBe('version 2, flight leg 1, ground station 1 San Francisco, frequency id 2');
		expect(line(p, 'Performance data')).toBe('flight UA0901, position 51.4775 -45.2499, time 10:16:40 UTC');
		const a = out[2];
		expect([a.hfnpdu, a.acars.crcOk, a.acars.reg, a.acars.label, a.flight]).toEqual(['ACARS', true, 'N123UA', 'H1', 'UA0901']);
		expect(a.acars.text).toContain('HFDL');
		expect(a.summary.startsWith('ACARS H1 (Terminal message) UA0901')).toBe(true);
	});

	it('reads a logon confirm uplink, frequency data and a logoff', () => {
		const [c] = parse(mpduUp(2, 0, [logonConfirm(0x4ca2b1, 45)]));
		expect([c.uplink, c.icao, c.acId, c.gsId, c.kind]).toEqual([true, 0x4ca2b1, 45, 2, 'Logon confirm']);
		const fd = parse(
			mpduDown(3, 9, [
				unnumbered(
					freqData('BA0117', -33.5, 151.25, 7200, [
						{ id: 3, mask: 3 },
						{ id: 7, mask: 1 },
					]),
				),
			]),
		);
		expect(fd).toHaveLength(1);
		expect([fd[0].hfnpdu, fd[0].summary]).toEqual(['Frequency data', 'Frequency data BA0117  -33.500 151.250, 2 stations heard']);
		expect(Math.abs(fd[0].lat + 33.5)).toBeLessThan(0.001);
		expect(fd[0].detail.filter(([k]) => k === 'Station').map(([, v]) => v)[0]).toBe(
			'3 Reykjavik: heard on 17985 15025 kHz, listening on 17985 15025 kHz',
		);
	});

	it('reads logon addresses with their bits reversed, as observed on the air', () => {
		for (const [wire, expected] of [
			[[0x1e, 0x38, 0x6b], 0x781cd6],
			[[0x1e, 0x08, 0xfc], 0x78103f],
		]) {
			const lp = [0x8f, ...wire];
			const f = hfdlFcs(Uint8Array.from(lp));
			const mp = [0x03 | (1 << 2), 1, 7, 0, 0, 0, lp.length + 1];
			const g = hfdlFcs(Uint8Array.from(mp));
			const [m] = parse([...mp, g & 0xff, g >> 8, ...lp, f & 0xff, f >> 8]);
			expect(m.icao).toBe(expected);
			expect(m.summary).toContain(expected.toString(16).toUpperCase());
			expect(m.acId).toBe(7);
		}
	});

	it('names system tables, bad LPDUs and unknown LPDU types', () => {
		const out = parse(mpduUp(4, 12, [unnumbered([0xff, 0xd0, 0x21, 0x50, 0x03, 1, 2]), [0x0d, 1, 2, 3, 4], [0x77, 0, 0]]));
		expect(out.map((m) => m.summary)).toEqual([
			'System table part 1 of 3, version 53',
			'LPDU with a bad check sequence',
			expect.stringMatching(/^LPDU (type 0x77|with a bad check)/),
		]);
		expect(out[1].bad).toBe(true);
		const lp = [0x77, 9, 9];
		const f = hfdlFcs(Uint8Array.from(lp));
		const [u] = parse(mpduDown(4, 12, [[...lp, f & 0xff, f >> 8]]));
		expect(u.summary).toBe('LPDU type 0x77 (3 octets)');
	});

	it('never throws on mutated or random input', () => {
		const base = [...sq];
		const pdus = [base, mpduDown(1, 2, [logonRequest(0x123456), unnumbered(perfData('X', 1, 2, 3, 1, 0))])];
		let x = 12345;
		const next = () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0);
		for (let i = 0; i < 20000; i++) {
			const v = [...pdus[i & 1]];
			for (let k = 0; k < 3; k++) v[(next() >>> 8) % v.length] = next() >>> 24;
			const n = (next() >>> 8) % (v.length + 1);
			expect(() => parse(v.slice(0, n))).not.toThrow();
		}
	});
});

describe('HFDL bit chain', () => {
	it('carries a PDU through every rate, noiseless', () => {
		const sq = spdu({ gsId: 7, frameIndex: 99, mask: 3 });
		const mp = mpduDown(1, 23, [logonRequest(0xa1b2c3), unnumbered(perfData('UA0901', 51.4775, -45.25, 37000, 1, 2))]);
		for (let m = 0; m < 8; m++) {
			const r = hfdlRate(m);
			const pdu = m === 0 || m === 4 ? sq : mp;
			const s = burstSymbols(m, pdu);
			expect(s.re).toHaveLength(PREKEY + burstSyms(m));
			const scr = scramblerSigns(r.blocks * DATA_LEN);
			const soft = new Float32Array(codedBits(m));
			let i = PREKEY + PRE_LEN;
			let di = 0;
			for (let b = 0; b < r.blocks; b++, i += 15)
				for (let q = 0; q < DATA_LEN; q++, i++, di++)
					pskSoftBits(r.bitsPerSym, s.re[i] * scr[di], s.im[i] * scr[di], 1, soft, di * r.bitsPerSym);
			const dec = decodeSoft(m, soft);
			expect([...dec.subarray(0, pdu.length)]).toEqual(pdu);
		}
	});
});

describe('HFDL coarse search', () => {
	/** OnAir's coarse(): A1 + A2 times the reference turned by 9 trial offsets, |8-symbol chunks| summed, over sum |x|. */
	function direct(x, s) {
		const i0 = s - x.base;
		const ref = preambleRef(0);
		let sumA = 0;
		for (let q = 0; q < 254; q++) sumA += x.mag[i0 + 4 * q];
		let best = 0;
		for (let h = -4; h <= 4; h++) {
			let sum = 0;
			for (let c = 0; c < 32; c++) {
				let ar = 0;
				let ai = 0;
				for (let q = 8 * c; q < Math.min(254, 8 * c + 8); q++) {
					const ph = (-2 * Math.PI * h * 100 * q) / 1800;
					const rr = ref[q] * Math.cos(ph);
					const ri = ref[q] * Math.sin(ph);
					ar += x.re[i0 + 4 * q] * rr - x.im[i0 + 4 * q] * ri;
					ai += x.re[i0 + 4 * q] * ri + x.im[i0 + 4 * q] * rr;
				}
				sum += Math.hypot(ar, ai);
			}
			best = Math.max(best, sum);
		}
		return best / sumA;
	}

	it("gives the measure of OnAir's coarse search, on noise and on a burst with a carrier offset", () => {
		const x = new HfdlSamples();
		x.push(play([{ m1: 1, pdu: spdu({ gsId: 7 }), t: 0.2, cfo: 170 }], { snrDb: 15, secs: 0.2 + burstSeconds(1) + 0.5 }));
		const search = new CoarseSearch();
		let peak = 0;
		for (let s = 0; s + 1100 < x.len; s += 3) {
			const m = search.measure(x, s);
			expect(Math.abs(m - direct(x, s))).toBeLessThan(1e-5);
			peak = Math.max(peak, m);
		}
		expect(peak).toBeGreaterThan(0.8);
	});
});
