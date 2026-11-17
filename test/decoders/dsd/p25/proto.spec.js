// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR from OnAir tests/p25/test_p25_proto.cpp, tests/p25/test_p25_cc.cpp and
// rust/onair_p25/src/tests.rs, https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the Hamming and Golay (18,6) codes are decoded by the receiver's soft decision (mlHamming, mlGolay18) on
// +-1 soft values; the Reed-Solomon code is p25p2/rs.ts; the IMBE interleave is DSD's extractP25IMBE; the random
// argument loops of test_p25_cc are shorter.
import { describe, expect, it } from 'vitest';
import { extractP25IMBE } from '@/worker/decoders/dsd/dsd-p25';
import { rsDecode, rsEncode } from '@/worker/decoders/dsd/p25p2/rs';
import { crc32Pdu, mbtToTsbks, pduAssemble, tsbkDescribe } from '@/worker/decoders/dsd/p25/cc';
import {
	LC_GROUP,
	LC_UNIT,
	LDU1,
	OP_GRP_V_GRANT,
	OP_NET_STS,
	OP_RFSS_STS,
	SYNC,
	channelText,
	dibitToSym,
	esHexbits,
	esParse,
	golay18Encode,
	golay24Decode,
	golay24Encode,
	hamming10Encode,
	hduHexbits,
	hduParse,
	lcHexbits,
	lcParse,
	mlGolay18,
	mlHamming,
	nidDecode,
	nidDecodeKnownNac,
	nidEncode,
	trellisDecode,
	trellisEncode,
	tsbkBits,
	tsbkParse,
} from '@/worker/decoders/dsd/p25/proto';
import { imbeMatrix, interleave } from './fixtures.js';

let rng = 12345;
const rnd = () => {
	rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
	return rng >>> 8;
};
const soft = (cw, n) => Float32Array.from({ length: n }, (_, k) => ((cw >> (n - 1 - k)) & 1 ? 1 : -1));

