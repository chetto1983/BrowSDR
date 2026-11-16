import { describe, expect, it } from 'vitest';
import {
	airSeconds,
	autoLdro,
	dataSymbols,
	encode,
	hamming,
	hammingDecode,
	hammingEncode,
	headerChecksum,
	loraParams,
	payloadCrc,
	syncSymbol,
	whitening,
} from '@/worker/decoders/digimode/lora/code';
import { FrameDecoder } from '@/worker/decoders/digimode/lora/frame';
import { recoverJumps } from '@/worker/decoders/digimode/lora/jumps';
import { LoraBank } from '@/worker/decoders/digimode/lora/bank';
import { noise } from '../fixtures';
import { loraSignal, txFrame } from './phy';

function randomBytes(seed, n) {
	const u = noise(seed);
	return Uint8Array.from({ length: n }, () => Math.floor((u() + 0.5) * 256));
}

function decodeBins(sf, ldro, bins) {
	const fd = new FrameDecoder();
	fd.start(sf, ldro);
	for (const v of bins) fd.push(v);
	return { fd, out: fd.done ? fd.finish() : undefined };
}

// The known answers and round trips of OnAir's tests/mesh/test_mesh_phy.cpp (kats, coding, jumps).
describe('LoRa coding chain', () => {
	it('matches the gr-lora_sdr tables and the SX1261/2 formulas', () => {
		const w = [0xff, 0xfe, 0xfc, 0xf8, 0xf0, 0xe1, 0xc2, 0x85, 0x0b, 0x17, 0x2f, 0x5e, 0xbc, 0x78, 0xf1, 0xe3];
		w.forEach((v, i) => expect(whitening(i)).toBe(v));
		expect([whitening(253), whitening(254)]).toEqual([0x3f, 0x7f]);
		const lut8 = [0, 23, 45, 58, 78, 89, 99, 116, 139, 156, 166, 177, 197, 210, 232, 255];
		const lut5 = [0, 24, 40, 48, 72, 80, 96, 120, 136, 144, 160, 184, 192, 216, 232, 240];
		for (let n = 0; n < 16; n++) {
			const nib = ((n >> 3) & 1) | (((n >> 2) & 1) << 1) | (((n >> 1) & 1) << 2) | ((n & 1) << 3);
			for (let cr = 6; cr <= 8; cr++) expect(hammingEncode(nib, cr)).toBe(lut8[n] >> (8 - cr));
			expect(hammingEncode(nib, 5)).toBe(lut5[n] >> 3);
			for (let cr = 5; cr <= 8; cr++)
				for (let b = 0; b < cr; b++) {
					const d = hammingDecode(hammingEncode(nib, cr) ^ (1 << b), cr);
					if (cr >= 7) expect([d, hamming.errors]).toEqual([nib, 1]);
					else expect(hamming.errors).toBe(2);
				}
			hammingDecode(hammingEncode(nib, 8) ^ 0x81, 8);
			expect(hamming.errors).toBe(2);
		}
		expect([syncSymbol(0x2b, 0, 11), syncSymbol(0x2b, 1, 11), syncSymbol(0x2b, 1, 7)]).toEqual([16, 2048 - 40, 88]);
		expect([syncSymbol(0x12, 0, 8), syncSymbol(0x12, 1, 8), syncSymbol(0x34, 0, 12), syncSymbol(0x34, 1, 12)]).toEqual([8, 16, 24, 32]);
		expect([headerChecksum(0, 0, 0), headerChecksum(8, 0, 0), headerChecksum(0, 0, 1), headerChecksum(0, 1, 0)]).toEqual([
			0, 0x18, 0x0b, 0x06,
		]);
		expect(payloadCrc([...'123456789'].map((c) => c.charCodeAt(0)).concat([0, 0]), 11)).toBe(0x31c3);
		const lf = loraParams({ sf: 11, bwHz: 250e3, cr: 5, preamble: 16 });
		expect(dataSymbols(lf, 50)).toBe(58);
		expect(airSeconds(lf, 50)).toBeCloseTo((16 + 4.25 + 58) * 8.192e-3, 9);
		expect([autoLdro(11, 250e3), autoLdro(11, 125e3), autoLdro(12, 250e3), autoLdro(10, 62.5e3), autoLdro(9, 62.5e3)]).toEqual([
			false,
			true,
			true,
			true,
			false,
		]);
	});
	it('encodes and decodes every SF, CR and LDRO, correcting one bin off per block at 4/7 and 4/8', () => {
		let seed = 5;
		for (let sf = 7; sf <= 12; sf++)
			for (let cr = 5; cr <= 8; cr++)
				for (const ldro of [false, true])
					for (const len of [1, 3, 37, 255]) {
						const p = loraParams({ sf, cr, ldro, crc: len % 2 === 1 || len > 2 });
						const pay = randomBytes(seed++, len);
						const sym = encode(p, pay, len);
						expect(sym.length).toBe(dataSymbols(p, len));
						for (let pass = 0; pass < (cr >= 7 ? 2 : 1); pass++) {
							const s2 = sym.slice();
							if (pass === 1)
								for (let i = 0; i < s2.length; i++) {
									const reduced = i < 8 || ldro;
									const blk = i < 8 ? i : (i - 8) % cr;
									if (blk === 3) s2[i] = (s2[i] + (reduced ? 4 : 1) * (i & 1 ? 1 : -1) + (1 << sf)) % (1 << sf);
								}
							const { fd, out } = decodeBins(sf, ldro, s2);
							expect(fd.header).toMatchObject({ ok: true, len, cr, crc: p.crc });
							expect(Array.from(out.payload)).toEqual(Array.from(pay));
							expect(out.crcOk || !p.crc).toBe(true);
							if (pass === 1) expect(out.corrected).toBeGreaterThan(0);
						}
					}
	});
	it('undoes sample jumps, leaves clean frames and wrong symbols alone, and gives up quickly on noise', () => {
		let seed = 11;
		for (const sf of [7, 9, 11])
			for (const cr of [5, 8])
				for (const ldro of [false, true]) {
					const n = 1 << sf;
					const pay = randomBytes(seed++, 40);
					const sym = encode(loraParams({ sf, cr, ldro }), pay, 40);
					const shift = (b, from, d) => b.map((v, i) => (i >= from ? (v + d + 4 * n) % n : v));
					expect(recoverJumps(sf, ldro, sym, 11.7)).toBeUndefined();
					const a = 8 + cr * 2 + 1,
						b2 = 8 + cr * 5 + 3;
					expect(recoverJumps(sf, ldro, shift(sym, a, 12), 11.7)).toEqual({ payload: pay, jumps: 1 });
					expect(recoverJumps(sf, ldro, shift(shift(sym, a, -23), b2, 35), 11.7)).toEqual({ payload: pay, jumps: 2 });
					const bad = sym.slice();
					bad[a] = (bad[a] + Math.floor(n / 3)) % n;
					expect(recoverJumps(sf, ldro, bad, 11.7)).toBeUndefined();
				}
		const sym = encode(loraParams({ sf: 12, cr: 8 }), randomBytes(99, 255), 255);
		const u = noise(7);
		for (let i = 8; i < sym.length; i++) sym[i] = Math.floor((u() + 0.5) * 4096);
		const t0 = performance.now();
		expect(recoverJumps(12, false, sym, 11.7)).toBeUndefined();
		console.log(`jump search on noise (SF12, 255 bytes, 4/8): ${(performance.now() - t0).toFixed(0)} ms`);
	});
});

