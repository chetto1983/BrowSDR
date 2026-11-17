// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir core/src/mpt1327/mpt1327_gen.cpp and
// core/include/dect2/mpt1327/mpt1327_gen.h (put, general, makeCcsc, makeGtc, makeAloha, makeAck, makeAhy, makeBcast,
// makeBcastChannel, makeData, controlChannelBits, ffskAudio, fmModulate) and tests/mpt1327/test_mpt1327.cpp
// (sampleMessages, decode), https://github.com/adswill/OnAir; see third_party/onair. Changes: codewords are bigints;
// the audio and I/Q are typed arrays; noise from BrowSDR's seeded generator (OnAir: mt19937); fmModulate returns
// interleaved I/Q and takes an optional noise level.

import { gauss } from '../ftx/fixtures';
import { checkBits, encode, SYNC } from '@/worker/decoders/digimode/mpt1327/proto';
import { MptReceiver } from '@/worker/decoders/digimode/mpt1327/rx';

/** info holds codeword bits 1 .. 48: v into bits first .. first + count - 1. */
export function put(info, first, count, v) {
	const shift = BigInt(48 - (first - 1) - count);
	const mask = ((1n << BigInt(count)) - 1n) << shift;
	return (info & ~mask) | ((BigInt(v) << shift) & mask);
}

function general(pfix, ident1, cat, type, func, params18) {
	let i = 0n;
	i = put(i, 1, 1, 1);
	i = put(i, 2, 7, pfix);
	i = put(i, 9, 13, ident1);
	i = put(i, 22, 1, 1);
	i = put(i, 23, 3, cat);
	i = put(i, 26, 2, type);
	i = put(i, 28, 3, func);
	i = put(i, 31, 18, params18);
	return encode(i);
}

/** Solves the 16 CCS bits (17 .. 32) over GF(2) so that the check bits equal SYNC. */
function solveCcs(base) {
	const c0 = checkBits(base);
	const col = Array.from({ length: 16 }, (_, k) => checkBits(put(base, 17, 16, 1 << (15 - k))) ^ c0);
	const want = SYNC ^ c0;
	const rows = Array.from({ length: 16 }, (_, r) => {
		let row = 0;
		for (let k = 0; k < 16; k++) if ((col[k] >> r) & 1) row |= 1 << k;
		return (want >> r) & 1 ? row | (1 << 16) : row;
	});
	const pivotRowOf = new Array(16).fill(-1);
	let next = 0;
	for (let k = 0; k < 16; k++) {
		const p = rows.findIndex((row, r) => r >= next && (row >> k) & 1);
		if (p < 0) continue;
		[rows[p], rows[next]] = [rows[next], rows[p]];
		for (let r = 0; r < 16; r++) if (r !== next && (rows[r] >> k) & 1) rows[r] ^= rows[next];
		pivotRowOf[k] = next++;
	}
	let ccs = 0;
	for (let k = 0; k < 16; k++) if (pivotRowOf[k] >= 0 && (rows[pivotRowOf[k]] >> 16) & 1) ccs |= 1 << (15 - k);
	return ccs;
}

/** Control channel system codeword: bit 1 = 0, SYS, CCS chosen so the check bits are SYNC, preamble 1010... */
export function makeCcsc(sys) {
	const base = put(put(0n, 2, 15, sys), 33, 16, 0xaaaa);
	return encode(put(base, 17, 16, solveCcs(base)));
}

export function makeGtc(pfix, ident1, d, chan, ident2, n = 0) {
	let i = 0n;
	i = put(i, 1, 1, 1);
	i = put(i, 2, 7, pfix);
	i = put(i, 9, 13, ident1);
	i = put(i, 22, 1, 0);
	i = put(i, 23, 1, d);
	i = put(i, 24, 10, chan);
	i = put(i, 34, 13, ident2);
	i = put(i, 47, 2, n);
	return encode(i);
}

/** CHAN4 4, WT 3, RSVD 2, M 5, N 4. */
export const makeAloha = (pfix, ident1, func, chan4, wt = 0, m = 0, n = 0) =>
	general(pfix, ident1, 0, 0, func, (chan4 << 14) | (wt << 11) | (m << 4) | n);
/** IDENT2 13, QUAL 1, N 4. */
export const makeAck = (pfix, ident1, func, ident2, qual = 0, n = 0) => general(pfix, ident1, 0, 1, func, (ident2 << 5) | (qual << 4) | n);
export const makeAhy = (pfix, ident1, func = 0, params18 = 0) => general(pfix, ident1, 0, 2, func, params18);

