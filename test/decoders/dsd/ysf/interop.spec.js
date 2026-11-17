// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR from OnAir tests/fusion/test_fusion_interop.cpp and tests/fusion/test_fusion_gps.cpp,
// https://github.com/adswill/OnAir; see third_party/onair.
// Changes: vitest cases.
//
// Yaesu Fusion against an independent implementation: three frames (header, header via VoIP, terminator) written by
// MMDVMHost's YSF code (g4klx/MMDVMHost, YSFFICH.cpp, YSFPayload.cpp, GPL-2.0-or-later, Copyright Jonathan Naylor G4KLX),
// which interoperates with real radios. The parser must read the FICH and the callsign blocks exactly as sent, and the
// builder must write the very same bits back. The test data are the frames' bytes only; no MMDVMHost code is used.
// The GPS block is built from the YSFGateway layout (simulated data only).
import { describe, expect, it } from 'vitest';
import { buildFrameBits, parseFrameBits } from '@/worker/decoders/dsd/ysf/frame';
import { syncBits, trimField } from '@/worker/decoders/dsd/ysf/proto';
import { ysfGpsParse } from '@/worker/decoders/dsd/ysf/gps';
import { gpsBlock } from './fixtures.js';

const TAIL =
	'DFE35B10179E2F31C0D77363C015810F1C88B6245ABF96943584BBB41D5ABA469404B4BEA9A3376F8A451EABE675A5EEDFB8111D317604730686D527499DF43DEF0463251E49958E13660602D45581D1931373F63FA8958901B0';
const VECTORS = [
	['header', 'D471C9634D003CA4733C00239CA0040001D3955C003141EB800011F16570' + TAIL],
	['header voip', 'D471C9634D003F0C022F00227003F9000DD00C81003B1007B6001220066F' + TAIL],
	['terminator', 'D471C9634DCFBCA4D6524BA39C90D54FC1D374C68431419243C411F26478' + TAIL],
];

function bitsOf(hex) {
	const bits = [];
	for (let i = 0; i + 1 < hex.length; i += 2) {
		const v = parseInt(hex.slice(i, i + 2), 16);
		for (let k = 7; k >= 0; k--) bits.push((v >> k) & 1);
	}
	return Uint8Array.from(bits);
}

describe('Yaesu Fusion against MMDVMHost frames (OnAir test_fusion_interop)', () => {
	it.each(VECTORS)('%s: parsed as sent and rebuilt bit for bit', (name, hex) => {
		const bits = bitsOf(hex);
		expect(bits).toHaveLength(960);
		expect(bits.subarray(0, 40)).toEqual(syncBits());
		const c = parseFrameBits(bits);
		expect(c?.fichOk).toBe(true);
		expect(c.unitOk).toEqual([true, true]);
		expect(trimField(c.units[0], 0, 10)).toBe('CQCQCQ');
		expect(trimField(c.units[0], 10, 10)).toBe('LY2ABC');
		expect(trimField(c.units[1], 0, 10)).toBe('LY1XYZ');
		expect(c.fich.fi).toBe(name === 'terminator' ? 2 : 0);
		expect(c.fich.voip).toBe(name === 'header voip' ? 1 : 0);
		expect(c.fich.ft).toBe(6);
		expect(c.fich.mr).toBe(name === 'header voip' ? 1 : 0);
		expect(buildFrameBits(c)).toEqual(bits);
	});
});

describe('Yaesu Fusion GPS block (OnAir test_fusion_gps)', () => {
	it('decodes positions in every hemisphere and the radio model', () => {
		let g = ysfGpsParse(gpsBlock(54, 41, 25, true, 25, 16, 50, true, 0x25), 20);
		expect(g.ok && g.radio).toBe('FTM-400D');
		expect(g.lat).toBeCloseTo(54 + 41.25 / 60, 6);
		expect(g.lon).toBeCloseTo(25 + 16.5 / 60, 6);
		g = ysfGpsParse(gpsBlock(34, 5, 0, false, 118, 9, 99, false, 0x33), 20);
		expect(g.ok && g.radio).toBe('FT-5D');
		expect(g.lat).toBeCloseTo(-(34 + 5 / 60), 6);
		expect(g.lon).toBeCloseTo(-(118 + 9.99 / 60), 6);
	});
	it('rejects a wrong tag or checksum', () => {
		let b = gpsBlock(54, 41, 25, true, 25, 16, 50, true, 0x25);
		b[1] = 0x11;
		expect(ysfGpsParse(b, 20).ok).toBe(false);
		b = gpsBlock(54, 41, 25, true, 25, 16, 50, true, 0x25);
		b[15] ^= 1;
		expect(ysfGpsParse(b, 20).ok).toBe(false);
	});
});
