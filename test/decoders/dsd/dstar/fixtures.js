// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR from OnAir core/src/dstar/dstar_gen.cpp (ddmm, dstarKnownVoice, dstarRmc, dstarGga,
// dstarDprs, dstarTxBits, dstarTestSchedule, DstarGenerator: GMSK BT 0.5, +-1.2 kHz) and core/include/dect2/dstar/dstar_gen.h
// (DstarGenTx), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the signal is made at BrowSDR's 48 kHz DSD rate with the channel at 0 Hz plus the tuning error and an optional
// clock error; the noise is a carrier-to-noise ratio in 6.25 kHz followed by a channel filter (voice-fixtures.js); invert
// sends the frequency upside down. OnAir sends a 1 bit as the upper frequency, which is DSD's inverted D-STAR sync.
import {
	DATA_SYNC,
	END_PATTERN,
	FRAME_SYNC,
	HEADER_BITS,
	SLOW_SCRAMBLE,
	SUPERFRAME,
	bytesToBits,
	headerEncode,
	headerPack,
} from '@/worker/decoders/dsd/dstar/header';
import { dprsCrc, nmeaChecksum } from '@/worker/decoders/dsd/dstar/gps';
import { channel, fmIq } from '../voice-fixtures.js';

export function header(h = {}) {
	return { flag: [0, 0, 0], rpt2: 'DIRECT', rpt1: 'DIRECT', ur: 'CQCQCQ', my: 'N0CALL', sfx: '', ...h };
}

export function tx(overrides = {}) {
	return {
		hdr: header(),
		text: '',
		gps: [],
		headerResend: true,
		squelch: -1,
		durSec: 2,
		gapSec: 1,
		headerErrors: 0,
		dropBlock: 0,
		endPattern: true,
		...overrides,
	};
}

/** OnAir's known voice bits of frame fn (there is no free AMBE encoder). */
export function dstarKnownVoice(fn) {
	let s = (Math.imul(fn, 2654435761) + 12345) >>> 0;
	const out = new Uint8Array(72);
	for (let i = 0; i < 72; i++) {
		s = (Math.imul(s, 1103515245) + 12345) >>> 0;
		out[i] = (s >>> 16) & 1;
	}
	return out;
}

function ddmm(v, degDigits, pos, neg, decimals) {
	const h = v >= 0 ? pos : neg;
	v = Math.abs(v);
	let d = Math.floor(v);
	const r = 10 ** decimals;
	let m = Math.round((v - d) * 60 * r) / r;
	if (m >= 60) {
		m -= 60;
		d++;
	}
	return `${String(d).padStart(degDigits, '0')}${m.toFixed(decimals).padStart(decimals + 3, '0')},${h}`;
}

export function dstarRmc(lat, lon, speedKmh, course) {
	const b = `GPRMC,120000,A,${ddmm(lat, 2, 'N', 'S', 3)},${ddmm(lon, 3, 'E', 'W', 3)},${(speedKmh / 1.852).toFixed(1)},${course},111026,,`;
	return `$${b}*${nmeaChecksum(b)}\r\n`;
}

export function dstarGga(lat, lon, altM) {
	const b = `GPGGA,120000,${ddmm(lat, 2, 'N', 'S', 3)},${ddmm(lon, 3, 'E', 'W', 3)},1,08,1.0,${altM.toFixed(1)},M,,M,,`;
	return `$${b}*${nmeaChecksum(b)}\r\n`;
}

export function dstarDprs(call, lat, lon, comment) {
	const la = ddmm(lat, 2, 'N', 'S', 2).replace(',', '');
	const lo = ddmm(lon, 3, 'E', 'W', 2).replace(',', '');
	const rest = `${call}>API51,DSTAR*:!${la}/${lo}>${comment}\r`;
	return `$$CRC${dprsCrc(rest).toString(16).toUpperCase().padStart(4, '0')},${rest}\n`;
}

/** The slow data blocks of a transmission, sent round and round. */
function slowBlocks(t, hdr) {
	const blocks = [];
	const chunks = (type, bytes) => {
		for (let o = 0; o < bytes.length; o += 5) {
			const k = Math.min(5, bytes.length - o);
			const b = [type | k, 0x66, 0x66, 0x66, 0x66, 0x66];
			for (let i = 0; i < k; i++) b[1 + i] = bytes[o + i];
			blocks.push(b);
		}
	};
	if (t.text) {
		const text = t.text.padEnd(20, ' ').slice(0, 20);
		for (let i = 0; i < 4; i++) blocks.push([0x40 | i, ...Array.from(text.slice(5 * i, 5 * i + 5), (c) => c.charCodeAt(0))]);
	}
	if (t.headerResend) chunks(0x50, Array.from(hdr));
	for (const g of t.gps)
		chunks(
			0x30,
			Array.from(g, (c) => c.charCodeAt(0)),
		);
	if (t.squelch >= 0) blocks.push([0xc2, t.squelch, t.squelch, 0x66, 0x66, 0x66]);
	if (!blocks.length) blocks.push([0x66, 0x66, 0x66, 0x66, 0x66, 0x66]);
	return blocks;
}

