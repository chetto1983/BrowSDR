// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir core/src/vdl2/vdl2_gen.cpp (vdl2MakeWave, vdl2Render,
// vdl2BurstSeconds, the noise of Vdl2Synth), core/src/vdl2/vdl2_proto.cpp (vdl2BurstBits, vdl2HdlcBits, vdl2AcarsInfo,
// vdl2X25ClnpData, vdl2X25CallRequest, vdl2XidGsif, vdl2XidAircraftLe) and core/src/acars/acars_proto.cpp
// (acarsBuildFrame), https://github.com/adswill/OnAir; see third_party/onair. Changes: bursts are rendered back to back
// into one buffer instead of the real-time traffic scheduler; a burst can carry flipped bits to exercise the FEC.
//
// D8PSK bursts (raised cosine, roll-off 0.6) with the real burst structure: ramp, training sequence, header, scrambled
// Reed-Solomon coded data, AVLC frames. Synthetic content only.

import { HEADER_BITS, PREAMBLE_PHASE, PREAMBLE_SYMS, RS_K, RS_N, VDL2_SYMBOL_RATE } from '@/worker/decoders/digimode/vdl2/bits';
import { headerWord, layout, scramble, stepForBits } from '@/worker/decoders/digimode/vdl2/bits';
import { acarsCrc } from '@/worker/decoders/digimode/vdl2/acars';
import { rsEncode } from '@/worker/decoders/digimode/vdl2/rs';
import { noise } from './fixtures';

const RAMP = 3;
const TAIL = 2;
const SPAN = 5;
const RES = 256;

// ---------------------------------------------------------------- builders (vdl2_proto.cpp, acars_proto.cpp)

const withParity = (c) => {
	const c7 = c & 0x7f;
	let ones = 0;
	for (let x = c7; x; x &= x - 1) ones++;
	return ones & 1 ? c7 : c7 | 0x80;
};

/** One ACARS transmission without the pre-key: SYN SYN SOH, the block, check bytes (low first), DEL. */
export function acarsBuildFrame({ mode = '2', reg = '', ack = 0x15, label = 'H1', blockId = '0', text = '', lastBlock = true }) {
	const blk = [withParity(mode.charCodeAt(0))];
	const r = reg.slice(0, 7).padStart(7, '.');
	for (const c of r) blk.push(withParity(c.charCodeAt(0)));
	blk.push(withParity(ack));
	blk.push(withParity(label.charCodeAt(0)));
	blk.push(withParity(label[1] === 'd' && label[0] === '_' ? 0x7f : label.charCodeAt(1)));
	blk.push(withParity(blockId.charCodeAt(0)));
	if (text) {
		blk.push(0x02);
		for (const c of text.slice(0, 220)) blk.push(withParity(c.charCodeAt(0)));
	}
	blk.push(lastBlock ? 0x83 : 0x97);
	const crc = acarsCrc(Uint8Array.from(blk));
	return [0x16, 0x16, 0x01, ...blk, crc & 0xff, crc >> 8, 0x7f];
}

/** The information field of an ACARS block over AVLC: 0xFF 0xFF, SOH, block, check bytes, DEL. */
export function vdl2AcarsInfo(reg, label, blockId, text, { ack = 0x15, mode = '2', lastBlock = true } = {}) {
	return [0xff, 0xff, ...acarsBuildFrame({ mode, reg, ack, label, blockId, text, lastBlock }).slice(2)];
}

/** An X.25 data packet with a CLNP DT header and a COTP DT TPDU around `user` (the payload of an ATN application). */
export function vdl2X25ClnpData(lcn, ps, pr, src, dst, user) {
	const h = [0x81, 0, 0x01, 60, 0x1c, 0, 0, 0, 0, dst.length, ...dst, src.length, ...src];
	h[1] = h.length;
	const tp = [2, 0xf0, 0x80, ...user]; // COTP DT, end of TSDU, sequence 0
	const seg = h.length + tp.length;
	h[5] = seg >> 8;
	h[6] = seg & 0xff;
	return [0x10 | ((lcn >> 8) & 0xf), lcn & 0xff, ((pr & 7) << 5) | ((ps & 7) << 1), ...h, ...tp];
}

export function vdl2X25CallRequest(lcn, called, calling) {
	const o = [0x10 | ((lcn >> 8) & 0xf), lcn & 0xff, 0x0b, (calling.length << 4) | (called.length & 0xf)];
	const all = called + calling;
	for (let i = 0; i < all.length; i += 2) o.push((Number(all[i]) << 4) | (i + 1 < all.length ? Number(all[i + 1]) : 0));
	return [...o, 0, 0xc1, 0x00]; // no facilities; ICAO SNDCF, no compression options
}