describe('P25 Phase 1 protocol (OnAir test_p25_proto)', () => {
	it('frame sync: the levels are the word 0x5575F5FF77FF a dibit at a time', () => {
		for (let k = 0; k < 24; k++) expect(SYNC[k]).toBe(dibitToSym(Number((0x5575f5ff77ffn >> BigInt(46 - 2 * k)) & 3n)));
	});

	it('NID: up to 10 bit errors corrected; with the NAC known up to 16', () => {
		for (let t = 0; t < 120; t++) {
			const nac = rnd() & 0xfff;
			const duid = [0, 3, 5, 7, 10, 12, 15][t % 7];
			const b = nidEncode(nac, duid);
			for (let e = 0; e < t % 11; e++) b[rnd() % 63] ^= 1;
			expect(nidDecode(b)).toMatchObject({ nac, duid });
			expect(nidDecode(b, nac)).toMatchObject({ nac, duid });
		}
		const b = nidEncode(0x293, LDU1);
		for (const k of [3, 17, 30, 41, 59]) b[k] ^= 1;
		expect(nidDecode(b)).toEqual({ nac: 0x293, duid: LDU1, errs: 5 });
		for (let k = 0; k < 14; k++) b[(7 * k + 1) % 63] ^= 1;
		expect(nidDecodeKnownNac(b, 0x293)?.duid).toBe(LDU1);
	});

	it.each([
		[24, 12],
		[24, 16],
		[36, 20],
	])('RS (%i,%i) corrects up to (n - k) / 2 symbol errors', (n, k) => {
		const tt = (n - k) / 2;
		for (let t = 0; t < 60; t++) {
			const s = new Uint8Array(n);
			for (let i = 0; i < k; i++) s[i] = rnd() & 63;
			rsEncode(s, n, k);
			const o = s.slice();
			const pos = new Set();
			while (pos.size < t % (tt + 1)) pos.add(rnd() % n);
			for (const p of pos) s[p] ^= 1 + (rnd() % 63);
			expect(rsDecode(s, n, k)).toBeGreaterThanOrEqual(0);
			expect(s).toEqual(o);
		}
	});

	it('Hamming (10,6) one error, Golay (24,12) three errors and distance 8, Golay (18,6)', () => {
		for (let h = 0; h < 64; h++) for (let b = 0; b < 10; b++) expect(mlHamming(soft(hamming10Encode(h) ^ (1 << b), 10), 0)).toBe(h);
		let dmin = 99;
		for (let d = 1; d < 4096; d++) dmin = Math.min(dmin, golay24Encode(d).toString(2).replace(/0/g, '').length);
		expect(dmin).toBe(8);
		for (let t = 0; t < 200; t++) {
			const d = rnd() & 0xfff;
			let c = golay24Encode(d);
			for (let e = 0; e < t % 4; e++) c ^= 1 << (rnd() % 24);
			expect(golay24Decode(c >>> 0).data).toBe(d);
			let c18 = golay18Encode(d & 63);
			for (let e = 0; e < t % 4; e++) c18 ^= 1 << (rnd() % 18);
			expect(mlGolay18(soft(c18, 18), 0)).toBe(d & 63);
		}
	});

	it('TSBK through the trellis code, with level noise and a symbol a level off', () => {
		for (let t = 0; t < 60; t++) {
			const a = {
				last: !!(t & 1),
				prot: false,
				opcode: rnd() & 63,
				mfid: 0,
				args: (BigInt(rnd()) << 40n) ^ (BigInt(rnd()) << 16n) ^ BigInt(rnd()),
			};
			const lv = Float32Array.from(trellisEncode(tsbkBits(a)), (d) => dibitToSym(d) + ((rnd() % 100) - 50) / 100);
			const i = rnd() % 98;
			lv[i] += lv[i] > 0 ? -2 : 2;
			const r = trellisDecode(lv);
			expect(tsbkParse(r)).toEqual(a);
			r[10] ^= 1;
			expect(tsbkParse(r)).toBeNull();
		}
	});

	it('link control, encryption sync and header fields', () => {
		const l = { lco: LC_GROUP, mfid: 0, prot: false, svcOpts: 0xc4, tg: 1201, src: 1234567, dst: -1 };
		expect(lcParse(lcHexbits(l))).toMatchObject({ lco: 0, tg: 1201, src: 1234567, svcOpts: 0xc4 });
		expect(lcParse(lcHexbits({ ...l, lco: LC_UNIT, dst: 76543 }))).toMatchObject({ lco: 3, dst: 76543, src: 1234567 });
		const c = { mi: 'ab0000000000000000', algId: 0x84, keyId: 0x1234, mfid: 0, tg: 999 };
		expect(esParse(esHexbits(c))).toMatchObject({ algId: 0x84, keyId: 0x1234, mi: 'ab0000000000000000' });
		expect(hduParse(hduHexbits(c))).toMatchObject({ algId: 0x84, keyId: 0x1234, tg: 999 });
		expect(channelText(0x1005)).toBe('1-5');
	});

	it('IMBE interleave round trip (DSD extractP25IMBE against OnAir imbe.rs interleave)', () => {
		const bits = Uint8Array.from({ length: 144 }, () => rnd() & 1);
		const fr = imbeMatrix(bits);
		expect(extractP25IMBE(Uint8Array.from(interleave(fr)), 0)).toEqual(fr);
	});
});

