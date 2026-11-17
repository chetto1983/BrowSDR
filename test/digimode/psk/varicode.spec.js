// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir tests/psk/test_psk_proto.cpp (the varicode table: no "00" inside
// a code, every code different, the round trip of all 128 characters, a bad code; the K = 5 code and its Viterbi
// decoder clean, with soft noise and with hard errors; the QPSK mapping), https://github.com/adswill/OnAir; see
// third_party/onair. Changes: the noise is Gaussian from this suite's generator.

import { describe, expect, it } from 'vitest';
import { gauss } from './fixtures';
import { ConvEncoder, qpskSymbol, qpskTurns, varicode, varicodeBits, VaricodeRx, Viterbi } from '@/worker/decoders/digimode/psk/varicode';

function decodeBits(bits) {
	const rx = new VaricodeRx();
	let s = '';
	let bad = 0;
	for (const b of bits) {
		const c = rx.bit(b);
		if (c >= 0) s += String.fromCharCode(c);
		else if (c === -2) bad++;
	}
	return { s, bad };
}

describe('PSK31 protocol pieces (OnAir test_psk_proto)', () => {
	it('has 128 different codes, each starting and ending with a one, without "00"', () => {
		const codes = new Set();
		for (let c = 0; c < 128; c++) {
			const v = varicode(c);
			expect(v.length > 0 && v[0] === '1' && v.at(-1) === '1' && !v.includes('00'), `code ${c} ${v}`).toBe(true);
			codes.add(v);
		}
		expect(codes.size).toBe(128);
		expect([varicode(32), varicode(101)]).toEqual(['1', '11']);
	});

	it('round-trips every character and skips a bad code', () => {
		let all = '';
		for (let c = 1; c < 128; c++) all += String.fromCharCode(c);
		expect(decodeBits([0, 0, 0, 0, 0, 0, ...varicodeBits(all)]).s).toBe(all);
		const junk = [0, 0, ...new Array(13).fill(1), 0, 0, ...varicodeBits('OK')];
		expect(decodeBits(junk)).toEqual({ s: 'OK', bad: 1 });
	});

	it('maps the four QPSK symbols both ways', () => {
		for (let s = 0; s < 4; s++) expect(qpskSymbol(qpskTurns(s))).toBe(s);
	});

	it.each([0, 1, 2])('decodes the K = 5 code with Viterbi, trial %i', (trial) => {
		const msg = 'CQ CQ DE LY2ABC LY2ABC KO24 PSE K 0123456789';
		const input = [...new Array(20).fill(0), ...varicodeBits(msg), ...new Array(60).fill(0)];
		const enc = new ConvEncoder();
		const vit = new Viterbi();
		const g = gauss(5 + trial);
		const sd = trial === 0 ? 0 : 0.55;
		const out = [];
		let flipped = 0;
		input.forEach((bit, i) => {
			const sym = enc.encode(bit);
			let s0 = (sym & 1 ? 1 : -1) + sd * g();
			const s1 = (sym & 2 ? 1 : -1) + sd * g();
			if (trial === 2 && i % 23 === 7) {
				s0 = -s0; // hard errors, spread out
				flipped++;
			}
			const b = vit.decode(s0, s1);
			if (b >= 0) out.push(b);
		});
		expect(decodeBits(out).s).toBe(msg);
		if (trial === 2) expect(flipped).toBeGreaterThan(10);
	});
});