/** C's lround: halves away from zero. */
const lround = (x) => (x < 0 ? -Math.round(-x) : Math.round(x));
const location = (lat, lon) => {
	const la = lround(lat * 10) & 0xfff;
	const lo = lround(lon * 10) & 0xfff;
	return [la >> 4, ((la & 0xf) << 4) | (lo >> 8), lo & 0xff];
};
const param = (id, v) => [id, v.length, ...v];
const xid = (vdl) => [0x82, 0x80, 0x00, 0x03, 0x01, 0x01, 0x00, 0xf0, vdl.length >> 8, vdl.length & 0xff, ...vdl];
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

/** XID information of a ground station information frame: location and airports. */
export const vdl2XidGsif = (lat, lon, airports) =>
	xid([...param(0x00, ascii('V2')), ...param(0xc8, location(lat, lon)), ...param(0xc1, ascii(airports))]);

/** XID information of an aircraft's link establishment: location, altitude, destination. */
export const vdl2XidAircraftLe = (lat, lon, altFt, dest) =>
	xid([
		...param(0x00, ascii('V2')),
		...param(0x01, [0x00]),
		...param(0x84, [...location(lat, lon), Math.max(0, Math.min(255, Math.floor((altFt + 500) / 1000)))]),
		...param(0x83, ascii(dest)),
	]);

/** Frames (FCS already appended) -> flags and stuffed bits, octets least significant bit first. */
export function vdl2HdlcBits(frames) {
	const out = [];
	const octet = (v) => {
		for (let b = 0; b < 8; b++) out.push((v >> b) & 1);
	};
	octet(0x7e);
	for (const f of frames) {
		let ones = 0;
		for (const v of f)
			for (let b = 0; b < 8; b++) {
				const bit = (v >> b) & 1;
				out.push(bit);
				if (!bit) ones = 0;
				else if (++ones === 5) {
					out.push(0);
					ones = 0;
				}
			}
		octet(0x7e);
	}
	return out;
}

/** The bits after the training sequence: header, data and FEC octets (column by column across the blocks), scrambled. */
export function vdl2BurstBits(dataBits) {
	const len = dataBits.length;
	const l = layout(len);
	const rows = Array.from({ length: l.blocks }, () => new Uint8Array(RS_N));
	dataBits.forEach((bit, i) => (rows[Math.floor(i / 8 / RS_K)][Math.floor(i / 8) % RS_K] |= (bit & 1) << (i % 8)));
	for (const row of rows) row.set(rsEncode(row), RS_K);
	const out = [];
	const hw = headerWord(len);
	for (let b = HEADER_BITS - 1; b >= 0; b--) out.push((hw >> b) & 1);
	const octet = (v) => {
		for (let b = 0; b < 8; b++) out.push((v >> b) & 1);
	};
	for (let c = 0; c < RS_K; c++) for (let r = 0; r < l.blocks; r++) if (r !== l.blocks - 1 || c < l.lastLen) octet(rows[r][c]);
	const fecRows = l.lastFec ? l.blocks : l.blocks - 1;
	for (let c = 0; c < RS_N - RS_K; c++) for (let r = 0; r < fecRows; r++) if (r !== l.blocks - 1 || c < l.lastFec) octet(rows[r][RS_K + c]);
	const bits = Uint8Array.from(out);
	scramble(bits, 0);
	return bits;
}

// ---------------------------------------------------------------- waveform (vdl2_gen.cpp)

const RC = (() => {
	const a = 0.6;
	const v = new Float64Array(2 * SPAN * RES + 2);
	for (let i = 0; i < v.length; i++) {
		const x = i / RES - SPAN; // in symbols
		const s = Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
		const d = 1 - 4 * a * a * x * x;
		const c = Math.abs(d) < 1e-9 ? Math.PI / 4 : Math.cos(Math.PI * a * x) / d;
		v[i] = s * c * (0.5 + 0.5 * Math.cos((Math.PI * x) / SPAN)); // gentle truncation
	}
	return v;
})();

function rc(x) {
	const u = (x + SPAN) * RES;
	if (u <= 0 || u >= 2 * SPAN * RES) return 0;
	const i = Math.floor(u);
	const f = u - i;
	return RC[i] * (1 - f) + RC[i + 1] * f;
}

