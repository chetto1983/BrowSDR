// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir tests/mpt1327/test_mpt1327.cpp (the check code and the CCSC
// against Appendix 3, address codeword fields, French-style framing, the decoder on FFSK audio at several rates with
// both tone polarities, a bit rate error and a DC offset, noise, bit errors, the receiver on an FM signal with a
// carrier error and noise, noise alone) and tests/mpt1327/test_mpt1327_std.cpp (every address codeword built field by
// field from the figures of the 1997 standard, single and double errors, the receiver swept over deviation, tone
// polarity, clock error and carrier offset), https://github.com/adswill/OnAir; see third_party/onair. Changes: 100
// random codewords for the double-error check (OnAir: 200); 3 noise seeds per level (OnAir: 6); the receiver is
// BrowSDR's decoder on its 16 kHz NFM channel (OnAir's engine at 48 kHz to 960 kHz with the channel off centre), so
// the sweep covers deviation, polarity, clock error and carrier offset; no registered-tuning check.
import { describe, expect, it } from 'vitest';
import {
	addressText,
	correct,
	decodeAddress,
	decodeCcsc,
	encode,
	field,
	SYNC,
	SYNT,
	valid,
	checkBits,
} from '@/worker/decoders/digimode/mpt1327/proto';
import { Mpt1327Decoder, MPT1327_RATE } from '@/worker/decoders/digimode/mpt1327';
import {
	addNoise,
	controlChannelBits,
	decodeAudio,
	ffskAudio,
	fmModulate,
	makeAck,
	makeAhy,
	makeAloha,
	makeBcastChannel,
	makeCcsc,
	makeData,
	makeGtc,
	sampleMessages,
} from './fixtures';
import { gauss } from '../ftx/fixtures';

const msgs = sampleMessages();
const bits = controlChannelBits(20001, msgs);

/** 48 information bits from fields given first bit first (test_mpt1327_std.cpp build). */
function build(fields) {
	let info = 0n;
	let n = 0;
	for (const [width, v] of fields) {
		info = (info << BigInt(width)) | (BigInt(v) & ((1n << BigInt(width)) - 1n));
		n += width;
	}
	expect(n).toBe(48);
	return encode(info);
}
const dec = (cw) => {
	expect(valid(cw)).toBe(true);
	return decodeAddress(cw);
};
const random48 = (g) =>
	BigInt(Math.floor((g() * 1e9) % 2 ** 24) & 0xffffff) * 2n ** 24n + BigInt(Math.floor((g() * 7e8) % 2 ** 24) & 0xffffff);

