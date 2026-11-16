// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir tests/hfdig/test_hfdig_ftx_tables.cpp (the FT8 / FT4 / WSPR
// tables against values quoted from WSJT-X, the LDPC code against its parity checks, lookup3's published values, the
// 77-bit and WSPR messages packed and unpacked), https://github.com/adswill/OnAir; see third_party/onair. Changes: a
// few more messages (contest, free text, telemetry).
import { describe, expect, it } from 'vitest';
import { checkCrc, encode174, ldpcDecode, osdDecode } from '@/worker/decoders/digimode/ftx/ldpc';
import { CallHash, pack77 } from '@/worker/decoders/digimode/ftx/pack';
import {
	FT4_COSTAS,
	FT4_GRAY,
	FT4_RVEC,
	FT8_COSTAS,
	FT8_GRAY,
	LDPC_GEN,
	LDPC_MN,
	LDPC_NM,
	LDPC_NUM_ROWS,
	WSPR_SYNC,
} from '@/worker/decoders/digimode/ftx/tables';
import { callAndGrid, gridToLatLon, unpack77 } from '@/worker/decoders/digimode/ftx/unpack';
import { nhash, wsprConvEncode, wsprDeinterleave, wsprInterleave, wsprPack, wsprUnpack } from '@/worker/decoders/digimode/wspr/codec';
import { wsprFano } from '@/worker/decoders/digimode/wspr/fano';
import { watts } from '@/worker/decoders/digimode/wspr';

// WSJT-X ldpc_174_91_c_generator.f90: characters 1-6 and 18-23 of each of the 83 hex rows
const WSJT_ROW_ENDS =
	'8329ce..9f27fc 761c26..493132 dc2659..0a1bdc 1b3f41..ec7f62 09fda4..34783a 077ccc..c3d48a 29b62a..e1a9da 6054fa..0c8c3e ' +
	'e20798..84ae90 775c9c..e56318 b0b811..13487c 18a0c9..c5ea32 76471e..1b12b8 ffbccb..b47b2e 66a72a..f67170 c42436..363a18 ' +
	'0dff73..b1c270 15b488..94972e 29a89c..489b0e 4f126f..bd6b94 99c472..4e0940 1919b7..b4f1e8 09db12..6df6b8 488fc3..4eafb4 ' +
	'827423..6eb5fe abe197..144a9a 2b500e..bdbdd0 c474aa..669360 8eba1a..718cec 753844..42012e 06ff83..5c1268 3b3741..ec3f62 ' +
	'9a4a5a..24842c bc29f4..9610a4 2663ae..b29488 46f231..814418 3fb2ce..e06fbe de8748..1a0a2e fcd7cc..ba1412 f02614..474cec ' +
	'441011..dd7012 088fc3..4eafb4 b8fef1..a078c0 5afea7..d99a90 49a701..dc9076 1944d0..6cc7d0 251f62..714002 56471f..0b12b8 ' +
	'2b8e49..537fa0 6b550a..e95c26 a18ad2..4f6c84 10c2e5..d80758 ef34a4..db2eb0 7e9c0c..36e000 3693e5..079e86 bfb2ce..e07fbe ' +
	'7ee182..7d4b08 a066cb..664126 bb2372..cc4cd2 ded9db..5609b4 d9a701..dc9036 9ad46a..ab5fc4 e5921c..d7d3c2 4f14da..a73352 ' +
	'8b8b50..df770e 22831c..d04b68 213b83..ee7180 5d926b..1a4e12 66ab79..509e56 958148..d68baa b8ce02..23ab14 f4331d..752746 ' +
	'6da23b..3cf9c8 a636bc..ae67fe 5cb0d8..089a20 f11f10..cdd80a 1fbb53..30d5ba fcb86b..a5d034 a53443..22e34c c989d9..d75130 ' +
	'7bb38b..3ae962 2644eb..d1f42c 608cc8..d69600';
// WSJT-X genft4.f90 rvec; wsprsim_utils.c / wsprd.c pr3 (also JTEncode's sync vector)
const RVEC = '01001010010111101000100110110100101100001000101001111001010101011011111000101';
const SYNC =
	'110000001000111000100101111000000010010100000010110011010001101000011010101010010010110001101010001000001001001110110011010001110000010100110000000110101100011000';

function lcg(seed) {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s >>> 8;
	};
}