/** The bits of one whole transmission, from the bit sync to the end pattern, and the voice frames sent. */
export function dstarTxBits(t) {
	const bits = [];
	for (let i = 0; i < 64; i++) bits.push(i % 2 === 0 ? 1 : 0);
	bits.push(...FRAME_SYNC);
	const hdr = headerPack(t.hdr);
	const hb = headerEncode(hdr);
	for (let i = 0; i < t.headerErrors; i++) hb[(Math.floor((i * HEADER_BITS) / t.headerErrors) + 7) % HEADER_BITS] ^= 1;
	bits.push(...hb);
	const blocks = slowBlocks(t, hdr);
	const voice = [];
	let bi = 0;
	let sent = 0;
	let cur = [0x66, 0x66, 0x66, 0x66, 0x66, 0x66];
	const nf = Math.max(1, Math.round(t.durSec / 0.02));
	for (let fn = 0; fn < nf; fn++) {
		const v = dstarKnownVoice(fn);
		voice.push(v);
		bits.push(...v);
		const idx = fn % SUPERFRAME;
		if (idx === 0) {
			bits.push(...DATA_SYNC);
			continue;
		}
		const half = (idx - 1) & 1;
		if (half === 0) {
			cur = blocks[bi];
			bi = (bi + 1) % blocks.length;
			sent++;
			// In the first round only: the repeats bring it back.
			if (t.dropBlock > 0 && sent <= blocks.length && sent % t.dropBlock === 0) cur = [0x66, 0x66, 0x66, 0x66, 0x66, 0x66];
		}
		const d = [0, 1, 2].map((k) => cur[3 * half + k] ^ SLOW_SCRAMBLE[k]);
		bits.push(...bytesToBits(d));
	}
	if (t.endPattern) bits.push(...END_PATTERN);
	return { bits, voice };
}

export function dstarTestSchedule() {
	return [
		tx({
			hdr: header({ flag: [0x40, 0, 0], rpt2: 'LY0VNO G', rpt1: 'LY0VNO B', ur: 'CQCQCQ', my: 'N0CALL', sfx: 'ID51' }),
			text: 'OnAir D-STAR test 73',
			gps: [dstarRmc(54.6872, 25.2797, 36, 90), dstarGga(54.6872, 25.2797, 112)],
			durSec: 4,
			gapSec: 0.8,
		}),
		tx({
			hdr: header({ ur: 'CQCQCQ', my: 'LY1TST' }),
			text: 'Hello via simplex',
			gps: [dstarDprs('LY1TST-7', 54.8985, 23.9036, 'OnAir D-PRS test')],
			squelch: 12,
			durSec: 3,
			gapSec: 1,
		}),
	];
}

/** Gaussian (BT 0.5) frequency pulses at 48 kHz, 10 samples per bit, in units of the 1.2 kHz deviation. */
function gmsk(bits) {
	const sps = 10;
	const sigma = (Math.sqrt(Math.log(2)) / (2 * Math.PI * 0.5)) * sps;
	const g = [];
	for (let k = -2 * sps; k <= 2 * sps; k++) g.push(Math.exp((-0.5 * k * k) / (sigma * sigma)));
	const sum = g.reduce((a, b) => a + b, 0);
	const y = new Float32Array(bits.length * sps + g.length);
	for (let k = 0; k < bits.length; k++) {
		const s = bits[k] ? 1 : -1;
		for (let r = 0; r < sps; r++) for (let j = 0; j < g.length; j++) y[k * sps + r + j] += (s * g[j]) / sum;
	}
	return y;
}

/** The frequency stream resampled for a transmitter clock error (ppm), linear interpolation. */
function clock(freq, ppm) {
	if (!ppm) return freq;
	const step = 1 + ppm * 1e-6;
	const out = new Float32Array(Math.floor((freq.length - 1) / step));
	for (let i = 0; i < out.length; i++) {
		const p = i * step;
		const k = Math.floor(p);
		const a = freq[k];
		const b = freq[k + 1];
		out[i] = Number.isNaN(a) || Number.isNaN(b) ? NaN : a + (b - a) * (p - k);
	}
	return out;
}

/**
 * The transmissions in a row over the channel (OnAir DstarGenerator): leadSec of no carrier first, each transmission
 * followed by its gap; skipSec drops the start of the signal (a receiver switched on in the middle of a call).
 */
export function dstarSignal(txs, { cnrDb = 99, cfoHz = 0, ppm = 0, invert = false, leadSec = 0.3, skipSec = 0, seed = 5 } = {}) {
	const parts = [new Float32Array(Math.round(leadSec * 48000)).fill(NaN)];
	const voice = [];
	const sign = invert ? -1 : 1;
	for (const t of txs) {
		const { bits, voice: v } = dstarTxBits(t);
		voice.push(v);
		parts.push(gmsk(bits).map((f) => sign * f * 1200 + cfoHz));
		parts.push(new Float32Array(Math.round(t.gapSec * 48000)).fill(NaN));
	}
	let freq = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
	let pos = 0;
	for (const p of parts) {
		freq.set(p, pos);
		pos += p.length;
	}
	freq = clock(freq, ppm).subarray(Math.round(skipSec * 48000));
	return { iq: channel(fmIq(freq), { cnrDb, bandwidthHz: 6250, filterHz: 4500, seed }), voice };
}
