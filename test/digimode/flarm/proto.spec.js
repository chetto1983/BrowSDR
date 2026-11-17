// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir tests/flarm/test_flarm_proto.cpp (the sync word against SoftRF's
// constant, the CRC check value, XXTEA, the V6 key and packet, position and velocity packing, parity rejection),
// tests/avroad/test_avroad_air.cpp (the OGN format and its LDPC repair) and tests/adsl/test_adsl_proto.cpp (CRC-24,
// XXTEA against the specification's routine, the exponential fields, every field through pack and parse,
// Reed-Solomon, the CRC repair), https://github.com/adswill/OnAir; see third_party/onair. Changes: the ADS-L parameter
// sweep takes every third category; the Reed-Solomon miscorrection trials are 100 per length (OnAir: 200).
import { describe, expect, it } from 'vitest';
import * as F from '@/worker/decoders/digimode/flarm/flarm-proto';
import { ognParityErrors, ognParse, ognRepair } from '@/worker/decoders/digimode/flarm/ogn-proto';
import * as A from '@/worker/decoders/digimode/flarm/adsl-proto';
import { rsDecode, rsEncode } from '@/worker/decoders/digimode/flarm/adsl-rs';
import { ognPacket } from './ogn-fixtures';
import { adslAircraft, adslTrafficNet } from './fixtures';
import { gauss } from '../ftx/fixtures';

describe('FLARM V6 packet layer', () => {
	it('codes the sync word as SoftRF does and has the CCITT-FALSE check value', () => {
		const c = F.manchester([0xf5, 0x31, 0xfa, 0xb6]);
		const want = [0x55, 0x99, 0xa5, 0xa9, 0x55, 0x66, 0x65, 0x96];
		expect(c).toEqual(want.flatMap((b) => Array.from({ length: 8 }, (_, i) => (b >> (7 - i)) & 1)));
		expect(F.FLARM_SYNC).toBe(0xf531fab6);
		expect(F.crc16(new TextEncoder().encode('123456789'))).toBe(0x29b1);
	});
	it('undoes XXTEA with the right key only, for FLARM rounds and the standard ones', () => {
		for (const rounds of [6, 0]) {
			const v = Uint32Array.from([0x11111111, 0x22222222, 0x33333333, 0x44444444, 0x55555555]);
			const w = v.slice();
			F.btea(w, 5, [1, 2, 3, 4], rounds);
			expect(w).not.toEqual(v);
			const x = w.slice();
			F.btea(x, -5, [1, 2, 3, 5], rounds);
			expect(x).not.toEqual(v);
			F.btea(w, -5, [1, 2, 3, 4], rounds);
			expect(w).toEqual(v);
		}
	});
	it('makes the key from the 64 s step and the address', () => {
		const a = F.makeV6Key(1800000000, 0x123400);
		expect(F.makeV6Key(1800000000 + 64, 0x123400)).not.toEqual(a);
		expect(F.makeV6Key(1800000000, 0x123500)).not.toEqual(a);
		const step = 1800000000 - (1800000000 % 64);
		expect(F.makeV6Key(step + 63, 0x123400)).toEqual(F.makeV6Key(step, 0x123400));
	});
	it('round-trips a V6 packet and rejects other key times by parity', () => {
		const p = F.emptyV6();
		Object.assign(p, { addr: 0xdd1234, addrType: F.ADDR_FLARM, aircraftType: 1, alt: 1450, vsRaw: -7 }, F.packPosition(54.7123, 25.2845));
		F.packVelocity(27.3, 215, 2.1, p);
		const ts = 1800000123;
		const raw = F.encodeV6(p, ts);
		expect([F.packetType(raw), F.packetAddr(raw)]).toEqual([0, 0xdd1234]);
		const q = F.decodeV6(raw, ts).packet;
		expect(q).toMatchObject({ addr: p.addr, alt: 1450, aircraftType: 1, lat19: p.lat19, lon20: p.lon20, noTrack: false, stealth: false });
		const pos = F.unpackPosition(q.lat19, q.lon20, 54, 25);
		expect(Math.abs(pos.lat - 54.7123)).toBeLessThan(2e-5);
		expect(Math.abs(pos.lon - 25.2845)).toBeLessThan(2e-5);
		const v = F.unpackVelocity(q);
		expect(Math.abs(v.speedMs - 27.3)).toBeLessThan(1);
		expect(Math.abs(v.trackDeg - 215)).toBeLessThan(4);
		expect(Math.abs(v.climbMs - 2.1)).toBeLessThan(0.5);
		let bad = 0;
		for (let i = 1; i <= 64; i++) if (F.decodeV6(raw, ts + 64 * i).result !== 'ok') bad++;
		expect(bad).toBeGreaterThanOrEqual(16);
		expect(bad).toBeLessThanOrEqual(48);
		Object.assign(p, { noTrack: true, stealth: true });
		expect(F.decodeV6(F.encodeV6(p, ts), ts).packet).toMatchObject({ noTrack: true, stealth: true });
		raw[3] = (raw[3] & 0xf0) | 2;
		expect(F.packetType(raw)).toBe(2);
		expect(F.decodeV6(raw, ts).result).toBe('notV6');
	});
	it('wraps positions around the reference', () => {
		for (const [lat, lon] of [
			[-33.9, 151.2],
			[48.1, 11.6],
			[0, -0.1],
			[47.2, 8.9],
		]) {
			const { lat19, lon20 } = F.packPosition(lat, lon);
			const r = F.unpackPosition(lat19, lon20, lat + 1.5, lon - 2);
			expect(Math.abs(r.lat - lat)).toBeLessThan(2e-5);
			expect(Math.abs(r.lon - lon)).toBeLessThan(2e-5);
		}
	});
	it('frames 24 bytes as 64 + 416 chips with a CRC', () => {
		const raw = new Uint8Array(24);
		raw.set([1, 2, 3]);
		const c = F.frameToChips(raw);
		expect(c.length).toBe(64 + 416);
		const f = Uint8Array.from({ length: 26 }, (_, i) => {
			let v = 0;
			for (let b = 0; b < 8; b++) v = (v << 1) | c[64 + 16 * i + 2 * b + 1];
			return v;
		});
		expect(F.checkCrc(f)).toBe(true);
		expect([...f.subarray(0, 24)]).toEqual([...raw]);
		f[5] ^= 0x10;
		expect(F.checkCrc(f)).toBe(false);
	});
});