describe('MPT 1327 codewords', () => {
	it('has the sync words, a check code that detects one and two errors, and CCSCs of Appendix 3', () => {
		expect([SYNC, SYNT]).toEqual([0xc4d7, 0x3b28]);
		const g = gauss(1);
		let bad = 0;
		for (let n = 0; n < 100; n++) {
			const info = random48(g);
			const cw = encode(info);
			if (!valid(cw) || cw >> 16n !== info) bad++;
			for (let b = 0n; b < 64n; b++) {
				if (valid(cw ^ (1n << b))) bad++;
				for (let c = b + 1n; c < 64n; c++) if (valid(cw ^ (1n << b) ^ (1n << c))) bad++;
			}
		}
		expect(bad).toBe(0);
		for (const sys of [0, 1, 100, 12345, 20001, 32767]) {
			const c = makeCcsc(sys);
			expect([valid(c), decodeCcsc(c), Number(c & 0xffffn), field(c, 33, 16)]).toEqual([true, sys, SYNC, 0xaaaa]);
			// Appendix 3: info = preamble, 1100010011010100, SYS, bit 48 = 0, then 1 when the parity bit came out 0
			let info = (0xaaaan << 32n) | (0xc4d4n << 16n) | (BigInt(sys) << 1n);
			let chk = checkBits(info);
			if ((chk & 1) === 0) {
				info |= 1n;
				chk = checkBits(info);
			}
			expect(field(c, 17, 16)).toBe((Number(info & 1n) << 15) | ((chk >> 1) ^ 1));
		}
	});

	it('reads the address codeword fields', () => {
		expect(decodeAddress(makeGtc(5, 1234, 1, 17, 2003, 2))).toMatchObject({
			type: 'GTC',
			called: { pfix: 5, ident: 1234 },
			channel: 17,
			caller: { ident: 2003 },
		});
		expect(decodeAddress(makeGtc(5, 1234, 0, 1023, 8191))).toMatchObject({ channel: 1023, caller: { ident: 8191 } });
		expect(decodeAddress(makeAloha(127, 8191, 3, 15, 7, 31, 15))).toMatchObject({ type: 'ALHE', called: { pfix: 127, ident: 8191 } });
		expect(decodeAddress(makeAck(9, 33, 6, 77, 1, 3))).toMatchObject({ type: 'ACKT', called: { ident: 33 }, caller: { ident: 77 } });
		expect(decodeAddress(makeAhy(9, 100, 7, 5)).type).toBe('AHYC');
		expect(decodeAddress(makeBcastChannel(0, 20001, 513))).toMatchObject({ type: 'BCAST', sys: 20001, channel: 513 });
		expect(decodeAddress(makeBcastChannel(1, 20001, 12)).detail).toMatch(/withdrawn/);
		expect(decodeAddress(makeBcastChannel(4, 777, 40, 5))).toMatchObject({ channel: 40, detail: expect.stringMatching(/site 5/) });
		expect(decodeAddress(makeData(0x123456789abn))).toBeUndefined();
		expect([addressText({ pfix: 5, ident: 1234 }), addressText({ pfix: -1, ident: 7 }), addressText({ pfix: -1, ident: -1 })]).toEqual([
			'5/1234',
			'ident 7',
			'-',
		]);
	});

	it('decodes every address codeword of the section 5 figures', () => {
		let m = dec(
			build([
				[1, 1],
				[7, 5],
				[13, 1234],
				[1, 0],
				[1, 1],
				[10, 801],
				[13, 77],
				[2, 0],
			]),
		);
		expect(m).toMatchObject({
			type: 'GTC',
			called: { pfix: 5, ident: 1234 },
			channel: 801,
			caller: { ident: 77 },
			detail: expect.stringMatching(/data/),
		});
		['ALH', 'ALHS', 'ALHD', 'ALHE', 'ALHR', 'ALHX', 'ALHF', 'reserved'].forEach((name, fn) => {
			m = dec(
				build([
					[1, 1],
					[7, 9],
					[13, 4000],
					[1, 1],
					[3, 0],
					[2, 0],
					[3, fn],
					[4, 11],
					[3, 5],
					[2, 0],
					[5, 17],
					[4, 9],
				]),
			);
			expect([m.type, m.called.pfix, m.called.ident]).toEqual([name, 9, 4000]);
			expect(m.detail).toMatch(/\(low 4 bits\) 11, wait 5, address bits 17, aloha number 9/);
		});
		['ACK', 'ACKI', 'ACKQ', 'ACKX', 'ACKV', 'ACKE', 'ACKT', 'ACKB'].forEach((name, fn) => {
			m = dec(
				build([
					[1, 1],
					[7, 100],
					[13, 8100],
					[1, 1],
					[3, 0],
					[2, 1],
					[3, fn],
					[13, 4321],
					[1, 1],
					[4, 3],
				]),
			);
			expect([m.type, m.called.pfix, m.called.ident, m.caller.ident, /qualifier 1/.test(m.detail)]).toEqual([name, 100, 8100, 4321, true]);
		});
		m = dec(
			build([
				[1, 1],
				[7, 3],
				[13, 55],
				[1, 1],
				[3, 0],
				[2, 2],
				[3, 0],
				[13, 8189],
				[1, 1],
				[1, 1],
				[1, 1],
				[1, 1],
				[1, 1],
			]),
		);
		expect([m.type, addressText(m.caller)]).toEqual(['AHY', 'IPFIXI']);
		expect(m.detail).toMatch(/calling.*emergency.*data codeword follows/);
		expect(
			dec(
				build([
					[1, 1],
					[7, 3],
					[13, 55],
					[1, 1],
					[3, 0],
					[2, 2],
					[3, 2],
					[13, 66],
					[5, 0],
				]),
			),
		).toMatchObject({ type: 'AHYX', caller: { ident: 66 } });
		expect(
			addressText(
				dec(
					build([
						[1, 1],
						[7, 3],
						[13, 55],
						[1, 1],
						[3, 0],
						[2, 2],
						[3, 5],
						[13, 8190],
						[5, 0],
					]),
				).caller,
			),
		).toBe('TSCI');
		expect(
			dec(
				build([
					[1, 1],
					[7, 3],
					[13, 55],
					[1, 1],
					[3, 0],
					[2, 2],
					[3, 6],
					[13, 8190],
					[5, 21],
				]),
			).detail,
		).toMatch(/status message 21/);
		m = dec(
			build([
				[1, 1],
				[7, 3],
				[13, 55],
				[1, 1],
				[3, 0],
				[2, 2],
				[3, 7],
				[13, 8188],
				[2, 2],
				[3, 0],
			]),
		);
		expect([m.type, addressText(m.caller), m.detail]).toEqual(['AHYC', 'SDMI', 'short data invitation, descriptor 0, 2 slots']);
	});

	it('decodes the miscellaneous and short data codewords and the special idents', () => {
		let m = dec(
			build([
				[1, 1],
				[4, 0xa],
				[1, 0],
				[15, 31000],
				[1, 1],
				[3, 0],
				[2, 3],
				[3, 0],
				[18, 0x2aaaa],
			]),
		);
		expect([m.type, m.sys, /\(low 4 bits\) 10/.test(m.detail)]).toEqual(['MARK', 31000, true]);
		m = dec(
			build([
				[1, 1],
				[7, 8],
				[13, 200],
				[1, 1],
				[3, 0],
				[2, 3],
				[3, 1],
				[10, 77],
				[3, 3],
				[5, 0],
			]),
		);
		expect([m.type, m.channel, m.called.ident, /disconnect/.test(m.detail)]).toEqual(['MAINT', 77, 200, true]);
		m = dec(
			build([
				[1, 1],
				[10, 500],
				[10, 3],
				[1, 1],
				[3, 0],
				[2, 3],
				[3, 2],
				[4, 0],
				[2, 0],
				[12, 0xaaa],
			]),
		);
		expect([m.type, m.channel, /control channel 3/.test(m.detail), m.called.ident]).toEqual(['CLEAR', 500, true, -1]);
		m = dec(
			build([
				[1, 1],
				[7, 8],
				[13, 200],
				[1, 1],
				[3, 0],
				[2, 3],
				[3, 3],
				[10, 640],
				[5, 19],
				[2, 0],
				[1, 0],
			]),
		);
		expect([m.type, m.channel, m.called.pfix, /qualifier 19/.test(m.detail)]).toEqual(['MOVE', 640, 8, true]);
		m = dec(
			build([
				[1, 1],
				[5, 0],
				[15, 20001],
				[1, 1],
				[3, 0],
				[2, 3],
				[3, 4],
				[10, 311],
				[2, 0],
				[6, 0],
			]),
		);
		expect([m.type, m.sys, m.channel, /announced/.test(m.detail)]).toEqual(['BCAST', 20001, 311, true]);
		expect(
			dec(
				build([
					[1, 1],
					[5, 1],
					[15, 20001],
					[1, 1],
					[3, 0],
					[2, 3],
					[3, 4],
					[10, 311],
					[2, 0],
					[6, 0],
				]),
			).detail,
		).toMatch(/withdrawn/);
		expect(
			dec(
				build([
					[1, 1],
					[5, 2],
					[15, 20001],
					[1, 1],
					[3, 0],
					[2, 3],
					[3, 4],
					[1, 0],
					[5, 12],
					[1, 0],
					[1, 1],
					[2, 0],
					[8, 0],
				]),
			).detail,
		).toMatch(/every 12 s, pressel on sent, MAINT address individual/);
		m = dec(
			build([
				[1, 1],
				[5, 4],
				[15, 20001],
				[1, 1],
				[3, 0],
				[2, 3],
				[3, 4],
				[10, 99],
				[2, 0],
				[2, 0],
				[4, 6],
			]),
		);
		expect([m.channel, /adjacent.*site 6/.test(m.detail)]).toEqual([99, true]);
		m = dec(
			build([
				[1, 1],
				[7, 4],
				[13, 8190],
				[1, 1],
				[3, 1],
				[1, 1],
				[2, 2],
				[7, 6],
				[13, 1500],
			]),
		);
		expect([m.type, addressText(m.called), m.caller.pfix, m.caller.ident, /3 data codewords/.test(m.detail)]).toEqual([
			'HEAD',
			'TSCI',
			6,
			1500,
			true,
		]);
		expect(
			dec(
				build([
					[1, 1],
					[7, 4],
					[13, 700],
					[1, 1],
					[3, 1],
					[1, 0],
					[22, 0],
				]),
			).type,
		).toBe('SAM');
		expect([8191, 8190, 8186, 8101, 0, 8125].map((ident) => addressText({ pfix: -1, ident }))).toEqual([
			'ALLI',
			'TSCI',
			'INCI',
			'PSTNGI',
			'DUMMYI',
			'short-form ident 5',
		]);
		expect(addressText({ pfix: 3, ident: 100 })).toBe('3/100');
	});

	it('repairs any single error and never turns two into another codeword', () => {
		const g = gauss(11);
		const r = (n) => Math.floor(Math.abs(g()) * 1e6) % n;
		let fixed = 0;
		let wrong = 0;
		let lost = 0;
		for (let i = 0; i < 400; i++) {
			const cw = build([
				[1, 1],
				[7, r(128)],
				[13, r(8192)],
				[1, 1],
				[3, 0],
				[2, r(4)],
				[3, r(8)],
				[13, r(8192)],
				[5, r(32)],
			]);
			if (correct(cw ^ (1n << BigInt(r(64)))) === cw) fixed++;
			const a = r(64);
			const b = (a + 1 + r(63)) % 64;
			if (correct(cw ^ (1n << BigInt(a)) ^ (1n << BigInt(b))) === undefined) lost++;
			else wrong++;
		}
		expect([fixed, wrong, lost]).toEqual([400, 0, 400]);
	});
});