describe('FT8 / FT4 / WSPR tables', () => {
	it('match the values of WSJT-X', () => {
		const hex = (r) => Array.from(LDPC_GEN.subarray(12 * r, 12 * r + 12), (b) => b.toString(16).padStart(2, '0')).join('');
		const ends = Array.from({ length: 83 }, (_, r) => `${hex(r).slice(0, 6)}..${hex(r).slice(17, 23)}`);
		expect(ends.join(' ')).toBe(WSJT_ROW_ENDS);
		for (let r = 0; r < 83; r++) expect(LDPC_GEN[12 * r + 11] & 0x1f).toBe(0);
		expect(Array.from(FT4_RVEC).join('')).toBe(RVEC);
		expect(Array.from(FT8_COSTAS)).toEqual([3, 1, 4, 0, 6, 5, 2]);
		expect(Array.from(FT8_GRAY)).toEqual([0, 1, 3, 2, 5, 6, 4, 7]);
		expect(FT4_COSTAS.map((c) => Array.from(c))).toEqual([
			[0, 1, 3, 2],
			[1, 0, 2, 3],
			[2, 3, 1, 0],
			[3, 2, 0, 1],
		]);
		expect(Array.from(FT4_GRAY)).toEqual([0, 1, 3, 2]);
		expect(Array.from(WSPR_SYNC).join('')).toBe(SYNC);
	});

	it('has the parity checks as the transpose of the check lists', () => {
		for (let m = 0; m < 83; m++) {
			const bits = Array.from(LDPC_NM.subarray(7 * m, 7 * m + 7)).filter(Boolean);
			expect(bits).toHaveLength(LDPC_NUM_ROWS[m]);
			for (const b of bits) expect(Array.from(LDPC_MN.subarray(3 * (b - 1), 3 * b))).toContain(m + 1);
		}
	});
});

describe('the (174,91) LDPC code and its CRC', () => {
	it('makes codewords that satisfy every check and decodes them over noise at Eb/N0 3 dB', () => {
		const rnd = lcg(7);
		let decoded = 0;
		for (let t = 0; t < 50; t++) {
			const m = Uint8Array.from({ length: 77 }, () => rnd() & 1);
			const cw = new Uint8Array(174);
			encode174(m, cw);
			for (let r = 0; r < 83; r++) {
				let x = 0;
				for (let k = 0; k < LDPC_NUM_ROWS[r]; k++) x ^= cw[LDPC_NM[7 * r + k] - 1];
				expect(x).toBe(0);
			}
			expect(checkCrc(cw)).toBe(true);
			const sig = 0.69;
			const llr = Float64Array.from(cw, (bit) => {
				let g = 0;
				for (let k = 0; k < 12; k++) g += (rnd() & 0xffff) / 65536;
				return (2 * ((bit ? 1 : -1) + sig * (g - 6))) / (sig * sig);
			});
			const dec = new Uint8Array(174);
			if (ldpcDecode(llr, 40, dec) === 0 && dec.every((b, i) => b === cw[i])) decoded++;
		}
		expect(decoded).toBeGreaterThanOrEqual(45);
	});

	it('recovers by ordered statistics a codeword with 14 weak wrong bits', () => {
		const b77 = new Uint8Array(77);
		pack77('K1ABC W9XYZ -12', b77);
		const cw = new Uint8Array(174);
		encode174(b77, cw);
		const rnd = lcg(99);
		const llr = Float64Array.from(cw, (bit) => (bit ? 1 : -1) * (0.3 + (2.5 * rnd()) / 16777216));
		for (let e = 0; e < 14; e++) {
			const i = (e * 53 + 11) % 174;
			llr[i] = (cw[i] ? -1 : 1) * 0.2;
		}
		const got = new Uint8Array(174);
		const st = { hardErrors: 0, dist: 0, margin: 0 };
		expect(osdDecode(llr, 40, got, st)).toBe(true);
		expect(Array.from(got)).toEqual(Array.from(cw));
		expect(st.hardErrors).toBe(14);
	});
});

