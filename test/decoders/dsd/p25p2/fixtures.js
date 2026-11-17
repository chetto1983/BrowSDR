// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR from OnAir core/src/p25p2/p25p2_gen.cpp (p25p2VoiceBits, p25p2VoiceFrames,
// p25p2Dibits, p25p2Modulate), core/include/dect2/p25p2/p25p2_gen.h (P25p2GenCall, P25p2GenConfig) and the MAC PDU
// builders of core/src/p25p2/p25p2_proto.cpp (macPtt, macEndPtt, macActive, macActiveUu, macSignal, macIdle, msgGrpVGrant,
// msgGrpVGrantUpd, msgUuVGrant, msgRfssSts, msgNetSts, msgAdjSts, msgIdenUp) and the impairments of
// tests/p25p2/test_p25p2_impair.cpp (run: clock error, simulcast echo, Rayleigh fading, drop-out),
// https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the signal is made at BrowSDR's 48 kHz DSD rate (8 samples per symbol) and goes through the channel of
// voice-fixtures.js (noise in the 6 kHz of the symbol rate, as OnAir's snrDb, and BrowSDR's DDC channel filter); the
// impairments of OnAir's test are options of the signal (the fading phases come from the test's own generator); the MAC PDUs use the coding of the standard only (OnAir's earlier
// private layout is not ported); with voiceBits the voice frames can be valid AMBE+2 frames (OnAir sends a known bit
// pattern, there is no free encoder) so that mbelib counts their errors.
//
// P25 Phase 2 test signal: a base station downlink of two logical channels made of the bursts of protocol.ts, differential
// QPSK through a root raised cosine, with a carrier offset and noise. The superframe (which slots carry the sync word, the
// I-ISCH, the order of 4V / 2V / SACCH bursts of each channel), the voice and ESS places and the scrambling follow the
// on-air layout.
import {
	DIBIT_STEP,
	DUID_2V,
	DUID_4V,
	DUID_FACCH,
	DUID_POSITIONS,
	DUID_SACCH,
	ESS_A1_POS,
	ESS_A2_POS,
	ESS_B_POS,
	FACCH_AIR_BYTES,
	ROLL_OFF,
	SACCH_AIR_BYTES,
	P25P2_VOICE_OFFSETS,
	ambePut,
	ambeUnflatten,
	duidPut,
	essEncode,
	hexbitsPut,
	ischInfo,
	ischInfoOf,
	ischSync,
	macEncodeAir,
	payloadPut,
	p25p2Scramble,
	rrcImpulse,
} from '@/worker/decoders/dsd/p25p2/protocol';
import { channel, rngOf } from '../voice-fixtures.js';

const M64 = (1n << 64n) - 1n;

export function mix(x) {
	x = (x + 0x9e3779b97f4a7c15n) & M64;
	x = ((x ^ (x >> 30n)) * 0xbf58476d1ce4e5b9n) & M64;
	x = ((x ^ (x >> 27n)) * 0x94d049bb133111ebn) & M64;
	return x ^ (x >> 31n);
}

/** The 72 voice bits of the index-th voice frame of a logical channel (a pattern known to the tests). */
export function p25p2VoiceBits(ch, index) {
	let x = mix((BigInt(ch) << 32n) ^ BigInt(index));
	const bits = new Uint8Array(72);
	for (let i = 0; i < 72; i++) {
		if (i % 64 === 0 && i) x = mix(x);
		bits[i] = Number((x >> BigInt(i % 64)) & 1n);
	}
	return bits;
}

// ---------------------------------------------------------------- MAC PDU builders (each padded with zero bytes to n)

