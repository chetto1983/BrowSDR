// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR from OnAir tests/dmr/test_dmr_fec.cpp (testShortCodes, testHamming, testBptc,
// testReedSolomon, testCrc, testEmbedded, testShortLc, testCach, testTrellis, testRate1) and
// rust/onair_dmr/src/tests.rs (slot_type_round_trip, sync_patterns_match_themselves, bptc_trellis_round_trip,
// hamming_corrects_one_bit, csbk_and_data_header_round_trip), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the exhaustive loops are sampled more sparsely; the random numbers are a small xorshift generator.
//
// DMR codes against known answers: the worked idle message of TS 102 361-1 annex D, the generator matrices of annex B,
// and values OnAir took from bursts captured off the air (published as test vectors by the ok-dmrlib project,
// https://github.com/OK-DMR/ok-dmrlib).
import { describe, expect, it } from 'vitest';
import * as C from '@/worker/decoders/dsd/dmr/codes';
import * as P from '@/worker/decoders/dsd/dmr/product';
import { makeDataBurst, matchSyncDibits, SYNC_WORDS } from '@/worker/decoders/dsd/dmr/burst';
import { csbkInfo, csbkParse } from '@/worker/decoders/dsd/dmr/lc';
import * as D from '@/worker/decoders/dsd/dmr/data';
import { randomBits } from '../voice-fixtures.js';

const hex = (s) => Uint8Array.from({ length: s.length >> 1 }, (_, i) => parseInt(s.slice(2 * i, 2 * i + 2), 16));
const bitsOf = (s) => Uint8Array.from(s.replace(/[^01]/g, ''), Number);
const H = { H1393: 0, H15113: 1, H16114: 2, H17123: 3 };

