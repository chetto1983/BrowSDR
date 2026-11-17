// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR from OnAir core/src/fusion/fusion_gen.cpp (genVoiceBytes, genTransmissionBits,
// modulateC4fm) and tests/fusion/fusion_test_util.h (signal), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the C4FM signal is made at BrowSDR's 48 kHz DSD rate with the channel at 0 Hz plus the tuning error, noise
// is a carrier-to-noise ratio in the 12.5 kHz channel followed by a channel filter (voice-fixtures.js); with
// validVoice the voice sub-frames are valid AMBE+2 / IMBE frames (OnAir's are pseudo-random bytes) so that mbelib
// can count their errors.
import { buildFrameBits } from '@/worker/decoders/dsd/ysf/frame';
import { dibitLevel, padField } from '@/worker/decoders/dsd/ysf/proto';
import { ambeEncode, channel, fmIq, imbeEncode, packBits, randomBits } from '../voice-fixtures.js';

export function baseParams(overrides = {}) {
	return {
		dest: 'CQCQCQ',
		src: 'N0CALL',
		down: '',
		up: '',
		rem: ['', '', '', ''],
		slow: '',
		dt: 0,
		commFrames: 8,
		cm: 0,
		mr: 0,
		voip: 0,
		sqlOff: 1,
		sqlCode: 0,
		seed: 1,
		...overrides,
	};
}

/** The bytes of voice sub-frame sub of communication frame frame (9, 7 or 18 bytes by kind 1, 2, 3). */
export function genVoiceBytes(seed, frame, sub, kind) {
	let x = (Math.imul(seed, 2654435761) + Math.imul(frame, 40503) + Math.imul(sub, 9973) + 12345) >>> 0;
	const n = kind === 1 ? 9 : kind === 2 ? 7 : 18;
	const v = new Uint8Array(n);
	for (let i = 0; i < n; i++) {
		x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
		v[i] = x >>> 24;
	}
	if (kind === 2) v[6] &= 0x80; // 49 bits: seven bits of padding
	return v;
}

/** BrowSDR: voice the codec accepts, from the same seed. */
export function validVoiceBytes(seed, frame, sub, kind) {
	const bits = randomBits((seed * 7919 + frame * 131 + sub * 17 + 3) >>> 0, kind === 3 ? 88 : 49);
	if (kind === 1) return packBits(ambeEncode(bits), 9);
	if (kind === 2) return packBits(bits, 7);
	return packBits(imbeEncode(bits), 18);
}

const field = (s, n) => padField(s, n);
const cat = (...parts) => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let pos = 0;
	for (const p of parts) {
		out.set(p, pos);
		pos += p.length;
	}
	return out;
};

function unitSequence(p, csd1, csd2, csd3, slowUnits) {
	let seq = [];
	let perFrame = 1;
	if (p.dt === 0) seq = [csd1, csd2, csd3];
	else if (p.dt === 2)
		seq = [
			field(p.dest, 10),
			field(p.src, 10),
			field(p.down, 10),
			field(p.up, 10),
			cat(field(p.rem[0], 5), field(p.rem[1], 5)),
			cat(field(p.rem[2], 5), field(p.rem[3], 5)),
		];
	else if (p.dt === 1) {
		seq = [csd1, csd2, csd3];
		perFrame = 2;
	}
	if (p.dt !== 3) seq.push(...slowUnits);
	if (p.dt === 1 && seq.length % 2) seq.push(field('', 20));
	return { seq, perFrame };
}

/** Header + communication frames + terminator: the bits and the content of each frame. */
export function genTransmission(p, { validVoice = false } = {}) {
	const voiceBytes = validVoice ? validVoiceBytes : genVoiceBytes;
	const csd1 = cat(field(p.dest, 10), field(p.src, 10));
	const csd2 = cat(field(p.down, 10), field(p.up, 10));
	const csd3 = cat(...p.rem.map((r) => field(r, 5)));
	const chunk = p.dt === 2 ? 10 : 20;
	const maxSlow = p.dt === 0 ? 100 : p.dt === 2 ? 20 : p.dt === 1 ? 260 : 0;
	const slow = p.slow.slice(0, maxSlow);
	const slowUnits = [];
	for (let i = 0; i < Math.ceil(slow.length / chunk); i++) slowUnits.push(field(slow.slice(i * chunk), chunk));
	const f = { fi: 0, cs: 2, cm: p.cm, bn: 0, bt: 0, fn: 0, ft: 0, mr: p.mr, voip: p.voip, dt: p.dt, sqlOff: p.sqlOff, sqlCode: p.sqlCode };
	const frames = [];
	const emit = (content) => {
		const bits = buildFrameBits(content);
		if (!bits) throw new Error('frame does not fit');
		frames.push({ content, bits });
	};
	const header = { fich: { ...f, fi: 0 }, units: [csd1, csd2], voice: [], unitOk: [], fichOk: true, fichFixes: 0 };
	emit(header);
	const { seq, perFrame } = unitSequence(p, csd1, csd2, csd3, slowUnits);
	const cycle = Math.max(1, Math.floor(seq.length / perFrame));
	for (let k = 0; k < p.commFrames; k++) {
		const c = { fich: { ...f, fi: 1 }, units: [], voice: [], unitOk: [], fichOk: true, fichFixes: 0 };
		if (p.dt === 3) {
			c.fich.fn = 0;
			c.fich.ft = k === 0 ? 1 : 0;
			if (k === 0) c.units = [csd3];
			for (let s = 0; s < (k === 0 ? 2 : 5); s++) c.voice.push({ kind: 3, bytes: voiceBytes(p.seed, k, s, 3) });
		} else {
			const fn = k % cycle;
			c.fich.fn = fn;
			c.fich.ft = cycle - 1;
			for (let u = 0; u < perFrame; u++) c.units.push(seq[fn * perFrame + u]);
			const kind = p.dt === 0 ? 1 : 2;
			if (p.dt === 0 || p.dt === 2) for (let s = 0; s < 5; s++) c.voice.push({ kind, bytes: voiceBytes(p.seed, k, s, kind) });
		}
		emit(c);
	}
	emit({ ...header, fich: { ...header.fich, fi: 2 } });
	const bits = new Uint8Array(frames.length * 960);
	frames.forEach((fr, i) => bits.set(fr.bits, i * 960));
	return { bits, frames: frames.map((fr) => fr.content) };
}