describe('MPT 1327 control channel decoder', () => {
	it('decodes FFSK audio at several rates, with either tone polarity and any start', () => {
		const wrong = [];
		for (const fs of [24000, 48000, 44100, 12000, 8000])
			for (const inv of [false, true])
				for (const lead of [0, 3, 7, 13]) {
					const s = ffskAudio(bits, fs, inv);
					const a = new Float32Array(lead * Math.round(fs / 24000) + s.length);
					a.set(s, a.length - s.length);
					const { codewords, stats } = decodeAudio(a, fs);
					const ok =
						codewords.length === msgs.length &&
						codewords.every((c, i) => c === msgs[i]) &&
						stats.bad === 0 &&
						stats.sys === 20001 &&
						stats.ccsc >= 1;
					if (!ok) wrong.push(`${fs} ${inv} ${lead}: ${codewords.length} bad ${stats.bad} sys ${stats.sys}`);
				}
		expect(wrong).toEqual([]);
	});

	it('takes a 0.1 % bit rate error, a DC offset and repeated messages', () => {
		const a = ffskAudio(bits, 24000, false, 0.2, 1.001).map((v) => v + 0.05);
		expect(decodeAudio(a, 24000).codewords).toEqual(msgs);
		const rep = Array.from({ length: 5 }, (_, i) => makeGtc(5, 1234 + i, 0, 10 + i, 2003));
		expect(decodeAudio(ffskAudio(controlChannelBits(300, rep), 24000), 24000).codewords).toEqual(rep);
	});

	it('finds codewords behind a foreign sync word with tolerant framing', () => {
		const b = bits.slice();
		let n = 0;
		for (let i = 0; i + 16 <= b.length; i++) {
			let w = 0;
			for (let k = 0; k < 16; k++) w = (w << 1) | b[i + k];
			if (w !== SYNC) continue;
			for (let k = 0; k < 16; k++) b[i + k] = (0x35a9 >> (15 - k)) & 1;
			n++;
			i += 15;
		}
		expect(n).toBeGreaterThanOrEqual(2);
		for (const inv of [false, true]) {
			const s = ffskAudio(b, 24000, inv);
			const a = new Float32Array(24000 * 12 + s.length + 24000 * 2);
			a.set(s, 24000 * 12); // 12 s of silence first: lets auto time out
			for (const mode of ['standard', 'tolerant', 'auto']) {
				const got = decodeAudio(a, 24000, mode).codewords;
				if (mode === 'standard') expect(got).toEqual([]);
				else expect(got.length).toBeGreaterThanOrEqual(msgs.length - 1);
			}
		}
	});

	it('loses messages in heavy noise but never reports one that was not sent, and gives nothing on noise alone', () => {
		const clean = ffskAudio(bits, 24000, false, 0.5);
		const allowed = new Set(msgs);
		let fewer = 0;
		for (const sigma of [0.05, 0.1, 0.25, 0.5, 1]) {
			let good = 0;
			let falsePos = 0;
			for (let seed = 1; seed <= 3; seed++)
				for (const cw of decodeAudio(addNoise(clean, sigma, seed), 24000).codewords) allowed.has(cw) ? good++ : falsePos++;
			console.log(`MPT 1327 noise sigma ${sigma} (tones 0.5): ${good} of ${msgs.length * 3} messages, ${falsePos} false`);
			expect(falsePos).toBe(0);
			if (sigma <= 0.1) expect(good).toBe(msgs.length * 3);
			if (sigma >= 0.5 && good < msgs.length * 3) fewer++;
		}
		expect(fewer).toBeGreaterThan(0);
		const { codewords, stats } = decodeAudio(addNoise(new Float32Array(24000 * 60), 0.3, 99), 24000);
		expect([codewords.length, stats.good, stats.bad, stats.locked]).toEqual([0, 0, 0, false]);
		const tone = Float32Array.from({ length: 24000 * 5 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 1200 * i) / 24000));
		expect([decodeAudio(tone, 24000).codewords.length, decodeAudio(new Float32Array(24000 * 5), 24000).codewords.length]).toEqual([0, 0]);
	}, 60_000);

	it('repairs one wrong bit anywhere in a codeword and drops a codeword with two', () => {
		msgs.forEach((_, which) => {
			const b = bits.slice();
			b[32 + which * 128 + 10] ^= 1;
			const { codewords, stats } = decodeAudio(ffskAudio(b, 24000), 24000);
			expect([codewords, stats.corrected, stats.bad]).toEqual([msgs, 1, 0]);
		});
		for (let k = 0; k < 64; k++) {
			const b = bits.slice();
			b[32 + 128 + k] ^= 1;
			expect(decodeAudio(ffskAudio(b, 24000), 24000).codewords).toEqual(msgs);
		}
		const b = bits.slice();
		b[32 + 128 + 5] ^= 1;
		b[32 + 128 + 40] ^= 1;
		expect(decodeAudio(ffskAudio(b, 24000), 24000).codewords).toEqual(msgs.filter((_, i) => i !== 1));
	});
});

