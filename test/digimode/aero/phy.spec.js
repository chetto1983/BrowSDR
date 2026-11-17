// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir tests/aero/test_aero_phy.cpp (known answers from JAERO's constants,
// frame round trips through the framer at the bit level) and tests/aero/test_aero_demod.cpp (each rate through the
// demodulator with a carrier offset, bit exact; MSK as the physics define it), https://github.com/adswill/OnAir; see
// third_party/onair. Changes: vitest cases, seeded noise of their own; the demodulator runs at BrowSDR's 48 kS/s channel
// for every rate as well as at OnAir's rates.

import { describe, expect, it } from 'vitest';
import { AeroDemod } from '@/worker/decoders/digimode/aero/demod';
import { AeroFramer } from '@/worker/decoders/digimode/aero/framer';
import {
	AeroConvEncoder,
	aeroBitsToBytes,
	aeroBytesToBits,
	aeroCrc16,
	aeroDeinterleave,
	AeroFrameDecoder,
	AeroFrameEncoder,
	aeroFrameFormat,
	aeroHeader,
	aeroInterleave,
	aeroSuCrcOk,
	aeroSuSetCrc,
	blockBits,
	SCRAMBLER,
	totalBits,
} from '@/worker/decoders/digimode/aero/phy';
import { gaussian, xorshift } from '../inmarsat-c/fixtures';
import { AeroModulator, randomInfo } from './signal';

const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

describe('Aero coding layer', () => {
	it('has JAERO’s unique word, header, scrambler, code, CRC and interleaver', () => {
		const want = [1, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1];
		const f = new AeroFrameEncoder(1200).frame(new Uint8Array(72), aeroHeader(1, 0, 0, 0));
		expect(f.length).toBe(1200);
		expect([...f.subarray(0, 32)]).toEqual(want);
		expect([...f.subarray(32, 36)]).toEqual([0, 0, 0, 1]);
		const f2 = new AeroFrameEncoder(10500).frame(new Uint8Array(312), aeroHeader(1, 0, 0, 0));
		expect(f2.length).toBe(5250);
		expect(want.every((b, i) => f2[2 * i] === b && f2[2 * i + 1] === b)).toBe(true);
		const f600 = aeroFrameFormat(600);
		expect([totalBits(f600), f600.blocks * blockBits(f600)]).toEqual([1200, 1152]);
		expect([...SCRAMBLER.subarray(0, 16)]).toEqual([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 1]);
		expect(SCRAMBLER.every((v, n) => n < 15 || v === (SCRAMBLER[n - 1] ^ SCRAMBLER[n - 15]))).toBe(true);
		const ones = SCRAMBLER.reduce((a, b) => a + b, 0);
		expect(ones).toBeGreaterThan(2300);
		expect(ones).toBeLessThan(2700);
		const enc = new AeroConvEncoder();
		expect(Array.from({ length: 7 }, (_, k) => enc.encode(k === 0 ? 1 : 0)).flat()).toEqual([1, 1, 0, 1, 1, 1, 1, 1, 0, 0, 1, 0, 1, 1]);
		expect(aeroCrc16(ascii('123456789'))).toBe(0x906e);
		const su = Uint8Array.of(0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x10, 0x32, 0, 0);
		aeroSuSetCrc(su);
		expect(aeroSuCrcOk(su)).toBe(true);
		su[3] ^= 0x10;
		expect(aeroSuCrcOk(su)).toBe(false);
		for (const cols of [6, 9, 78]) {
			const c = Uint8Array.from({ length: 64 * cols }, (_, i) => (i * 7 + 3) & 0xff);
			const t = new Uint8Array(64 * cols);
			aeroInterleave(c, t, cols);
			expect([t[27 * cols], t[27 * cols + 1]]).toEqual([c[1], c[1 + 64]]);
			const back = new Float32Array(c.length);
			aeroDeinterleave(Float32Array.from(t), back, cols);
			expect(back.every((v, i) => v === c[i])).toBe(true);
		}
		const bits = Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1);
		const by = aeroBitsToBytes(bits, 2);
		expect([...by]).toEqual([0x01, 0x80]);
		expect([...aeroBytesToBits(by)]).toEqual([...bits]);
	});

	it('frames every rate through the framer, clean and at 4 dB, with the arms turned over', () => {
		const rng = xorshift(7);
		for (const rate of [600, 1200, 10500])
			for (const ebn0 of [30, 4]) {
				const enc = new AeroFrameEncoder(rate);
				const got = [];
				let susOk = 0,
					susBad = 0;
				const fr = new AeroFramer(rate, (df) => {
					got.push(df.bytes);
					susOk += df.susOk;
					susBad += df.susBad;
				});
				const noise = gaussian(rate + ebn0);
				const sd = Math.sqrt(1 / (2 * 10 ** (ebn0 / 10)));
				for (let i = 0; i < 300; i++) fr.push(noise() > 0 ? 1 : -1); // noise before the first frame
				const sent = [];
				for (let f = 0; f < (rate === 10500 ? 8 : 12); f++) {
					const info = randomInfo(rng, rate);
					sent.push(info);
					const b = enc.frame(info, aeroHeader(1, 0, f >> 4, f & 15));
					b.forEach((bit, i) => {
						let v = bit ? 1 : -1;
						if (rate === 10500 ? i & 1 : true) v = -v; // one arm (OQPSK) or the whole stream (MSK) turned over
						fr.push(v + sd * noise());
					});
				}
				for (let i = 0; i < 100; i++) fr.push(sd * noise());
				const exact = got.filter((g, i) => sent[i] && sameBytes(g, sent[i])).length;
				expect(got.length).toBe(sent.length);
				if (ebn0 > 20) expect(exact).toBe(sent.length);
				else expect(susBad * 20).toBeLessThan(susOk);
			}
	});

	it('corrects errors at the end of a block with the next block in view', () => {
		for (const rate of [600, 1200]) {
			const f = aeroFrameFormat(rate);
			const info = randomInfo(xorshift(77), rate);
			const bits = new AeroFrameEncoder(rate).frame(info, aeroHeader(1, 0, 0, 0));
			const start = f.uwBits + f.headerBits + f.skipBits;
			const rx = Float32Array.from({ length: f.codedBits }, (_, i) => (bits[start + i] ? 1 : -1));
			const bb = blockBits(f);
			const pos = new Float32Array(bb);
			aeroDeinterleave(
				Float32Array.from({ length: bb }, (_, i) => i),
				pos,
				f.cols,
			);
			for (let k = bb - 14; k < bb - 6; k += 2) rx[pos[k]] = -rx[pos[k]]; // four wrong channel bits just before the block's end
			const out = new AeroFrameDecoder(rate).decode(rx, 0x1000);
			expect(sameBytes(out.bytes, info)).toBe(true);
			expect(out.susBad).toBe(0);
		}
	});
});