describe('OGN tracker packet', () => {
	it('reads the fields and notices a wrong bit', () => {
		const p = ognPacket(0x123456, 1, 54.68, 25.28, 1500);
		expect(ognParityErrors(p)).toBe(0);
		const q = p.slice();
		q[3] ^= 1;
		expect(ognParityErrors(q)).toBeGreaterThan(0);
		const o = ognParse(p);
		expect(o).toMatchObject({ address: 0x123456, addrType: 3, acftType: 1, altM: 1500, addrParityOk: true });
		expect(Math.abs(o.lat - 54.68)).toBeLessThan(0.002);
		expect(Math.abs(o.lon - 25.28)).toBeLessThan(0.002);
		expect(Math.abs(o.speedMs - 12.3)).toBeLessThan(0.01);
		expect(Math.abs(o.headingDeg - 180)).toBeLessThan(0.2);
	});
	it('repairs a few wrong bits from soft values', () => {
		const p = ognPacket(0xabcdef, 7, -33.9, 151.2, 800);
		const soft = Float32Array.from({ length: 208 }, (_, i) => ((p[i >> 3] >> (7 - (i & 7))) & 1 ? 1 : -1));
		for (const nb of [1, 2, 3, 4]) {
			const q = p.slice();
			const s = soft.slice();
			for (let i = 0; i < nb; i++) {
				const k = 7 + i * 37;
				q[k >> 3] ^= 1 << (7 - (k & 7));
				s[k] = -s[k] * 0.1;
			}
			expect(ognRepair(q, s)).toBe(true);
			expect(q).toEqual(p);
		}
	});
});

function sweepTraffic(amt, relay, cat, st, em) {
	return Object.assign(A.emptyTraffic(), {
		amt,
		addr: (0x123456 ^ (cat * 77)) >>> 0,
		relay,
		category: cat,
		flightState: st,
		emergency: em,
		timeQ: (cat + st + em) % 60,
		hasPos: true,
		lat: -80 + cat * 5.1,
		lon: -170 + em * 45.3,
		hasAlt: true,
		altM: -320 + cat * 900,
		hasSpeed: true,
		speedMs: st * 2.75,
		hasClimb: true,
		climbMs: em - 3.5,
		hasTrack: st !== 0,
		trackDeg: em * 40,
		sil: em & 3,
		design: st,
		nic: cat & 15,
		hAcc: em,
		vAcc: st,
		velAcc: (st + 1) & 3,
	});
}