/** The receiver on its NFM channel: records and the decoder (test_mpt1327.cpp engine checks). */
function receive(iq, block = 4096) {
	const records = [];
	const statuses = [];
	const d = new Mpt1327Decoder({ record: (r) => records.push(r), status: (m, locked) => statuses.push([m, locked]) });
	for (let i = 0; i < iq.length; i += 2 * block) d.process(iq.subarray(i, Math.min(iq.length, i + 2 * block)));
	return { records, statuses, d };
}
const padded = (audio, fs) => {
	const a = new Float32Array(Math.round(fs * 0.5) * 2 + audio.length);
	a.set(audio, Math.round(fs * 0.5));
	return a;
};
const field2 = (r, label) => r.fields.find(([k]) => k === label)?.[1];

describe('MPT 1327 receiver on an FM channel', () => {
	it('lists calls and messages with a carrier error and noise; ALH stays in the status line', () => {
		for (const cfo of [0, 600, -900])
			for (const sigma of [0, 0.3]) {
				const audio = padded(ffskAudio(bits, MPT1327_RATE, false, 0.5), MPT1327_RATE);
				const { records, statuses, d } = receive(fmModulate(audio, MPT1327_RATE, 3000, cfo, { sigma }));
				expect([cfo, sigma, d.rx.stats.sys, d.rx.stats.messages]).toEqual([cfo, sigma, 20001, msgs.length]);
				expect(records.map((r) => r.text.split(' · ')[0])).toEqual([
					'Call ident 2003 → 5/1234',
					'ACK 5/77 ← ident 4321',
					'AHY 9/100 ← DUMMYI',
					'BCAST',
					'BCAST',
					'Call ident 8100 → 100/8000',
					'ACKX ALLI ← ident 1',
				]);
				const call = records[0];
				expect([field2(call, 'Message'), field2(call, 'Called'), field2(call, 'Caller'), field2(call, 'Traffic channel')]).toEqual([
					'GTC',
					'5/1234',
					'ident 2003',
					'17',
				]);
				expect([records[0].text.endsWith('speech'), records[5].text.endsWith('data'), field2(records[5], 'System')]).toEqual([
					true,
					true,
					'20001',
				]);
				expect(records.some((r) => r.text.startsWith('ALH'))).toBe(false);
				expect(statuses.at(-1)[0]).toMatch(/^System 20001 · 8 messages · 2 calls · ALH/);
			}
	});

	it('takes deviation, tone polarity, clock error and carrier offset and reports nothing that was not sent', () => {
		const sent = [
			makeGtc(5, 1234, 0, 17, 2003),
			makeAloha(5, 0, 0, 3, 2, 8, 1),
			makeBcastChannel(0, 20001, 3),
			makeAck(5, 77, 0, 4321, 0, 0),
			makeGtc(7, 88, 1, 900, 9),
			makeBcastChannel(4, 20001, 9, 2),
		];
		const b = controlChannelBits(20001, sent);
		let cases = 0;
		const missed = [];
		for (const dev of [3000, 4500, 6000])
			for (const inv of [false, true])
				for (const ce of [-0.001, 0, 0.0005]) {
					const cfo = ((cases % 3) - 1) * 700;
					const audio = padded(ffskAudio(b, MPT1327_RATE, inv, 0.45, 1 + ce), MPT1327_RATE);
					const { d } = receive(fmModulate(audio, MPT1327_RATE, dev, cfo, { sigma: 0.05, seed: 5 + cases }));
					cases++;
					expect(d.rx.stats.messages).toBeLessThanOrEqual(sent.length);
					expect([20001, -1]).toContain(d.rx.stats.sys);
					if (d.rx.stats.messages !== sent.length || d.rx.stats.sys !== 20001) missed.push(`${dev} ${inv} ${ce}`);
				}
		expect(missed.length * 100).toBeLessThanOrEqual(cases * 2);
	});

	it('costs a fraction of a per cent of a core', () => {
		const iq = fmModulate(padded(ffskAudio(bits, MPT1327_RATE, false, 0.5), MPT1327_RATE), MPT1327_RATE, 3000, 400, { sigma: 0.2 });
		const sec = iq.length / 2 / MPT1327_RATE;
		let best = Infinity;
		for (let rep = 0; rep < 3; rep++) {
			const t0 = performance.now();
			receive(iq);
			best = Math.min(best, (performance.now() - t0) / sec);
		}
		console.log(`MPT 1327 receiver: ${best.toFixed(1)} ms of CPU per second of signal (16 kS/s)`);
		expect(best).toBeLessThan(100);
	});

	it('searches on noise alone and takes small chunks as large ones', () => {
		const g = gauss(8);
		const noise = Float32Array.from({ length: 2 * MPT1327_RATE * 3 }, () => 0.3 * g());
		const { records, statuses, d } = receive(noise);
		expect([records.length, d.rx.stats.good, d.rx.stats.messages, d.rx.stats.locked]).toEqual([0, 0, 0, false]);
		expect(statuses.at(-1)).toEqual(['Searching for a control channel', false]);
		const iq = fmModulate(padded(ffskAudio(bits, MPT1327_RATE, false, 0.5), MPT1327_RATE), MPT1327_RATE, 3000, 400, { sigma: 0.2 });
		expect(receive(iq, 77).records.map((r) => r.text)).toEqual(receive(iq, 8000).records.map((r) => r.text));
	});
});