export const macHeaderByte = (opcode, offset) => ((opcode & 7) << 5) | ((offset & 7) << 2);
export const put16 = (p, at, v) => p.splice(at, 2, (v >> 8) & 0xff, v & 0xff);
export const put24 = (p, at, v) => p.splice(at, 3, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
const pad = (v, n) => Uint8Array.from({ length: n }, (_, i) => v[i] ?? 0);

/** A message: the opcode and the 64 argument bits (a BigInt), most significant byte first. */
function argMsg(op, a) {
	return [op, ...Array.from({ length: 8 }, (_, i) => Number((a >> BigInt(56 - 8 * i)) & 0xffn))];
}

export function macPtt(n, src, group, algId, keyId = 0, mi = null) {
	const v = new Array(18).fill(0);
	v[0] = macHeaderByte(1, 0);
	v[10] = algId;
	put16(v, 11, keyId);
	if (mi) for (let i = 0; i < 9; i++) v[1 + i] = mi[i];
	put24(v, 13, src);
	put16(v, 16, group);
	return pad(v, n);
}

export function macEndPtt(n, src, group, colorCode) {
	const v = new Array(18).fill(0);
	v[0] = macHeaderByte(2, 0);
	put16(v, 1, colorCode & 0xfff);
	put24(v, 13, src);
	put16(v, 16, group);
	return pad(v, n);
}

export function macActive(n, svcOpts, group, src) {
	const v = [macHeaderByte(4, 0), 0x01, svcOpts, 0, 0, 0, 0, 0];
	put16(v, 3, group);
	put24(v, 5, src);
	return pad(v, n);
}

export function macActiveUu(n, svcOpts, target, src) {
	const v = [macHeaderByte(4, 0), 0x02, svcOpts, 0, 0, 0, 0, 0, 0];
	put24(v, 3, target);
	put24(v, 6, src);
	return pad(v, n);
}

export const macSignal = (n, msgs) => pad([macHeaderByte(0, 0), ...msgs.flat()], n);
export const macIdle = (n) => pad([macHeaderByte(3, 0)], n);

const B = (v, shift) => BigInt(v) << BigInt(shift);
export const msgGrpVGrant = (svc, ch, group, src) =>
	argMsg(0x40, B(svc & 0xff, 56) | B(ch & 0xffff, 40) | B(group & 0xffff, 24) | B(src & 0xffffff, 0));
export const msgGrpVGrantUpd = (ch1, g1, ch2, g2) =>
	argMsg(0x42, B(ch1 & 0xffff, 48) | B(g1 & 0xffff, 32) | B(ch2 & 0xffff, 16) | B(g2 & 0xffff, 0));
export const msgUuVGrant = (ch, target, src) => argMsg(0x44, B(ch & 0xffff, 48) | B(target & 0xffffff, 24) | B(src & 0xffffff, 0));
export const msgRfssSts = (lra, sysId, rfss, site, ch, ssc) =>
	argMsg(0x7a, B(lra & 0xff, 56) | B(sysId & 0xfff, 40) | B(rfss & 0xff, 32) | B(site & 0xff, 24) | B(ch & 0xffff, 8) | B(ssc & 0xff, 0));
export const msgNetSts = (lra, wacn, sysId, ch, ssc) =>
	argMsg(0x7b, B(lra & 0xff, 56) | B(wacn & 0xfffff, 36) | B(sysId & 0xfff, 24) | B(ch & 0xffff, 8) | B(ssc & 0xff, 0));
export const msgAdjSts = (lra, sysId, rfss, site, ch, ssc) =>
	argMsg(0x7c, B(lra & 0xff, 56) | B(sysId & 0xfff, 40) | B(rfss & 0xff, 32) | B(site & 0xff, 24) | B(ch & 0xffff, 8) | B(ssc & 0xff, 0));
/** bandwidth in 125 Hz units, transmit offset in 250 kHz units (8 bits + sign, set for positive), spacing in 125 Hz units, base in 5 Hz units. */
export const msgIdenUp = (id, bw125, txOffset250k, spacing125, base5Hz) =>
	argMsg(0x7d, B(id & 15, 60) | B(bw125 & 0x1ff, 51) | B(txOffset250k & 0x1ff, 42) | B(spacing125 & 0x3ff, 32) | B(base5Hz >>> 0, 0));

// ---------------------------------------------------------------- the signal

export function genCall(over = {}) {
	return {
		channel: 1, // logical channel (time slot) 1 or 2
		startSf: 1, // superframe in which the PTT is sent
		nSf: 6, // superframes the call lasts (the END_PTT is in the last)
		src: 1234567,
		group: 1001,
		algId: 0x80, // 0x80 clear; anything else: reported as encrypted, its voice is never decoded
		unitToUnit: false, // group stays the target unit
		keyId: 0x1234,
		pttInfo: false, // the PTT carries the message indicator and key ID of the ESS
		noPtt: false, // no PTT is sent: a listener joins the call late
		noEss: false, // the ESS fields of the voice bursts are random
		essBadSf: -1, // in this superframe the ESS-A is random: one ESS is lost
		svcOpts: 0, // 0x80 emergency, 0x40 encrypted in the voice channel user message
		...over,
	};
}

export function genConfig(over = {}) {
	return {
		snrDb: 40, // in a 6 kHz bandwidth (the symbol rate)
		cfoHz: 0,
		ppm: 0, // symbol clock error of the transmitter
		echoUs: 0, // a simulcast echo: delay, level and frequency offset
		echoDb: -6,
		echoDf: 0,
		fadeHz: 0, // Rayleigh fading (Doppler spread)
		dropSec: 0, // the signal drops out for this long every 2 s
		noiseOnly: false,
		superframes: 12,
		leadDibits: 13, // random dibits in front of the first sync (not a whole slot)
		colorCode: 0x293, // the NAC: sent in the END_PTT, and a part of the scrambling seed
		scramble: false,
		wacn: 0xbee00,
		sysId: 0x3a5,
		seed: 7,
		dropFirstSlots: 0, // the signal starts this many slots into the first superframe
		calls: [],
		sysMsgs: [], // MAC messages sent round robin in the signalling bursts of idle channels
		voiceBits: p25p2VoiceBits,
		...over,
	};
}

// What a logical channel sends in its p-th burst of the superframe during a call (as heard on the NSW PSN): channel 1
// (slots 0, 2, 4, 6, 8, 11) 4V 4V 4V 4V 2V SACCH, channel 2 (slots 1, 3, 5, 7, 9, 10) 4V 4V 4V 2V 4V SACCH
const K4V = 0;
const K2V = 1;
const KSIG = 2;
const kindOf = (ch, p) => (p === 5 ? KSIG : ch === 1 ? (p === 4 ? K2V : K4V) : p === 3 ? K2V : K4V);
const SLOT_OF = [
	[0, 2, 4, 6, 8, 11],
	[1, 3, 5, 7, 9, 10],
];
const callAt = (c, ch, sf) => c.calls.find((k) => k.channel === ch && sf >= k.startSf && sf < k.startSf + k.nSf);
/** A burst of the call that carries voice: neither the PTT (first burst of the first superframe) nor the END_PTT. */
const carriesVoice = (k, sf, p) => !(sf === k.startSf && p === 0) && !(sf === k.startSf + k.nSf - 1 && p === 5) && p !== 5;

/** How many voice frames a call put on the air (clear or not). */
export function p25p2VoiceFrames(c, ch) {
	let n = 0;
	for (const k of c.calls) {
		if (k.channel !== ch) continue;
		for (let sf = k.startSf; sf < k.startSf + k.nSf && sf < c.superframes; sf++)
			for (let p = 0; p < 6; p++) if (carriesVoice(k, sf, p)) n += kindOf(ch, p) === K4V ? 4 : 2;
	}
	return n;
}

function signalling(b, facch, mac) {
	payloadPut(macEncodeAir(facch, mac), 156, b);
	duidPut(facch ? DUID_FACCH : DUID_SACCH, b);
}

function voiceBurst(c, call, ch, sf, p, b, st) {
	const mi = Array.from({ length: 9 }, (_, i) => (call.algId === 0x80 ? 0 : 0x11 * (i + 1)));
	let { b: essB, a: essA } = essEncode(call.algId, call.algId === 0x80 ? 0 : call.keyId, mi);
	const junk = (v) => v.map(() => st.rnd() | (st.rnd() << 2));
	if (call.noEss) [essB, essA] = [junk(essB), junk(essA)];
	else if (sf === call.essBadSf) essA = junk(essA);
	const v4 = kindOf(ch, p) === K4V;
	for (let k = 0; k < (v4 ? 4 : 2); k++) ambePut(ambeUnflatten(c.voiceBits(ch, st.vidx[ch]++)), P25P2_VOICE_OFFSETS[k], b);
	if (v4) {
		if (st.essPart[ch] >= 4) st.essPart[ch] = 0;
		hexbitsPut(essB.subarray(4 * st.essPart[ch]++), 4, b, ESS_B_POS);
	} else {
		hexbitsPut(essA, 16, b, ESS_A1_POS);
		hexbitsPut(essA.subarray(16), 12, b, ESS_A2_POS);
		st.essPart[ch] = 0;
	}
	duidPut(v4 ? DUID_4V : DUID_2V, b);
}

function channelBurst(c, ch, sf, p, b, st) {
	const call = callAt(c, ch, sf);
	const [nF, nS] = [FACCH_AIR_BYTES, SACCH_AIR_BYTES];
	if (!call) {
		const facch = p !== 5;
		const n = facch ? nF : nS;
		signalling(b, facch, c.sysMsgs.length ? macSignal(n, [c.sysMsgs[st.sysIdx++ % c.sysMsgs.length]]) : macIdle(n));
		return;
	}
	const first = sf === call.startSf;
	const last = sf === call.startSf + call.nSf - 1;
	if (first && p === 0) {
		const mi = Array.from({ length: 9 }, (_, i) => (call.algId === 0x80 ? 0 : 0x11 * (i + 1)));
		const key = call.algId === 0x80 ? 0 : call.keyId;
		const ptt = call.pttInfo ? macPtt(nF, call.src, call.group, call.algId, key, mi) : macPtt(nF, call.src, call.group, call.algId);
		signalling(b, true, call.noPtt ? macIdle(nF) : ptt);
	} else if (last && p === 5) signalling(b, true, macEndPtt(nF, call.src, call.group, c.colorCode));
	else if (p === 5) signalling(b, false, (call.unitToUnit ? macActiveUu : macActive)(nS, call.svcOpts, call.group, call.src));
	else voiceBurst(c, call, ch, sf, p, b, st);
}

/** The dibits of the whole signal, starting with the lead-in. */
export function p25p2Dibits(c) {
	const out = [];
	let rs = mix(BigInt(c.seed));
	const st = {
		rnd: () => {
			rs = mix(rs);
			return Number(rs & 3n);
		},
		vidx: [0, 0, 0],
		essPart: [0, 0, 0],
		sysIdx: 0,
	};
	for (let i = 0; i < c.leadDibits; i++) out.push(st.rnd());
	const seq = c.scramble ? p25p2Scramble(c.wacn, c.sysId, c.colorCode) : p25p2Scramble(0, 0, 0);
	for (let sf = 0; sf < c.superframes; sf++) {
		const burst = Array.from({ length: 12 }, () => new Uint8Array(180));
		for (let ch = 1; ch <= 2; ch++)
			for (let p = 0; p < 6; p++) {
				const b = burst[SLOT_OF[ch - 1][p]];
				for (let i = 0; i < 180; i++) b[i] = st.rnd();
				channelBurst(c, ch, sf, p, b, st);
			}
		for (let s = 0; s < 12; s++) {
			const b = burst[s];
			// scrambled: everything but the ISCH and the DUID
			for (let i = 20; i < 180; i++) if (!DUID_POSITIONS.includes(i)) b[i] ^= seq[s * 180 + i];
			// the ISCH: the sync word in slots 2, 3, 6, 7, 10, 11, an I-ISCH (location, channel, ultraframe count) in the others
			if (s & 2) ischSync(b);
			else ischInfo(ischInfoOf(s & 1, s >> 2, 0, sf & 3), b);
			for (const d of b) out.push(d);
		}
	}
	if (c.dropFirstSlots > 0) out.splice(c.leadDibits, c.dropFirstSlots * 180);
	return Uint8Array.from(out);
}

/** Interleaved I/Q at 48 kHz of those dibits: unit power, the carrier offset, a clock error, noise and the channel filter. */
export function p25p2Modulate(dibits, c) {
	const sps = 8;
	const fs = 48000;
	const span = 6;
	const g = Float64Array.from({ length: 2 * span * sps + 1 }, (_, i) => rrcImpulse((i - span * sps) / sps, ROLL_OFF));
	const nOut = (dibits.length + 2 * span) * sps;
	const re = new Float64Array(nOut);
	const im = new Float64Array(nOut);
	let phase8 = 0; // multiples of pi/4
	for (let k = 0; k < dibits.length; k++) {
		phase8 += DIBIT_STEP[dibits[k]];
		const [sr, si] = [Math.cos((phase8 * Math.PI) / 4), Math.sin((phase8 * Math.PI) / 4)];
		const centre = (k + span) * sps;
		for (let j = -span * sps; j <= span * sps; j++) {
			re[centre + j] += sr * g[j + span * sps];
			im[centre + j] += si * g[j + span * sps];
		}
	}
	let pw = 0;
	for (let n = 0; n < nOut; n++) pw += re[n] * re[n] + im[n] * im[n];
	const scale = pw > 0 ? 1 / Math.sqrt(pw / nOut) : 1;
	const step = 1 + c.ppm * 1e-6;
	const len = Math.floor((nOut - 1) / step);
	const iq = new Float32Array(2 * len);
	for (let n = 0; n < len; n++) {
		// a symbol clock error of the transmitter: resample linearly
		const p = n * step;
		const k = Math.floor(p);
		const f = p - k;
		const vr = (re[k] * (1 - f) + re[k + 1] * f) * scale;
		const vi = (im[k] * (1 - f) + im[k + 1] * f) * scale;
		const ph = (2 * Math.PI * c.cfoHz * n) / fs;
		iq[2 * n] = vr * Math.cos(ph) - vi * Math.sin(ph);
		iq[2 * n + 1] = vr * Math.sin(ph) + vi * Math.cos(ph);
	}
	return channel(impair(iq, c), { cnrDb: c.snrDb, bandwidthHz: 6000, filterHz: 6250, seed: c.seed * 977 + 13 });
}

/** OnAir's impairments: a simulcast echo, eight-path Rayleigh fading, a drop-out every 2 s, or the signal taken away. */
function impair(x, c) {
	const fs = 48000;
	const rng = rngOf(11);
	const fph = Array.from({ length: 8 }, () => 2 * Math.PI * rng());
	const fdop = Array.from({ length: 8 }, (_, i) => c.fadeHz * Math.cos((2 * Math.PI * (i + 0.5)) / 16 + 0.3));
	const dly = Math.round(c.echoUs * 1e-6 * fs);
	const echoG = 10 ** (c.echoDb / 20);
	const o = new Float32Array(x.length);
	for (let i = 0; i < x.length / 2; i++) {
		const ts = i / fs;
		let [vr, vi] = c.noiseOnly ? [0, 0] : [x[2 * i], x[2 * i + 1]];
		if (dly && i >= dly) {
			const [er, ei] = [x[2 * (i - dly)] * echoG, x[2 * (i - dly) + 1] * echoG];
			const a = 2 * Math.PI * c.echoDf * ts;
			vr += er * Math.cos(a) - ei * Math.sin(a);
			vi += er * Math.sin(a) + ei * Math.cos(a);
		}
		if (c.fadeHz > 0) {
			let [fr, fi] = [0, 0];
			for (let k = 0; k < 8; k++) {
				fr += Math.cos(2 * Math.PI * fdop[k] * ts + fph[k]);
				fi += Math.sin(2 * Math.PI * fdop[k] * ts + fph[k]);
			}
			// eight unit phasors: power 8, scaled to 1
			[fr, fi] = [(fr / 4) * Math.SQRT2, (fi / 4) * Math.SQRT2];
			[vr, vi] = [vr * fr - vi * fi, vr * fi + vi * fr];
		}
		if (c.dropSec > 0 && ts % 2 > 1.5 && ts % 2 < 1.5 + c.dropSec) [vr, vi] = [0, 0];
		o[2 * i] = vr;
		o[2 * i + 1] = vi;
	}
	return o;
}

export const p25p2Signal = (c) => p25p2Modulate(p25p2Dibits(c), c);