describe('LoRa demodulator', () => {
	const cases = [
		// [sf, bandwidth, CR, SNR in the LoRa band (dB), carrier offset (Hz), clock error (ppm)]
		[7, 125000, 5, -4, 9000, 20],
		[9, 250000, 6, -9, -15000, -30],
		[11, 250000, 5, -14, 3000, 15],
		[12, 125000, 8, -16, -2500, -10],
		[8, 62500, 8, -8, 4000, 25],
	];
	for (const [sf, bw, cr, snr, cfo, ppm] of cases)
		it(`decodes SF${sf} ${bw / 1000} kHz 4/${cr} at ${snr} dB SNR, ${cfo / 1000} kHz off, ${ppm} ppm`, () => {
			const p = loraParams({ sf, bwHz: bw, cr, preamble: 8, syncWord: 0x34, ldro: autoLdro(sf, bw) });
			const pays = [0, 1, 2].map((k) => randomBytes(100 + 10 * sf + k, 20 + 15 * k));
			let t = 0.05;
			const frames = pays.map((pay) => {
				const f = txFrame(p, pay, { startSec: t, freqHz: cfo, snrDb: snr, sroPpm: ppm });
				t = f.endSec + 0.1;
				return f;
			});
			const rate = 2 * bw;
			const bank = new LoraBank({ bwHz: bw, rate, sfs: [sf], syncs: [0x34], preamble: 8 });
			const out = [];
			bank.feed(loraSignal(frames, { rate, seed: sf }), out);
			expect(out.map((d) => Array.from(d.frame.payload))).toEqual(pays.map((x) => Array.from(x)));
			expect(out.every((d) => d.frame.crcOk && Math.abs(d.frame.cfoHz - cfo) < bw / (1 << sf) / 4)).toBe(true);
			expect(Math.abs(out[0].frame.snrDb - snr)).toBeLessThan(2.5);
		}, 60_000);
	it('rejects another sync word and finds nothing in noise', () => {
		const p = loraParams({ sf: 9, bwHz: 125000, preamble: 8, syncWord: 0x12 });
		const f = txFrame(p, randomBytes(3, 30), { snrDb: 10 });
		const bank = new LoraBank({ bwHz: 125000, rate: 250000, sfs: [9], syncs: [0x34], preamble: 8 });
		const out = [];
		bank.feed(loraSignal([f], { rate: 250000, durationSec: 2 }), out);
		expect(out).toHaveLength(0);
	});
});
