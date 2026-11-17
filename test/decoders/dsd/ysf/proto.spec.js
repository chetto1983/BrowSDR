// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR from OnAir tests/fusion/test_fusion_proto.cpp, https://github.com/adswill/OnAir;
// see third_party/onair.
// Changes: vitest cases; std::mt19937 is replaced by a small xorshift generator.
//
// Yaesu Fusion frame coding: sync, dibit mapping, Golay, convolutional code, FICH with CRC, DCH units, V/D mode 2
// voice, whole frames of every data type, and error correction / detection.
import { describe, expect, it } from 'vitest';
import {
	convDecode,
	convEncode,
	crc16,
	dchDecode,
	dchEncode,
	deinterleaveDibits,
	dibitLevel,
	fichDecode,
	fichEncode,
	golay24,
	golay24Decode,
	interleaveDibits,
	levelDibit,
	padField,
	syncBits,
	syncLevels,
	trimField,
	vd2VoiceDecode,
	vd2VoiceEncode,
	whiten,
} from '@/worker/decoders/dsd/ysf/proto';
import { parseFrameBits } from '@/worker/decoders/dsd/ysf/frame';
import { baseParams, genTransmission } from './fixtures.js';

function rng(seed) {
	let s = seed >>> 0 || 1;
	return () => {
		s ^= s << 13;
		s ^= s >>> 17;
		s ^= s << 5;
		return s >>> 0;
	};
}

function popcount(v) {
	let n = 0;
	for (let x = v >>> 0; x; x &= x - 1) n++;
	return n;
}