export function makeBcast(sysdef, sys, params18) {
	let i = 0n;
	i = put(i, 1, 1, 1);
	i = put(i, 2, 5, sysdef);
	i = put(i, 7, 15, sys);
	i = put(i, 22, 1, 1);
	i = put(i, 23, 3, 0);
	i = put(i, 26, 2, 3);
	i = put(i, 28, 3, 4);
	i = put(i, 31, 18, params18);
	return encode(i);
}

/** Announce (0), withdraw (1) or adjacent site (4) control channel: CHAN 10 bits, then ADJSITE in the last 4. */
export const makeBcastChannel = (sysdef, sys, chan, adjsite = 0) => makeBcast(sysdef, sys, (chan << 8) | (sysdef === 4 ? adjsite & 15 : 0));

/** A data codeword with the given 47 bits of information (bit 1 = 0). */
export const makeData = (info47) => encode(info47 & 0x7fffffffffffn);

/**
 * The bits of a control channel transmission: a preamble of bit reversals ending in 0, SYNC, the first address
 * codeword, then a CCSC and an address codeword for every further one, and a last CCSC.
 */
export function controlChannelBits(sys, addressCodewords, preamble = 16) {
	const b = [];
	const word = (v, n) => {
		for (let i = n - 1; i >= 0; i--) b.push(Number((BigInt(v) >> BigInt(i)) & 1n));
	};
	for (let i = 0; i < preamble; i++) b.push((i & 1) ^ 1);
	word(SYNC, 16);
	const ccsc = makeCcsc(sys);
	addressCodewords.forEach((a, k) => {
		if (k) word(ccsc, 64);
		word(a, 64);
	});
	word(ccsc, 64);
	return b;
}

/** FFSK audio at fs: bit 1 is 1200 Hz, bit 0 is 1800 Hz, continuous phase (the other way round with invert). */
export function ffskAudio(bits, fs, invert = false, amp = 0.5, bitRateScale = 1) {
	const out = [];
	const spb = fs / (1200 * bitRateScale);
	let phase = 0;
	let t = 0;
	for (const bit of bits) {
		t += spb;
		const f = !!bit !== invert ? 1200 : 1800;
		while (out.length < t) {
			out.push(amp * Math.sin(phase));
			phase += (2 * Math.PI * f) / fs;
			if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
		}
	}
	return Float32Array.from(out);
}

/** FM of audio as interleaved I/Q at fs: carrier at offsetHz, peak deviation devHz for audio 1, complex noise sigma. */
export function fmModulate(audio, fs, devHz, offsetHz, { sigma = 0, seed = 5 } = {}) {
	const iq = new Float32Array(2 * audio.length);
	const g = gauss(seed);
	let ph = 0;
	let car = 0;
	for (let i = 0; i < audio.length; i++) {
		ph = (ph + (2 * Math.PI * devHz * audio[i]) / fs) % (2 * Math.PI);
		car = (car + (2 * Math.PI * offsetHz) / fs) % (2 * Math.PI);
		iq[2 * i] = Math.cos(ph + car) + sigma * g();
		iq[2 * i + 1] = Math.sin(ph + car) + sigma * g();
	}
	return iq;
}

export const sampleMessages = () => [
	makeGtc(5, 1234, 0, 17, 2003),
	makeAloha(5, 0, 0, 3, 2, 8, 1),
	makeAck(5, 77, 0, 4321, 0, 0),
	makeAhy(9, 100, 0, 0),
	makeBcastChannel(0, 20001, 3),
	makeBcastChannel(4, 20001, 9, 2),
	makeGtc(100, 8000, 1, 1023, 8100),
	makeAck(127, 8191, 3, 1, 1, 0),
];

/** The messages (codewords) and the statistics of decoding audio in chunks of 1000 samples. */
export function decodeAudio(a, fs, mode) {
	const d = new MptReceiver();
	if (mode) d.setSyncMode(mode);
	d.reset();
	for (let i = 0; i < a.length; i += 1000) d.process(a.subarray(i, Math.min(a.length, i + 1000)), fs);
	return { codewords: d.takeEvents().map((e) => e.msg.cw), stats: d.stats };
}

export function addNoise(a, sigma, seed) {
	const g = gauss(seed);
	return a.map((v) => v + sigma * g());
}
