// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir tests/cw/test_cw_morse.cpp (the code table, the aliases, an
// unknown code, callsigns; perfect keying from 5 to 50 WPM, Farnsworth spacing, hand keying, a change of speed) and
// tests/cw/test_cw_fistrx.cpp (the decoder alone: Farnsworth from the first transmission, noise blips in a pause,
// another speed after a pause, the same sender after a long noisy stretch), https://github.com/adswill/OnAir; see
// third_party/onair. Changes: OnAir runs the keying cases of test_cw_morse through its 0.2.7 timing decoder, which is
// not ported; here they go through the adaptive decoder, the one OnAir's receiver uses.

import { describe, expect, it } from 'vitest';
import { cwKeying, decodeKeying, gauss, norm } from './fixtures';
import { callsigns, decodeSymbol, encodeSymbol, isCallsign } from '@/worker/decoders/digimode/cw/morse';
import { FistDecoder } from '@/worker/decoders/digimode/cw/fist';

const MSG = 'CQ CQ DE LY2ABC LY2ABC <AR> K';

describe('CW code table and callsigns (OnAir test_cw_morse)', () => {
	it('round-trips characters and prosigns', () => {
		for (const t of ['A', 'Z', '0', '9', '?', '/', '<AR>', '<SK>', '<BT>', '<KN>', '<HH>']) expect(decodeSymbol(encodeSymbol(t))).toBe(t);
		expect([encodeSymbol('+'), encodeSymbol('=')]).toEqual(['.-.-.', '-...-']);
		expect(decodeSymbol('......---')).toBeUndefined();
	});

	it('tells callsigns from other words', () => {
		for (const c of ['LY2ABC', 'K1ABC', '9A1AA', 'DL1XYZ/P', '2E0ABC', 'W1AW', 'OH2/LY2ABC', 'VK2ABC/MM'])
			expect(isCallsign(c), c).toBe(true);
		for (const c of ['5NN', 'TU', 'CQ', '599', 'TEST', '73', 'QRZ?', 'ABCDEFG', 'K']) expect(isCallsign(c), c).toBe(false);
		expect(callsigns('CQ DE LY2ABC LY2ABC K DL1XYZ 5NN')).toEqual(['LY2ABC', 'DL1XYZ']);
	});
});

describe('CW adaptive decoder alone', () => {
	it.each([5, 8, 13, 20, 28, 35, 42, 50])('reads perfect keying at %i WPM', (wpm) => {
		const d = new FistDecoder();
		expect(norm(decodeKeying(d, cwKeying(`${MSG} ${MSG} ${MSG}`, wpm)))).toContain(`${MSG} ${MSG}`);
		expect(Math.abs(d.wpm - wpm)).toBeLessThan(0.05 * wpm);
	});

	it.each([
		[18, 8],
		[25, 12],
	])('reads Farnsworth %i / %i WPM', (wpm, fw) => {
		const d = new FistDecoder();
		const s = norm(decodeKeying(d, cwKeying(`TEST DE OK1XX OK1XX UR 579 579 <BT> ${MSG}`, wpm, fw)));
		expect(s).toContain(MSG);
		expect(s).toContain('UR 579 579');
		expect(Math.abs(d.wpm - wpm)).toBeLessThan(0.08 * wpm);
		expect(d.stats().charGapDots).toBeGreaterThan(4.2);
	});

	it('reads hand keying: 10 % jitter, dashes 3.6 dots', () => {
		const g = gauss(5);
		for (const wpm of [12, 18, 25]) {
			const k = cwKeying(`${MSG} ${MSG} ${MSG}`, wpm, 0, 3.6).map((v) => v * Math.max(0.5, 1 + 0.1 * g()));
			expect(norm(decodeKeying(new FistDecoder(), k)), `${wpm} WPM`).toContain('DE LY2ABC LY2ABC');
		}
	});

	it('follows a change of speed: 15 WPM, then 40 WPM', () => {
		const d = new FistDecoder();
		const s = norm(decodeKeying(d, [...cwKeying(MSG, 15), ...cwKeying('TEST OK1XX OK1XX TEST OK1XX', 40)]));
		expect(s).toContain('OK1XX TEST OK1XX');
		expect(Math.abs(d.wpm - 40)).toBeLessThan(3);
	});

	it('reads Farnsworth 20 / 10 WPM from the first transmission, letters together (OnAir test_cw_fistrx)', () => {
		const d = new FistDecoder();
		expect(norm(decodeKeying(d, cwKeying('CQ CQ DE LY2ABC LY2ABC TEST K', 20, 10)))).toContain('DE LY2ABC LY2ABC TEST K');
		const st = d.stats();
		expect(st.charGapDots).toBeGreaterThan(6);
		expect(st.wordGapDots).toBeGreaterThan(st.charGapDots * 1.6);
	});

	it('does not read noise blips in a pause as a letter before the next word', () => {
		const k = cwKeying('CQ CQ DE LY2ABC LY2ABC K', 22);
		k[k.length - 1] = 0.45; // the pause: blips of 12 - 22 ms with gaps between them
		for (const blip of [0.016, 0.022, 0.012, 0.02]) k.push(blip, 0.2);
		k.push(0.014, 0.065); // the last one just before the first dash of "CQ"
		k.push(...cwKeying('CQ DE LY2ABC K', 22));
		expect(norm(decodeKeying(new FistDecoder(), k))).toContain('K CQ DE LY2ABC K');
	});

	it.each([
		[25, 15],
		[15, 30],
		[20, 12],
	])('reads the first word after a pause at the new speed: %i -> %i WPM', (a, b) => {
		const k = cwKeying('CQ CQ DE LY2ABC LY2ABC K', a);
		k[k.length - 1] = 3;
		k.push(...cwKeying('TEST DL1XYZ DL1XYZ PSE K', b));
		const d = new FistDecoder();
		expect(norm(decodeKeying(d, k))).toContain('K TEST DL1XYZ DL1XYZ PSE K');
		expect(Math.abs(d.wpm - b)).toBeLessThan(0.1 * b);
	});

	it('finds the same sender after a long noisy stretch, Farnsworth gaps kept', () => {
		const k = cwKeying('CQ CQ DE LY2ABC LY2ABC K', 18, 10);
		k[k.length - 1] = 0.5;
		let x = 5;
		const u = () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) + 0.5) / 2 ** 32;
		for (let i = 0; i < 120; i++) k.push(0.004 + 0.031 * u(), 0.02 + 0.38 * u()); // the detector opening on noise
		k[k.length - 1] = 2;
		k.push(...cwKeying('TEST DL1XYZ DL1XYZ K', 18, 10));
		expect(norm(decodeKeying(new FistDecoder(), k))).toContain('DL1XYZ DL1XYZ K');
	});
});