/** Frames of random SUs through the modulator, a carrier offset and noise into one demodulator. */
function demodRun({ rate, fs, secs, ebn0Db, cfo, seed = 3, chunk = 4096 }) {
	const rng = xorshift(seed);
	const enc = new AeroFrameEncoder(rate);
	const mod = new AeroModulator(rate, fs);
	const sent = [];
	const r = { frames: 0, exact: 0, susOk: 0, susBad: 0, freq: 0, ebn0: 0 };
	const dem = new AeroDemod(rate, fs, 700, (e) => {
		Object.assign(r, { frames: r.frames + 1, susOk: r.susOk + e.susOk, susBad: r.susBad + e.susBad, freq: e.freqHz, ebn0: e.ebn0Db });
		if (sent.some((s) => sameBytes(s, e.bytes))) r.exact++;
	});
	const sigma = Math.sqrt(fs / (2 * rate * 10 ** (ebn0Db / 10)));
	const noise = gaussian(seed + 1);
	const f = aeroFrameFormat(rate);
	let ph = 0,
		fno = 0;
	const buf = new Float32Array(2 * chunk);
	for (let done = 0; done < secs * fs; done += chunk) {
		while (mod.queuedBits < 2 * totalBits(f)) {
			const info = randomInfo(rng, rate);
			sent.push(info);
			mod.pushBits(enc.frame(info, aeroHeader(1, 0, fno >> 4, fno & 15)));
			fno++;
		}
		mod.generate(buf, 0, chunk);
		for (let i = 0; i < chunk; i++) {
			const [I, Q] = [buf[2 * i], buf[2 * i + 1]];
			buf[2 * i] = I * Math.cos(ph) - Q * Math.sin(ph) + sigma * noise();
			buf[2 * i + 1] = I * Math.sin(ph) + Q * Math.cos(ph) + sigma * noise();
			ph = (ph + (2 * Math.PI * cfo) / fs) % (2 * Math.PI);
		}
		dem.process(buf);
	}
	return { ...r, sent: sent.length };
}

describe('Aero demodulators', () => {
	it('demodulate every rate bit exact with the carrier 230 Hz off, at OnAir’s rates and at 48 kS/s', () => {
		for (const [rate, fs, secs] of [
			[600, 4900, 26],
			[1200, 9600, 14],
			[10500, 48000, 6],
			[600, 48000, 26],
			[1200, 48000, 14],
		]) {
			const r = demodRun({ rate, fs, secs, ebn0Db: 20, cfo: 230 });
			expect(r.frames, `${rate} at ${fs}`).toBeGreaterThanOrEqual(r.sent - 5);
			expect(r.exact).toBe(r.frames);
			expect(r.susBad).toBe(0);
			expect(Math.abs(r.freq - 230)).toBeLessThan(3);
		}
	}, 60_000);
});