describe('77-bit messages', () => {
	const roundTrip = (text, hash = new CallHash()) => {
		const b = new Uint8Array(77);
		expect(pack77(text, b), text).toBe(true);
		return unpack77(b, hash);
	};

	it('pack and unpack back to the same text', () => {
		const hash = new CallHash();
		const msgs = [
			'CQ K1ABC FN42',
			'K1ABC W9XYZ -12',
			'W9XYZ K1ABC R-05',
			'K1ABC W9XYZ RR73',
			'K1ABC W9XYZ 73',
			'K1ABC W9XYZ RRR',
			'CQ DX K1ABC FN42',
			'CQ 123 K1ABC FN42',
			'K1ABC/R W9XYZ EN37',
			'K1ABC W9XYZ/P R JO62',
			'QRZ W9XYZ EN37',
			'K1ABC W9XYZ +07',
			'K1ABC W9XYZ -45',
			'CQ PJ4/K1ABC',
			'TNX BOB 73 GL',
			'7123456789ABCDEF01',
			'DE W9XYZ',
			'CQ 3DA0XYZ KG53',
			'K1ABC W9XYZ R EN37',
			'CQ TEST DL1XYZ JO62',
			'G4ABC DL1XYZ RR73',
			// contest messages: ARRL Field Day, RTTY Roundup
			'WA9XYZ KA1ABC R 16A EMA',
			'K1ABC W9XYZ 3B WMA',
			'TU; W9XYZ K1ABC R 579 MA',
			'W9XYZ K1ABC 579 0012',
		];
		for (const m of msgs) expect(roundTrip(m, hash)).toBe(m);
	});

	it('sends free text and telemetry, and refuses what does not fit', () => {
		expect(roundTrip('hello world')).toBe('HELLO WORLD');
		expect(roundTrip('73 GL')).toBe('73 GL');
		expect(roundTrip('0000000000000000AB')).toBe('AB');
		expect(pack77('THIS IS TOO LONG TO SEND', new Uint8Array(77))).toBe(false);
		expect(pack77('', new Uint8Array(77))).toBe(false);
	});

	it('shows hashed calls by name once heard, <...> before', () => {
		const hash = new CallHash();
		const b = new Uint8Array(77);
		pack77('CQ PJ4/K1ABC', b);
		unpack77(b, hash);
		pack77('<PJ4/K1ABC> W9XYZ RR73', b);
		expect(unpack77(b, hash)).toBe('<PJ4/K1ABC> W9XYZ RR73');
		expect(unpack77(b, new CallHash())).toBe('<...> W9XYZ RR73');
		expect(CallHash.hash22('PJ4/K1ABC')).toBeLessThan(1 << 22);
	});

	it('name the calling station and its grid', () => {
		const cases = [
			['CQ K1ABC FN42', 'K1ABC', 'FN42'],
			['CQ DX K1ABC FN42', 'K1ABC', 'FN42'],
			['W9XYZ K1ABC R FN42', 'K1ABC', 'FN42'],
			['W9XYZ K1ABC -12', 'K1ABC', ''],
			['K1ABC RR73; W9XYZ <KH1/KH7Z> -08', 'KH1/KH7Z', ''],
			['K1ABC RR73; W9XYZ <...> -08', '', ''],
		];
		for (const [m, call, grid] of cases) expect(callAndGrid(m)).toEqual([call, grid]);
		expect(gridToLatLon('JO62')).toEqual([52.5, 13]);
		expect(gridToLatLon('XX99')).toBeNull();
	});
});

describe('WSPR messages and code', () => {
	it('hashes as lookup3 hashlittle() (published values)', () => {
		const bytes = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
		expect(nhash(bytes(''), 0)).toBe(0xdeadbeef);
		expect(nhash(bytes('Four score and seven years ago'), 0)).toBe(0x17770551);
		expect(nhash(bytes('Four score and seven years ago'), 1)).toBe(0xcd628161);
	});

	it('packs types 1, 2 and 3, and decodes them through the code with errors', () => {
		const table = new Map();
		for (const m of ['K1ABC FN42 37', 'G4XYZ IO91 23', 'PJ4/K1ABC 30', 'DL1XYZ/P 10', 'K1ABC/12 33', '<K1ABC> FN42AX 37']) {
			const d = new Uint8Array(7);
			expect(wsprPack(m, d), m).toBe(true);
			const [text, dbm] = wsprUnpack(d, table);
			expect(text).toBe(m);
			expect(dbm).toBe(Number(m.split(' ').at(-1)));
			const coded = new Uint8Array(162);
			const ch = new Uint8Array(162);
			wsprConvEncode(d, coded);
			wsprInterleave(coded, ch);
			const llr = Float64Array.from(ch, (c) => (c ? 3 : -3));
			for (let e = 0; e < 10; e++) llr[(e * 37 + 5) % 162] *= -1;
			const dl = new Float64Array(162);
			wsprDeinterleave(llr, dl);
			const back = new Uint8Array(7);
			expect(wsprFano(dl, back, 100000)).toBe(true);
			expect(Array.from(back)).toEqual(Array.from(d));
		}
		expect(wsprPack('K1ABC FN42 38', new Uint8Array(7))).toBe(false);
		expect(watts(37)).toBe('5 W');
		expect(watts(23)).toBe('200 mW');
	});
});
