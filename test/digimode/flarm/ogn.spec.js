// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir tests/avroad/test_avroad_air.cpp (testOgn: both channels with
// carrier offsets and clock errors, an inverted spectrum, a noise sweep in 200 kHz, two trackers back to back and on
// two channels at once, a collision, noise alone), https://github.com/adswill/OnAir; see third_party/onair. Changes:
// the decoder's 400 kS/s channel centred on 868.3 MHz only (OnAir also tries 1, 2 and 2.4 MS/s and another centre);
// 4 noise seeds per point (OnAir: 8); BrowSDR's records in place of rows; a stealth position and an encrypted one.
import { describe, expect, it } from 'vitest';
import { FlarmDecoder } from '@/worker/decoders/digimode/flarm';
import { addNoise, ognPacket, ognScene } from './ogn-fixtures';
import { field, RATE, runDecoder } from './fixtures';

const run = (iq, block) => {
	const tail = new Float32Array(Math.floor(RATE * 0.05) * 2);
	const all = new Float32Array(iq.length + tail.length);
	all.set(iq);
	return runDecoder(FlarmDecoder, all, { block });
};
const a = ognPacket(0x111111, 1, 54.0, 25.0, 1000);
const b = ognPacket(0x222222, 7, 55.0, 24.0, 2000);

describe('OGN tracker packets', () => {
	it('decodes both channels with carrier offsets and clock errors', () => {
		const wrong = [];
		for (const chan of [-100e3, 100e3])
			for (const cfo of [-20e3, -5e3, 0, 15e3])
				for (const ppm of [-40, 0, 40]) {
					const ok = run(ognScene(RATE, chan + cfo, [a], { ppm })).decoder.stats.ogn.ok;
					if (ok !== 1) wrong.push(`${chan} ${cfo} ${ppm}: ${ok}`);
				}
		expect(wrong).toEqual([]);
	}, 60_000);

	it('reports the fields of a position', () => {
		const { records } = run(ognScene(RATE, 100e3, [a]));
		expect(records.length).toBe(1);
		const r = records[0];
		expect(r.text).toMatch(/^OGN 111111 · glider · 54\.0000\d, 25\.0000\d · 1000 m · 44 km\/h · track 180° · /);
		expect([field(r, 'ID type'), field(r, 'Channel'), field(r, 'Protocol')]).toEqual(['OGN', '868.4 MHz', 'OGN tracker']);
	});

	it('finds the polarity of an inverted spectrum', () => {
		const iq = ognScene(RATE, 100e3, [a]);
		for (let i = 1; i < iq.length; i += 2) iq[i] = -iq[i];
		expect(run(iq).decoder.stats.ogn.ok).toBe(1);
	});

	it('decodes in white noise down to the threshold and gives nothing on noise alone', () => {
		const got = [];
		for (const snr of [18, 14, 10, 8]) {
			let n = 0;
			for (let seed = 1; seed <= 4; seed++)
				n += run(addNoise(ognScene(RATE, 100e3, [a]), snr + 10 * Math.log10(RATE / 200e3), seed)).decoder.stats.ogn.ok;
			got.push(n);
		}
		console.log(`OGN packets of 4 at 18 / 14 / 10 / 8 dB in 200 kHz: ${got.join(' / ')}`);
		expect(got.slice(0, 2)).toEqual([4, 4]);
		const noise = addNoise(new Float32Array(RATE * 2 * 2), 0, 3);
		const { records, decoder } = run(noise);
		expect([records.length, decoder.stats.ogn.ok, decoder.stats.flarm.ok, decoder.stats.adsl.ok]).toEqual([0, 0, 0, 0]);
	}, 60_000);

	it('takes two trackers back to back, on two channels at once, and the stronger of a collision', () => {
		expect(run(ognScene(RATE, 100e3, [a, b], { gap: 0.0005 })).decoder.stats.ogn.ok).toBe(2);
		const x = ognScene(RATE, -100e3, [a]);
		const y = ognScene(RATE, 100e3, [b]);
		for (let i = 0; i < x.length; i++) x[i] += y[i];
		expect(run(x).decoder.stats.ogn.ok).toBe(2);
		const s = ognScene(RATE, 100e3, [a]);
		const w = ognScene(RATE, 100e3, [b]);
		for (let i = 0; i < s.length; i++) s[i] += w[i] * 0.05;
		const { records } = run(s);
		expect(records.length).toBeGreaterThan(0);
		expect(field(records[0], 'Aircraft ID')).toBe('111111');
	});

	it('counts an encrypted position and hides a stealth one', () => {
		const iq = ognScene(RATE, 100e3, [
			ognPacket(0x333333, 1, 54, 25, 900, { encrypted: true }),
			ognPacket(0x444444, 1, 54, 25, 900, { stealth: true }),
		]);
		const { records, decoder } = run(iq);
		expect(records.map((r) => r.text)).toEqual(['OGN 333333 · unknown · position encrypted, not read']);
		expect([decoder.stats.ogn.encrypted, decoder.stats.ogn.privacy]).toEqual([1, 1]);
	});

	it('takes small chunks as it takes large ones', () => {
		const iq = addNoise(ognScene(RATE, 100e3, [a, b], { gap: 0.002 }), 20, 5);
		expect(run(iq, 333).records.map((r) => r.text)).toEqual(run(iq, 40000).records.map((r) => r.text));
	});
});