/** An MBT: header block and data blocks with fields at bit offsets counted from the end (OP25's mbt_data << 32). */
function mbt(fmt, sap, src, op, nDataBlocks, fields) {
	const d = new Uint8Array(nDataBlocks * 12);
	const N = d.length;
	for (const [low, width, v] of fields)
		for (let i = 0; i < width; i++) if ((BigInt(v) >> BigInt(i)) & 1n) d[N - 1 - Math.floor((low + i) / 8)] |= 1 << ((low + i) % 8);
	const crc = crc32Pdu(d, N - 4);
	d.set([crc >>> 24, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255], N - 4);
	const h = new Uint8Array(12);
	h.set([fmt, sap, 0, (src >> 16) & 255, (src >> 8) & 255, src & 255, nDataBlocks, op]);
	return [h, ...Array.from({ length: nDataBlocks }, (_, k) => d.slice(12 * k, 12 * k + 12))];
}

const A = (...parts) => parts.reduce((a, [v, at]) => a | (BigInt(v) << BigInt(at)), 0n);

describe('P25 control messages (OnAir test_p25_cc)', () => {
	it('patches, affiliation, registration, deny, queue, acknowledge, data grants', () => {
		expect(tsbkDescribe(0x90, 0x00, A([1000, 48], [1001, 32], [1002, 16]))).toMatchObject({
			kind: 'patch-add',
			supergroup: 1000,
			members: [1001, 1002],
		});
		expect(tsbkDescribe(0x90, 0x01, A([1000, 48], [1001, 32]))).toMatchObject({ kind: 'patch-del', members: [1001] });
		expect(tsbkDescribe(0x90, 0x02, A([0x2064, 40], [1000, 24], [1234567, 0]))).toMatchObject({
			kind: 'patch-grant',
			channel: 0x2064,
			supergroup: 1000,
			unit: 1234567,
		});
		expect(tsbkDescribe(0xa4, 0x30, A([1, 62], [1, 61], [2000, 40], [5, 16], [2001, 0]))).toMatchObject({
			kind: 'patch-add',
			supergroup: 2000,
			members: [2001],
		});
		expect(tsbkDescribe(0, 0x28, A([345, 40], [7002, 24], [1234567, 0]))).toMatchObject({
			kind: 'affiliation',
			accepted: true,
			tg: 7002,
			unit: 1234567,
		});
		expect(tsbkDescribe(0, 0x28, A([1, 56], [7002, 24], [1234567, 0]))).toMatchObject({ accepted: false });
		expect(tsbkDescribe(0, 0x2c, A([0xab1, 48], [1234567, 24], [1, 0]))).toMatchObject({
			kind: 'registration',
			accepted: true,
			unit: 1234567,
		});
		expect(tsbkDescribe(0, 0x2c, A([1, 60], [1234567, 24], [1, 0]))).toMatchObject({ accepted: false });
		const deny = tsbkDescribe(0, 0x27, A([0x31, 48], [1234567, 0]));
		expect(deny).toMatchObject({ kind: 'deny', reason: 0x31 });
		expect(deny.text).toContain('not authorised');
		expect(tsbkDescribe(0, 0x21, A([0x40, 48], [7, 0])).text).toContain('channel resources');
		expect(tsbkDescribe(0, 0x20, A([0x28, 56], [7, 0])).text).toContain('group affiliation');
		expect(tsbkDescribe(0, 0x14, A([0x2064, 40], [0x2065, 24], [99, 0]))).toMatchObject({ kind: 'data-grant', channel: 0x2064 });
		// a voice grant is the receiver's own business
		expect(tsbkDescribe(0, 0x00, 1n)).toBeNull();
		expect(tsbkDescribe(0x90, 0x10, 1n)).toBeNull();
		expect(tsbkDescribe(0xc0, 0x00, 1n)).toBeNull();
	});

	it('MBT: group voice grant, RFSS and network status, regroup grant, affiliation; a bad CRC or another SAP gives nothing', () => {
		let out = mbtToTsbks(
			mbt(0x17, 61, 1234567, 0x00, 1, [
				[64, 16, 0x2064],
				[32, 16, 7002],
			]),
		);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ opcode: OP_GRP_V_GRANT, args: A([0x2064, 40], [7002, 24], [1234567, 0]) });
		out = mbtToTsbks(
			mbt(0x17, 61, 0x0abc, 0x3a, 1, [
				[88, 8, 5],
				[80, 8, 3],
				[64, 16, 0x2010],
			]),
		);
		expect(out[0]).toMatchObject({ opcode: OP_RFSS_STS, args: A([0xabc, 40], [5, 32], [3, 24], [0x2010, 8]) });
		out = mbtToTsbks(
			mbt(0x17, 61, 0x0abc, 0x3b, 1, [
				[76, 20, 0xbee00],
				[56, 16, 0x2010],
			]),
		);
		expect(out[0]).toMatchObject({ opcode: OP_NET_STS, args: A([0xbee00, 36], [0xabc, 24], [0x2010, 8]) });
		out = mbtToTsbks(
			mbt(0x17, 61, 77, 0x02, 2, [
				[168, 8, 0x90],
				[80, 16, 0x2064],
				[48, 16, 1000],
			]),
		);
		expect(out[0]).toMatchObject({ mfid: 0x90, opcode: 2 });
		expect(out[0].args & 0xffffffn).toBe(77n);
		out = mbtToTsbks(
			mbt(0x17, 61, 77, 0x28, 2, [
				[120, 2, 0],
				[144, 16, 345],
				[128, 16, 7002],
			]),
		);
		expect(tsbkDescribe(0, 0x28, out[0].args)).toMatchObject({ tg: 7002, unit: 77 });
		const bad = mbt(0x17, 61, 1, 0x00, 1, [[64, 16, 1]]);
		bad[1][0] ^= 1;
		expect(mbtToTsbks(bad)).toBeNull();
		expect(mbtToTsbks(mbt(0x15, 4, 1, 0x00, 1, []))).toBeNull();
		expect(mbtToTsbks([Uint8Array.of(1, 2, 3)])).toBeNull();
	});

	it('unconfirmed data: IPv4 in SAP 4 with padding; a bad CRC', () => {
		const ip = [0x45, 0, 0, 32, 0, 0, 0, 0, 64, 17, 0, 0, 10, 0, 0, 1, 10, 0, 0, 2, 0x10, 0x01, 0x0f, 0xa1, 0, 12, 0, 0, 104, 105, 33, 33];
		const pad = 12 - ((ip.length + 4) % 12);
		const whole = new Uint8Array(ip.length + (pad < 12 ? pad : 0) + 4);
		whole.set(ip);
		const crc = crc32Pdu(whole, whole.length - 4);
		whole.set([crc >>> 24, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255], whole.length - 4);
		const h = new Uint8Array(12);
		h.set([0x35, 4, 0, 0, 0, 77, whole.length / 12, pad < 12 ? pad : 0]);
		const pdu = [h, ...Array.from({ length: whole.length / 12 }, (_, k) => whole.slice(12 * k, 12 * k + 12))];
		const pd = pduAssemble(pdu);
		expect(pd).toMatchObject({ sap: 4, llid: 77, outbound: true });
		expect(pd.payload).toHaveLength(ip.length);
		expect(pd.summary).toContain('10.0.0.1 to 10.0.0.2');
		expect(pd.summary).toContain('ports 4097 to 4001');
		pdu[1][3] ^= 0x40;
		expect(pduAssemble(pdu)).toBeNull();
	});

	it('random TSBK arguments and blocks: no crash', () => {
		for (let i = 0; i < 20000; i++) tsbkDescribe(rnd() & 0xff, rnd() & 0x3f, (BigInt(rnd()) << 40n) ^ BigInt(rnd()));
		for (let i = 0; i < 2000; i++) {
			const b = Array.from({ length: 1 + (rnd() % 6) }, () => Uint8Array.from({ length: 12 }, () => rnd() & 255));
			b[0][1] = 61;
			b[0][0] = rnd() & 1 ? 0x17 : 0x15;
			mbtToTsbks(b);
			pduAssemble(b);
		}
	});
});