const SAME_FIELDS = ['category', 'flightState', 'emergency', 'timeQ', 'sil', 'design', 'nic', 'hAcc', 'vAcc', 'velAcc', 'hasTrack'];
const sameTraffic = (r, t) =>
	!!r &&
	SAME_FIELDS.every((k) => r[k] === t[k]) &&
	r.hasPos &&
	Math.abs(r.lat - t.lat) < 1.1e-5 &&
	Math.abs(r.lon - t.lon) < 2.2e-5 &&
	r.hasAlt &&
	Math.abs(r.altM - t.altM) <= 8 &&
	r.hasSpeed &&
	Math.abs(r.speedMs - t.speedMs) < 0.13 &&
	r.hasClimb &&
	Math.abs(r.climbMs - t.climbMs) < 0.07 &&
	(!t.hasTrack || Math.abs(r.trackDeg - t.trackDeg) < 0.4);

const climbRaw = (ms) => A.getBits(A.packTraffic(Object.assign(A.emptyTraffic(), { hasClimb: true, climbMs: ms })), 86, 9);

describe('ADS-L air format', () => {
	it('has the Mode S CRC-24 and scrambles with the specification XXTEA (zero key, 6 rounds)', () => {
		expect(A.crc24([0x8d, 0x48, 0x40, 0xd6, 0x20, 0x2c, 0xc3, 0x71, 0xc3, 0x2c, 0xe0])).toBe(0x576098);
		const t = Object.assign(A.emptyTraffic(), { addr: 0x123456, amt: A.AMT_ICAO, hasPos: true, lat: 54.7, lon: 25.3 });
		const d = A.makeData(A.TYPE_TRAFFIC, t.amt, t.addr, false, A.packTraffic(t));
		expect(d.length).toBe(20);
		const w = new Uint32Array(d.buffer.slice(0, 20));
		F.btea(w, 5, [0, 0, 0, 0], 6);
		const net = A.makeNetwork(d, 1, 0, false);
		expect(net.length).toBe(24);
		expect([...net.subarray(1, 21)]).toEqual([...new Uint8Array(w.buffer)]);
		expect([...A.makeNetwork(d, 1, 3, false).subarray(1, 21)]).toEqual([...d]);
		expect(A.makeData(0, 0x2a, 0x4a9554, false, [0, 0, 0])[1]).toBe(0x2a | ((0x54 & 3) << 6));
	});
	it('codes altitude, speed and climb as tables G.1.7 - G.1.9', () => {
		expect([A.expEncode(320, 12), A.expEncode(1320, 12), A.expEncode(0, 12)]).toEqual([0x140, 0x528, 0]);
		expect([A.expEncode(61104 + 320, 12), A.expEncode(70000, 12)]).toEqual([0x3ffe, 0x3ffe]);
		expect([0, 1, 3, 480, 944, 5000].map((v) => A.expEncode(v, 6))).toEqual([0, 1, 3, 0xc4, 0xfe, 0xfe]);
		expect([A.expDecode(0xc4, 6), A.expDecode(0xfe, 6)]).toEqual([480, 944]);
		for (let v = 0; v <= 4095; v++) expect(A.expDecode(A.expEncode(v, 12), 12)).toBe(v);
		expect([0, 0.125, -0.125, 10, -10].map(climbRaw)).toEqual([0, 1, 0x101, 0x048, 0x148]);
		expect([119, 200, -118, -300].map(climbRaw)).toEqual([0xff, 0xff, 0x1fe, 0x1fe]);
		const b = A.unpackTraffic(A.packTraffic(A.emptyTraffic()), 6, 1, false);
		expect([b.hasPos, b.hasAlt, b.hasSpeed, b.hasClimb, b.hasTrack]).toEqual([false, false, false, false, false]);
	});
	it('carries every field through pack and parse with every network parameter', () => {
		const wrong = [];
		let n = 0;
		for (const version of [0, 1, 7])
			for (const key of [0, 3])
				for (const fec of [false, true])
					for (const relay of [false, true])
						for (const amt of [0, 1, 5, 6, 7, 8, 9, 63])
							for (let cat = 0; cat < 32; cat += fec ? 7 : 3)
								for (let st = 0; st < 4; st++)
									for (let em = 0; em < 8; em++) {
										const t = sweepTraffic(amt, relay, cat, st, em);
										const net = adslTrafficNet(t, version, key, fec);
										const q = A.parseNetwork(net);
										const ok =
											net.length === (fec ? 53 : 24) &&
											A.checkParity(net) === 0 &&
											q.kind === 'traffic' &&
											[q.version, q.keyIndex, q.fec, q.relay, q.amt, q.addr, q.type].join() ===
												[version, key, fec, relay, amt, t.addr, A.TYPE_TRAFFIC].join() &&
											sameTraffic(q.targets[0], t);
										if (!ok) wrong.push([version, key, fec, relay, amt, cat, st, em].join());
										n++;
									}
		expect(wrong).toEqual([]);
		expect(n).toBeGreaterThan(20000);
	}, 60_000);
	it('counts reserved keys and reads Status', () => {
		expect(A.parseNetwork(adslTrafficNet(Object.assign(A.emptyTraffic(), { addr: 1 }), 1, 1, false)).kind).toBe('encrypted');
		const s = {
			amt: 0,
			addr: 0,
			maxVersion: 1,
			mRx: 3,
			ldrRx: 2,
			hdrRx: 1,
			mobile: 2,
			econRx: 0xa5,
			econTx: 0x5a,
			xpdr: 2,
			trafficClient: true,
			fisClient: true,
		};
		const net = A.makeNetwork(A.makeData(A.TYPE_STATUS, A.AMT_FLARM, 0x112233, false, A.packStatus(s)), 1, 0, false);
		expect(net.length).toBe(16);
		const q = A.parseNetwork(net);
		expect(q.kind).toBe('status');
		expect(q.status).toEqual({ ...s, amt: A.AMT_FLARM, addr: 0x112233 });
	});
	it('corrects up to 16 symbol errors with Reed-Solomon and never passes a miscorrection', () => {
		const g = gauss(1);
		const rnd = () => Math.floor((g() * 1e6) % 1e6) & 0x7fffffff;
		for (const len of [53, 100, 255]) {
			const blk = Uint8Array.from({ length: len }, () => rnd() & 255);
			blk.set(rsEncode(blk, len - 32), len - 32);
			expect(rsDecode(blk.slice())).toBe(0);
			for (let ne = 1; ne <= 16; ne++) {
				const x = blk.slice();
				for (let i = 0; i < ne; i++) x[rnd() % len] ^= 1 + (rnd() % 255);
				const r = rsDecode(x);
				expect(r).toBeGreaterThanOrEqual(0);
				expect(r).toBeLessThanOrEqual(ne);
				expect(x).toEqual(blk);
			}
			let mis = 0;
			for (let trial = 0; trial < 100; trial++) {
				const x = blk.slice();
				for (let i = 0; i < 20; i++) x[rnd() % len] ^= 1 + (rnd() % 255);
				if (rsDecode(x) >= 0 && x.some((v, i) => v !== blk[i])) mis++;
			}
			expect(mis).toBe(0);
		}
	});
	it('finds a wrong CRC bit with and without the weakest bits', () => {
		const net = adslTrafficNet(adslAircraft(0xabcdef, 4, 54, 25));
		for (let b = 0; b < 192; b += 7) {
			const x = net.slice();
			x[b >> 3] ^= 0x80 >> (b & 7);
			expect(A.correctCrc(x, [100, 101, 102, 103])).toBe(1);
			expect(x).toEqual(net);
		}
		for (let b = 0; b + 40 < 192; b += 11) {
			const x = net.slice();
			x[b >> 3] ^= 0x80 >> (b & 7);
			x[(b + 40) >> 3] ^= 0x80 >> ((b + 40) & 7);
			expect(A.correctCrc(x, [b + 40, 5, 6, 7])).toBe(2);
			expect(x).toEqual(net);
		}
	});
});