/** Symbols for these frames (ramp, training, data, tail); `flip` lists burst bits (after the training sequence) sent wrong. */
export function vdl2MakeWave(frames, { flip = [] } = {}) {
	const bits = vdl2BurstBits(vdl2HdlcBits(frames));
	for (const i of flip) bits[i] ^= 1;
	const w = { start: 0, carHz: 0, amp: 0.08, phase: 0, ph: [], env: [] };
	for (const e of [0.2, 0.6, 0.9]) {
		w.ph.push(0);
		w.env.push(e);
	}
	for (let i = 0; i < PREAMBLE_SYMS; i++) {
		w.ph.push(((PREAMBLE_PHASE[i] % 8) + 8) % 8);
		w.env.push(1);
	}
	let cur = w.ph[w.ph.length - 1];
	for (let i = 0; i < bits.length; i += 3) {
		const b = (bits[i] << 2) | ((bits[i + 1] ?? 0) << 1) | (bits[i + 2] ?? 0);
		cur = (cur + stepForBits(b)) % 8;
		w.ph.push(cur);
		w.env.push(1);
	}
	for (let i = 0; i < TAIL; i++) {
		w.ph.push(cur);
		w.env.push(i ? 0.25 : 0.6);
	}
	return w;
}

/** Seconds a burst of these frames lasts. */
export const vdl2BurstSeconds = (frames) =>
	(RAMP + PREAMBLE_SYMS + Math.floor((vdl2BurstBits(vdl2HdlcBits(frames)).length + 2) / 3) + TAIL) / VDL2_SYMBOL_RATE;

/** Adds the part of the burst that falls into out[0 .. n) (complex, interleaved), where out[0] is input sample outStart. */
export function vdl2Render(w, out, outStart, n, rate) {
	const T = rate / VDL2_SYMBOL_RATE;
	const s0 = w.start - (RAMP + SPAN) * T;
	const s1 = w.start + (w.ph.length - RAMP + SPAN) * T;
	const a = Math.max(outStart, Math.ceil(s0));
	const b = Math.min(outStart + n, Math.floor(s1));
	const pts = Array.from({ length: 8 }, (_, k) => [w.amp * Math.cos((k * Math.PI) / 4), w.amp * Math.sin((k * Math.PI) / 4)]);
	const ns = w.ph.length;
	for (let i = a; i < b; i++) {
		const u = (i - w.start) / T + RAMP; // position in symbols
		let re = 0;
		let im = 0;
		for (let k = Math.max(0, Math.ceil(u - SPAN)); k <= Math.min(ns - 1, Math.floor(u + SPAN)); k++) {
			const g = w.env[k] * rc(u - k);
			re += pts[w.ph[k]][0] * g;
			im += pts[w.ph[k]][1] * g;
		}
		const ph = (2 * Math.PI * w.carHz * (i - w.start)) / rate + w.phase;
		const [c, s] = [Math.cos(ph), Math.sin(ph)];
		out[2 * (i - outStart)] += re * c - im * s;
		out[2 * (i - outStart) + 1] += re * s + im * c;
	}
}

/**
 * Bursts one after the other on one channel as complex samples at `rate`: each `{ frames, levelDb, flip }` starts
 * `gapSec` after the previous one ends, `offsetHz` off tune (each burst with its own carrier phase), in Gaussian noise
 * set by `snrDb` (Es/N0 of a 0 dB burst: signal power over the noise in 10.5 kHz, as OnAir's Vdl2Synth).
 */
export function vdl2Signal(bursts, { rate = 84000, offsetHz = 0, snrDb = 99, seed = 3, leadSec = 0.05, gapSec = 0.02 } = {}) {
	const waves = [];
	let t = leadSec;
	const random = noise(seed);
	for (const burst of bursts) {
		const w = vdl2MakeWave(burst.frames, { flip: burst.flip });
		w.start = t * rate;
		w.carHz = offsetHz;
		w.amp = 0.08 * 10 ** ((burst.levelDb ?? 0) / 20);
		w.phase = (random() + 0.5) * 2 * Math.PI;
		waves.push(w);
		t += vdl2BurstSeconds(burst.frames) + gapSec;
	}
	const count = Math.ceil((t + leadSec) * rate);
	const out = new Float32Array(2 * count);
	const sigma = snrDb >= 99 ? 0 : Math.sqrt(((0.08 * 0.08 * 0.85) / 10 ** (snrDb / 10)) * (rate / VDL2_SYMBOL_RATE) * 0.5);
	for (let i = 0; i < out.length; i += 2) {
		// Box-Muller from the seeded uniform source
		const r = Math.sqrt(-2 * Math.log(random() + 0.5 + 1e-12));
		const a = 2 * Math.PI * (random() + 0.5);
		out[i] = sigma * r * Math.cos(a);
		out[i + 1] = sigma * r * Math.sin(a);
	}
	for (const w of waves) vdl2Render(w, out, 0, count, rate);
	return out;
}