describe('Yaesu Fusion frame coding (OnAir test_fusion_proto)', () => {
	it('sync word D471C9634D and the Table 3-1 dibit mapping', () => {
		const s = syncLevels();
		expect(Array.from(s.subarray(0, 4))).toEqual([-3, 3, 3, 1]);
		for (let d = 0; d < 4; d++) expect(levelDibit(dibitLevel(d))).toBe(d);
		expect([0, 1, 2, 3].map(dibitLevel)).toEqual([1, 3, -1, -3]);
		expect(syncBits()).toHaveLength(40);
	});
	it('Golay (24,12,8): minimum weight 8, three errors corrected', () => {
		let minw = 99;
		for (let d = 1; d < 4096; d++) minw = Math.min(minw, popcount(golay24(d)));
		expect(minw).toBe(8);
		const r = rng(7);
		let good = 0;
		for (let i = 0; i < 400; i++) {
			const d = r() & 0xfff;
			let w = golay24(d);
			for (let e = 0; e < 3; e++) w ^= 1 << (r() % 24); // up to three flips (two on the same bit cancel)
			const out = golay24Decode(w);
			if (out.ok && out.data === d) good++;
		}
		expect(good).toBe(400);
	});
	it('CRC-16: a flipped bit changes it, zeros give the inverted initial value', () => {
		const r = rng(11);
		const bits = Uint8Array.from({ length: 32 }, () => r() & 1);
		const c0 = crc16(bits, 32);
		bits[9] ^= 1;
		expect(crc16(bits, 32)).not.toBe(c0);
		expect(crc16(new Uint8Array(16), 16)).toBe(0xffff);
	});
	it('whitening PN(9,5) starts 1 0 0 1 and is its own inverse', () => {
		const w = new Uint8Array(40);
		whiten(w, 40);
		expect(Array.from(w.subarray(0, 4))).toEqual([1, 0, 0, 1]);
		whiten(w, 40);
		expect(w.every((b) => b === 0)).toBe(true);
	});
	it('convolutional code and its Viterbi decoder with errors', () => {
		const r = rng(13);
		const input = Uint8Array.from({ length: 100 }, (_, i) => (i < 96 ? r() & 1 : 0));
		const enc = convEncode(input);
		expect(enc).toHaveLength(200);
		expect(convDecode(enc)).toEqual({ bits: input, errors: 0 });
		enc[11] ^= 1;
		enc[60] ^= 1;
		enc[150] ^= 1;
		expect(convDecode(enc)).toEqual({ bits: input, errors: 3 });
	});
	it('interleaver: inverse, and read by columns', () => {
		const r = rng(17);
		const v = Uint8Array.from({ length: 200 }, () => r() & 1);
		expect(deinterleaveDibits(interleaveDibits(v, 5), 5)).toEqual(v);
		const v2 = Uint8Array.from({ length: 360 }, () => r() & 1);
		expect(deinterleaveDibits(interleaveDibits(v2, 9), 9)).toEqual(v2);
		const idx = new Uint8Array(200);
		for (let i = 0; i < 100; i++) {
			idx[2 * i] = (i >> 1) & 1;
			idx[2 * i + 1] = i & 1;
		}
		const il = interleaveDibits(idx, 5);
		expect([il[2], il[3]]).toEqual([idx[10], idx[11]]);
	});
	it('FICH: every field, error correction and no false CRC pass', () => {
		const f = { fi: 2, cs: 2, cm: 3, bn: 1, bt: 3, fn: 5, ft: 7, mr: 2, voip: 1, dt: 3, sqlOff: 0, sqlCode: 99 };
		const fe = fichEncode(f);
		expect(fe).toHaveLength(200);
		expect(fichDecode(fe)).toEqual({ fich: f, fixes: 0 });
		const r = rng(19);
		let fixedOk = 0;
		for (let t = 0; t < 200; t++) {
			const x = fe.slice();
			for (let e = 0; e < 8; e++) x[e * 25 + (r() % 25)] ^= 1;
			const g = fichDecode(x);
			if (g && g.fich.sqlCode === 99 && g.fich.dt === 3) fixedOk++;
		}
		expect(fixedOk).toBeGreaterThanOrEqual(195);
		let falseOk = 0;
		for (let t = 0; t < 500; t++) if (fichDecode(Uint8Array.from({ length: 200 }, () => r() & 1))) falseOk++;
		expect(falseOk).toBe(0);
	});
	it.each([20, 10])('DCH unit of %i bytes: clean, three errors, forty errors', (nb) => {
		const r = rng(23 + nb);
		const d = Uint8Array.from({ length: nb }, () => r() & 0xff);
		const e = dchEncode(d);
		expect(e).toHaveLength(nb === 20 ? 360 : 200);
		expect(dchDecode(e)?.bytes).toEqual(d);
		const x = e.slice();
		x[5] ^= 1;
		x[e.length >> 1] ^= 1;
		x[e.length - 3] ^= 1;
		expect(dchDecode(x)?.bytes).toEqual(d);
		for (let k = 0; k < 40; k++) x[r() % e.length] ^= 1;
		expect(dchDecode(x)).toBeNull();
	});
	it('V/D mode 2 voice: 49 bits through 104 and back; one flip is always outvoted', () => {
		const r = rng(29);
		const v49 = Uint8Array.from({ length: 49 }, () => r() & 1);
		const ve = vd2VoiceEncode(v49);
		expect(ve).toHaveLength(104);
		expect(vd2VoiceDecode(ve)).toEqual({ bits: v49, errors: 0 });
		let voted = 0;
		for (let i = 0; i < 104; i++) {
			const x = ve.slice();
			x[i] ^= 1;
			const out = vd2VoiceDecode(x).bits;
			if (v49.subarray(0, 27).every((b, k) => out[k] === b)) voted++;
		}
		expect(voted).toBe(104);
	});
	it.each([0, 1, 2, 3])('whole frames of data type %i from the generator round-trip', (dt) => {
		const p = baseParams({
			dt,
			commFrames: 9,
			src: 'LY1ABC',
			down: 'DB0XYZ',
			up: 'DB0XYZ',
			rem: ['12345', '', '', '67890'],
			slow: '55.0N 25.3E test',
		});
		const { bits, frames } = genTransmission(p);
		expect(bits).toHaveLength(frames.length * 960);
		const sync = syncBits();
		for (let k = 0; k < frames.length; k++) {
			const frame = bits.subarray(k * 960, (k + 1) * 960);
			expect(frame.subarray(0, 40)).toEqual(sync);
			const c = parseFrameBits(frame);
			expect(c).not.toBeNull();
			expect(c.fich.fi).toBe(frames[k].fich.fi);
			expect(c.fich.dt).toBe(dt);
			expect(c.fich.fn).toBe(frames[k].fich.fn);
			expect(c.units).toEqual(frames[k].units);
			expect(c.unitOk.every(Boolean)).toBe(true);
			expect(c.voice.map((v) => [v.kind, v.bytes])).toEqual(frames[k].voice.map((v) => [v.kind, v.bytes]));
		}
	});
	it('callsign field helpers', () => {
		const fld = padField('LY1ABC', 10);
		expect(trimField(fld, 0, 10)).toBe('LY1ABC');
		expect(fld[9]).toBe(0x20);
	});
});