function rng(seed) {
	let s = seed >>> 0 || 1;
	return () => {
		s ^= s << 13;
		s ^= s >>> 17;
		s ^= s << 5;
		return s >>> 0;
	};
}
function gaussian(next) {
	const u = (next() + 1) / 4294967297;
	const v = next() / 4294967296;
	return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

describe('DMR short codes', () => {
	it('corrects every slot type with up to three errors and knows a captured parity', () => {
		expect(C.golay2008Parity((5 << 4) | 3)).toBe(0xf2b);
		for (let cc = 0; cc < 16; cc++)
			for (let dt = 0; dt < 16; dt++) {
				const info = (cc << 4) | dt;
				expect(C.golay2008Decode(((info << 12) | C.golay2008Parity(info)) ^ 0b101)).toEqual([2, info]);
			}
		for (let info = 0; info < 256; info += 37) {
			const w = (info << 12) | C.golay2008Parity(info);
			for (let a = 0; a < 20; a += 2)
				for (let b = a; b < 20; b += 3)
					for (let c = b; c < 20; c += 5) {
						let x = w ^ (1 << a);
						if (b !== a) x ^= 1 << b;
						if (c !== b) x ^= 1 << c;
						expect(C.golay2008Decode(x)?.[1]).toBe(info);
					}
		}
		const next = rng(5);
		let clean = 0;
		for (let i = 0; i < 2000; i++) if (C.golay2008Decode(next() & 0xfffff)?.[0] === 0) clean++;
		expect(clean).toBeLessThan(10);
	});
	it('matches the EMB parities of a captured call and corrects two errors', () => {
		const lcss = [1, 3, 3, 2, 0];
		const want = [0x191, 0x174, 0x174, 0x107, 0x1e2];
		lcss.forEach((l, i) => {
			const info7 = (1 << 3) | l;
			expect(C.qr1676Parity(info7)).toBe(want[i]);
			const w = (info7 << 9) | want[i];
			for (let a = 0; a < 16; a++)
				for (let b = a; b < 16; b++) expect(C.qr1676Decode(w ^ (1 << a) ^ (b !== a ? 1 << b : 0))?.[1]).toBe(info7);
		});
	});
	it('corrects one TACT error and matches the OP25 / MMDVM Hamming (7,4) words', () => {
		const ham = [0, 11, 22, 29, 39, 44, 49, 58, 69, 78, 83, 88, 98, 105, 116, 127];
		for (let info = 0; info < 16; info++) {
			expect((info << 3) | C.hamming743Parity(info)).toBe(ham[info]);
			for (let a = 0; a < 7; a++) expect(C.hamming743Decode(ham[info] ^ (1 << a))).toEqual([1, info]);
		}
	});
	it('corrects one bit with each block product Hamming code and notices two errors', () => {
		for (const k of [H.H1393, H.H15113, H.H16114, H.H17123]) {
			const ki = C.hammingInfoBits(k);
			const p = C.hammingParityBits(k);
			for (let info = 0; info < 1 << ki; info += ki > 9 ? 13 : 1) {
				const w = (info << p) | C.hammingParity(k, info);
				expect(C.hammingCorrect(k, w)).toEqual([0, w]);
				for (let a = 0; a < ki + p; a++) {
					expect(C.hammingCorrect(k, w ^ (1 << a))).toEqual([1, w]);
					for (let b = a + 1; b < ki + p; b += 3) {
						const e = C.hammingCorrect(k, w ^ (1 << a) ^ (1 << b))[0];
						if (k === H.H16114) expect(e).toBe(-1);
						else expect(e).not.toBe(0);
					}
				}
			}
		}
	});
});

describe('DMR block product codes', () => {
	it('encodes the annex D idle message as the specification and a captured idle burst', () => {
		const info = C.bytesToBits(hex('FF83DF1732094ED1E7CD8A91'));
		const tx = P.bptc196Encode(info);
		expect(Array.from(tx).join('')).toBe(
			'0101001111000010010111101010101110101000011001110001110111000111001110000011101111011001001101100011111101101110010001100101000101' +
				'110001101101001000110010100110110101001111110001100001000010110100',
		);
		expect(Array.from(tx.subarray(0, 96))).toEqual(Array.from(C.bytesToBits(hex('53C25EABA8671DC7383BD936'))));
		expect(P.bptc196Decode(tx)).toEqual([0, info]);
	});
	it('corrects scattered errors and refuses a 40 bit burst error', () => {
		const next = rng(11);
		let fixed = 0;
		let wrong = 0;
		for (let trial = 0; trial < 200; trial++) {
			const d = Uint8Array.from({ length: 96 }, () => next() & 1);
			const e = P.bptc196Encode(d);
			for (let i = 0, n = 1 + (next() % 3); i < n; i++) e[next() % 196] ^= 1;
			const [r, out] = P.bptc196Decode(e);
			if (r >= 0 && out.every((b, i) => b === d[i])) fixed++;
			else if (r >= 0) wrong++;
		}
		expect(fixed).toBeGreaterThanOrEqual(190);
		expect(wrong).toBeLessThan(5);
		const d = Uint8Array.from({ length: 96 }, () => next() & 1);
		const t = P.bptc196Encode(d);
		for (let i = 20; i < 60; i++) t[i] ^= 1;
		const [r, out] = P.bptc196Decode(t);
		expect(r >= 0 && out.every((b, i) => b === d[i])).toBe(false);
	});
	it('decodes captured embedded LCs, re-encodes them and repairs a wrong bit per fragment', () => {
		const frags = ['0A00030A', '170A0605', '0C112200', '05223F3A'].map((h) => C.bytesToBits(hex(h)));
		const [e, lc] = P.embLcDecode(frags);
		expect(e).toBe(0);
		expect(Array.from(lc)).toEqual(Array.from(hex('00000000086520baf8')));
		P.embLcEncode(lc).forEach((f, i) => expect(Array.from(f)).toEqual(Array.from(frags[i])));
		const vectors = [
			['0300030a0f0006060f033a030c393530', '00000000000620baef'],
			['03000a03060906060f03030a05000c09', '00000000000920baef'],
			['0a00030a170906060f12110305120f0a', '00000000086520baef'],
			['09001d17271e81b730060c9a9a8e09b1', '0300002635a903d475'],
		];
		for (const [h, want] of vectors) {
			const all = C.bytesToBits(hex(h));
			const f = [0, 1, 2, 3].map((i) => all.slice(i * 32, i * 32 + 32));
			expect(Array.from(P.embLcDecode(f)[1])).toEqual(Array.from(hex(want)));
			f.forEach((x, i) => (x[(i * 7 + 3) % 32] ^= 1));
			const [e2, lc2] = P.embLcDecode(f);
			expect(e2).toBeGreaterThanOrEqual(1);
			expect(Array.from(lc2)).toEqual(Array.from(hex(want)));
		}
	});
	it('decodes captured activity updates of the CACH short LC and the null message', () => {
		const vectors = [
			'00000000000010010000000000000011000000110011000010011001101000000000',
			'00110000001110010011000000110000010101011010111111110101011010101001',
		];
		for (const v of vectors) {
			const all = bitsOf(v);
			const p = [0, 1, 2, 3].map((i) => all.slice(i * 17, i * 17 + 17));
			const [e, lc] = P.shortLcDecode(p);
			expect(e).toBe(0);
			expect(lc >> 24).toBe(1);
			P.shortLcEncode(lc).forEach((q, i) => expect(Array.from(q)).toEqual(Array.from(p[i])));
		}
		expect(P.shortLcDecode([0, 1, 2, 3].map(() => new Uint8Array(17)))).toEqual([0, 0]);
	});
	it('places the TACT and payload bits of the CACH as OP25 and MMDVM do', () => {
		const ham = [0, 11, 22, 29, 39, 44, 49, 58, 69, 78, 83, 88, 98, 105, 116, 127];
		const tactPos = [0, 4, 8, 12, 14, 18, 22];
		const payPos = [1, 2, 3, 5, 6, 7, 9, 10, 11, 13, 15, 16, 17, 19, 20, 21, 23];
		const pay = 0x1a5c3;
		for (let at = 0; at < 2; at++)
			for (let tc = 0; tc < 2; tc++)
				for (let ls = 0; ls < 4; ls++) {
					const c = P.cachEncode(at, tc, ls, pay);
					const tact = ham[(at << 3) | (tc << 2) | ls];
					tactPos.forEach((pos, i) => expect(c[pos]).toBe((tact >> (6 - i)) & 1));
					payPos.forEach((pos, i) => expect(c[pos]).toBe((pay >> (16 - i)) & 1));
					expect(P.cachDecode(c)).toEqual({ at, tc, lcss: ls, errors: 0, payload17: pay });
					const d = c.slice();
					d[8] ^= 1;
					expect(P.cachDecode(d)).toMatchObject({ at, tc, lcss: ls, errors: 1 });
				}
	});
	it('encodes and decodes captured rate 3/4 payloads, also with noise', () => {
		const vectors = [
			[
				'0010100000101111111000101011010111010010111111110010001011100010011101100010111100111110110100100111001000101110111110100001001000' +
					'100010011100101111101100101111001000101001011100100010111101110010',
				'006200014100480019804a00200054004100',
			],
			[
				'0010010011110110110100100011111111100010001101010010001000010010101011101101001001111111110100100110100011100010111100100001001011' +
					'111010111000101111000001111000001000100100011100101111100001110010',
				'02f24400590020004d004100520045004b00',
			],
		];
		const next = rng(9);
		for (const [bits, data] of vectors) {
			const d = hex(data);
			const tx = P.trellis34Encode(d);
			expect(Array.from(tx).join('')).toBe(bits);
			const sym = Float32Array.from({ length: 98 }, (_, k) => P.dibitToSymbol((tx[2 * k] << 1) | tx[2 * k + 1]));
			expect(P.trellis34Decode(sym)).toEqual([0, d]);
			let ok = 0;
			for (let trial = 0; trial < 50; trial++) {
				const [e, out] = P.trellis34Decode(sym.map((s) => s + 0.55 * gaussian(next)));
				if (e >= 0 && out.every((b, i) => b === d[i])) ok++;
			}
			expect(ok).toBeGreaterThanOrEqual(40);
		}
		expect(P.trellis34Decode(new Float32Array(98).fill(3))[0]).not.toBe(0);
	});
	it('keeps the rate 1 bit order of table B.10B', () => {
		const d = Uint8Array.from({ length: 24 }, (_, i) => (i * 17 + 3) & 0xff);
		const tx = P.rate1Encode(d);
		expect(P.rate1Decode(tx)).toEqual({ data: d, padOk: true });
		expect([tx[0], tx[100], tx[99], tx[195]]).toEqual([d[0] >> 7, d[12] >> 7, 0, d[23] & 1]);
	});
});

describe('DMR checksums and Reed-Solomon', () => {
	it('matches captured header and terminator parity and corrects one wrong symbol', () => {
		const vectors = [
			['0300002635a903d475cb8795', 0x96],
			['03000003d4752635a96fed09', 0x96],
			['03000003d4752635a960e206', 0x99],
			['0300002635a903d475c4889a', 0x99],
		];
		for (const [h, mask] of vectors) {
			const w = hex(h);
			expect(C.rs129Parity(w)).toEqual([w[9] ^ mask, w[10] ^ mask, w[11] ^ mask]);
			for (let i = 9; i < 12; i++) w[i] ^= mask;
			expect(C.rs129Correct(w.slice())).toBe(0);
			for (let pos = 0; pos < 12; pos++) {
				const x = w.slice();
				x[pos] ^= 0x31 + pos;
				expect(C.rs129Correct(x)).toBe(1);
				expect(x).toEqual(w);
			}
			const x = w.slice();
			x[1] ^= 0x55;
			x[7] ^= 0x0f;
			expect(C.rs129Correct(x)).not.toBe(0);
		}
		const rows = [
			[0x1c, 0xbc, 0xfd],
			[0x89, 0x31, 0x08],
			[0xad, 0x41, 0x36],
			[0x7d, 0x71, 0x16],
			[0xf3, 0xa6, 0x3a],
			[0x08, 0x83, 0x7b],
			[0x3f, 0x6f, 0x02],
			[0x6c, 0x0d, 0xa7],
			[0x0e, 0x38, 0x40],
		];
		rows.forEach((row, i) => expect(C.rs129Parity(Uint8Array.from({ length: 9 }, (_, k) => (k === i ? 1 : 0)))).toEqual(row));
	});
	it('matches captured CRC-CCITT, message CRC-32 and CRC-9 values and the embedded LC checksum', () => {
		const headers = [
			'8DA300000100000101002B97',
			'8DA30000010008350100B731',
			'4DA123386323383B05005757',
			'023A2337FC2337FE820081A3',
			'434E2337FE2337FC84781BD1',
		];
		for (const h of headers) {
			const b = hex(h);
			expect(C.crcCcitt(b, 10) ^ 0xcccc).toBe((b[10] << 8) | b[11]);
		}
		expect(C.crcCcitt(hex('BD00801D23386323383B5889'), 10) ^ 0xa5a5).toBe(0x5889);
		expect(C.crcCcitt(hex('211003D537D57A0000092B13'), 10) ^ 0x6969).toBe(0x2b13);
		const messages = [
			['d6790062620003bf000700000000000000000000', '210b9a3d'],
			['45000038fb410000401125490c23380b0d0008fd0fa10fa10024276a0d1a22047fffffff694728710f0a522c2d82534e6c0048564770402b', '82616528'],
		];
		for (const [d, c] of messages) {
			const crc = hex(c);
			expect(C.crc32Msg(hex(d))).toBe((crc[0] | (crc[1] << 8) | (crc[2] << 16) | (crc[3] << 24)) >>> 0);
		}
		const crc9 = [
			['c11b621ad48b979117419eb172ebe0b8', 0x1ff, 173],
			['747ea34235ccc44a774b', 0x0f0, 69],
			['af12f44fde4b826afd58', 0x0f0, 84],
		];
		for (const [d, mask, want] of crc9) expect((C.crc9(hex(d), 1) ^ mask) & 0x1ff).toBe(want);
		expect(C.checksum5(hex('00000000086520baf8'))).toBe(17);
	});
});

describe('DMR bursts and blocks', () => {
	it('finds each sync pattern in its own dibits', () => {
		SYNC_WORDS.forEach((w, s) => {
			const dibits = Uint8Array.from({ length: 24 }, (_, i) => Math.floor(w / 2 ** (46 - 2 * i)) & 3);
			expect(matchSyncDibits(dibits, 0, 0xffff, 0)).toBe(s);
		});
		const burst = makeDataBurst(1, 3, randomBits(1, 196), 1);
		const dibits = Uint8Array.from({ length: 132 }, (_, i) => (burst[2 * i] << 1) | burst[2 * i + 1]);
		expect(matchSyncDibits(dibits, 54, 0xffff, 0)).toBe(1);
	});
	it('round-trips a CSBK and every data header format', () => {
		const c = { lb: true, pf: false, opcode: 0x26, fid: 0, data: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8) };
		const info = csbkInfo(c);
		expect(csbkParse(info)).toEqual(c);
		info[3] ^= 1;
		expect(csbkParse(info)).toBeNull();
		const headers = [
			{ dpf: D.DPF_CONFIRMED, sap: 4, group: true, dst: 1234, src: 4321, blocks: 5, pad: 3, fmf: true, fsn: 2, ns: 3 },
			{ dpf: D.DPF_UNCONFIRMED, sap: 4, dst: 99, src: 7, blocks: 2, pad: 17, fsn: 8 },
			{ dpf: D.DPF_SHORT_DEFINED, sap: 10, dst: 2145016, src: 2145007, blocks: 3, dd: 18, fmf: true, sarq: true, pad: 40 },
			{ dpf: D.DPF_SHORT_RAW, sap: 10, group: true, dst: 9, src: 1, blocks: 0, sp: 2, dp: 5, status: 0x2a7 },
		];
		for (const h of headers) {
			const full = { ...D.emptyDataHeader(h.dpf), ...h };
			expect(D.parseDataHeader(D.packDataHeader(full))).toEqual(full);
		}
		expect(D.parseDataHeader(Uint8Array.of(5, 0, 0, 0, 0, 0, 0, 0, 0, 0))).toBeNull();
	});
	it('round-trips confirmed and unconfirmed data blocks of every rate with their CRC-9', () => {
		for (const dt of [D.DT_RATE12, D.DT_RATE34, D.DT_RATE1])
			for (const confirmed of [false, true]) {
				const n = D.dataBlockBytes(dt, confirmed);
				const user = Uint8Array.from({ length: n }, (_, i) => (i * 29 + dt) & 0xff);
				const tx = D.dataBlockEncode(dt, user, confirmed, 77);
				let oct;
				if (dt === D.DT_RATE12) oct = C.bitsToBytes(P.bptc196Decode(tx)[1], 0, 96);
				else if (dt === D.DT_RATE34)
					oct = P.trellis34Decode(Float32Array.from({ length: 98 }, (_, k) => P.dibitToSymbol((tx[2 * k] << 1) | tx[2 * k + 1])))[1];
				else oct = P.rate1Decode(tx).data;
				const blk = D.dataBlockParse(dt, oct, confirmed);
				expect(blk).toEqual({ bytes: user, dbsn: confirmed ? 77 : 0, crcOk: true });
				if (confirmed) {
					oct[5] ^= 1;
					expect(D.dataBlockParse(dt, oct, true).crcOk).toBe(false);
				}
			}
	});
});