/**
 * C4FM: bits -> raised-cosine (0.35) shaped 4-level FSK at +-900 / +-2700 Hz, as the instantaneous frequency at fs,
 * with idleSymbols of carrier at the rest frequency before and after. devScale: deviation error, rateScale: symbol clock error.
 */
export function c4fmFrequency(bits, fs, { cfoHz = 0, idle = 40, devScale = 1, rateScale = 1 } = {}) {
	const nsym = bits.length >> 1;
	const sps = fs / (4800 * rateScale);
	const lvl = new Float32Array(nsym + 2 * idle + 8);
	for (let i = 0; i < nsym; i++) lvl[idle + 4 + i] = dibitLevel(bits[2 * i] * 2 + bits[2 * i + 1]);
	const alpha = 0.35;
	const rc = (t) => {
		const a = Math.abs(t);
		if (a >= 4) return 0;
		const s = a < 1e-9 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
		const d = 1 - 4 * alpha * alpha * t * t;
		const c = Math.abs(d) < 1e-6 ? Math.PI / 4 : Math.cos(Math.PI * alpha * t) / d;
		return s * c;
	};
	const total = Math.ceil(lvl.length * sps);
	const freq = new Float32Array(total);
	for (let n = 0; n < total; n++) {
		const t = n / sps;
		const c = Math.floor(t);
		let f = 0;
		for (let k = c - 4; k <= c + 4; k++) if (k >= 0 && k < lvl.length) f += lvl[k] * 900 * devScale * rc(t - (k + 0.5));
		freq[n] = f + cfoHz;
	}
	return freq;
}

/** OnAir test_fusion_gps.cpp block(): a GPS slow data block in the YSFGateway layout (simulated data). */
export function gpsBlock(laDeg, laMin, laFrac, north, loDeg, loMin, loFrac, east, model) {
	const b = new Uint8Array(20).fill(0x20);
	b[1] = 0x47;
	b[2] = 0x64;
	b[4] = model;
	const latH = north ? 5 : 3;
	b[5] = 0x30 | Math.floor(laDeg / 10);
	b[6] = 0x30 | (laDeg % 10);
	b[7] = 0x30 | Math.floor(laMin / 10);
	b[8] = (latH << 4) | (laMin % 10);
	const loRangeHigh = loDeg < 10 || loDeg >= 100 ? 5 : 3;
	b[9] = (loRangeHigh << 4) | Math.floor(laFrac / 10);
	b[10] = ((east ? 3 : 5) << 4) | (laFrac % 10);
	if (loDeg < 10) b[11] = 0x76 + loDeg;
	else if (loDeg >= 110) b[11] = 0x26 + loDeg - 110;
	else if (loDeg >= 100) b[11] = 0x6c + loDeg - 100;
	else b[11] = 0x26 + loDeg - 10;
	b[12] = loMin >= 10 ? 0x26 + loMin - 10 : 0x58 + loMin;
	b[13] = 0x1c + loFrac;
	b[14] = 0x03;
	let c = 0;
	for (let i = 0; i <= 14; i++) c = (c + b[i]) & 0xff;
	b[15] = c;
	return b;
}

/** BrowSDR: an MMDVM-style transmit preamble (bytes 0x77: +3 -3 ...) before the transmission's bits. */
function withPreamble(bits, symbols) {
	const out = new Uint8Array(bits.length + 2 * symbols);
	for (let i = 0; i < symbols; i++) out.set(i % 2 ? [1, 1] : [0, 1], 2 * i);
	out.set(bits, 2 * symbols);
	return out;
}

/**
 * fusion_test_util.h signal(): transmissions in a row through the C4FM modulator and the channel.
 * preamble: symbols of transmit preamble (OnAir's generator has none).
 */
export function ysfSignal(
	txs,
	{ cfoHz = 0, cnrDb = 99, mirrored = false, skipSec = 0, validVoice = false, seed = 5, preamble = 0, ...mod } = {},
) {
	const parts = txs.map((p) =>
		c4fmFrequency(withPreamble(genTransmission(p, { validVoice }).bits, preamble), 48000, { cfoHz, idle: 400, ...mod }),
	);
	let freq = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
	let pos = 0;
	for (const p of parts) {
		freq.set(p, pos);
		pos += p.length;
	}
	if (mirrored) freq = freq.map((v) => -v);
	if (skipSec > 0) freq = freq.subarray(Math.round(skipSec * 48000));
	return channel(fmIq(freq), { cnrDb, seed });
}
