// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR from OnAir core/src/nxdn/nxdn_gen.cpp (FrameBuilder, nxdnKnownVoice, nxdnTxSymbols,
// nxdnTestSchedule, NxdnGenerator: raised cosine 4FSK, symbol errors, clock error) and core/include/dect2/nxdn/nxdn_gen.h
// (NxdnGenTx), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the signal is made at BrowSDR's 48 kHz DSD rate with the channel at 0 Hz plus the tuning error; the noise is a
// carrier-to-noise ratio in the channel bandwidth followed by a channel filter (voice-fixtures.js); with validVoice the
// voice frames are valid AMBE+2 frames (OnAir sends a known bit pattern, there is no free encoder); lich overrides the
// LICH of the voice frames (DSD's sync words know only RDCH ones).
import {
	CAC,
	FACCH1,
	FCT_CAC,
	FCT_SACCH_NS,
	FCT_SACCH_SF,
	FRAME_SYM,
	FSW,
	FSW_SYM,
	IDLE,
	PN9,
	RCCH,
	RTCH,
	SACCH,
	SD_DATA,
	SD_HEADER,
	SITE_INFO,
	SRV_INFO,
	STAT_REQ,
	TX_REL,
	VCALL,
	buildMsg,
	dibitToSym,
	emptyMsg,
	encode,
	lichEncode,
} from '@/worker/decoders/dsd/nxdn/proto';
import { ambeEncode, channel, fmIq, randomBits, rngOf } from '../voice-fixtures.js';

export function tx(overrides = {}) {
	return {
		kind: 'voice',
		baud: 2400,
		src: 1001,
		dst: 200,
		callType: 1,
		ran: 1,
		cipher: 0,
		sacchGlitchCipher: 0,
		status: 0,
		text: '',
		durSec: 2,
		gapSec: 0.8,
		noHeader: false,
		noRelease: false,
		location: 0x012345,
		...overrides,
	};
}

/** OnAir's known voice bits of voice frame fn (there is no free AMBE+2 encoder). */
export function nxdnKnownVoice(fn) {
	let s = (Math.imul(fn, 2654435761) + 12345) >>> 0;
	const out = new Uint8Array(72);
	for (let i = 0; i < 72; i++) {
		s = (Math.imul(s, 1103515245) + 12345) >>> 0;
		out[i] = (s >>> 16) & 1;
	}
	return out;
}

/** BrowSDR: a valid AMBE+2 frame for voice frame fn. */
export function nxdnValidVoice(fn) {
	return ambeEncode(randomBits((fn * 6151 + 17) >>> 0, 49));
}

class FrameBuilder {
	constructor(out, ran) {
		this.out = out;
		this.ran = ran;
	}
	/** payload: the channel bits after the LICH (348 or fewer, the rest zeros). */
	frame(l, payload) {
		for (const s of FSW) this.out.push(s);
		const s = [];
		const lv = lichEncode(l);
		for (let i = 7; i >= 0; i--) s.push((lv >> i) & 1 ? -3 : 3);
		const p = new Uint8Array(348);
		p.set(payload.slice(0, 348));
		for (let i = 0; i + 1 < 348; i += 2) s.push(dibitToSym((p[i] << 1) | p[i + 1]));
		for (let i = 0; i < s.length; i++) this.out.push(PN9[i] ? -s[i] : s[i]);
	}
	sacch(structure, msg18) {
		const info = new Uint8Array(26);
		info[0] = (structure >> 1) & 1;
		info[1] = structure & 1;
		for (let i = 0; i < 6; i++) info[2 + i] = (this.ran >> (5 - i)) & 1;
		if (msg18) info.set(msg18, 8);
		return Array.from(encode(SACCH, info));
	}
	facch(m) {
		return Array.from(encode(FACCH1, buildMsg(m, 80)));
	}
	/** A frame of two FACCH1 (non-superframe SACCH). */
	facchFrame(a, b) {
		this.frame({ rfct: RTCH, fct: FCT_SACCH_NS, opt: 0, dir: 1 }, [...this.sacch(0, null), ...this.facch(a), ...this.facch(b)]);
	}
}

const msgOf = (t, type, extra = {}) => ({ ...emptyMsg(type), callType: t.callType, src: t.src, dst: t.dst, cipher: t.cipher, ...extra });

function siteFrames(fb, t) {
	const n = Math.max(1, Math.round(t.durSec / (FRAME_SYM / t.baud)));
	for (let f = 0; f < n; f++) {
		const s = { ...emptyMsg(f % 2 ? SRV_INFO : SITE_INFO), location: t.location, channel: 0x0101, service: 0x3c00 };
		const info = new Uint8Array(155);
		for (let i = 0; i < 6; i++) info[2 + i] = (t.ran >> (5 - i)) & 1;
		info.set(buildMsg(s, 147), 8);
		fb.frame({ rfct: RCCH, fct: FCT_CAC, opt: 0, dir: 1 }, Array.from(encode(CAC, info)));
	}
}

function dataFrames(fb, t) {
	const blocks = Math.floor((t.text.length + 7) / 8);
	const q = [msgOf(t, SD_HEADER, { blocks })];
	for (let b = 0; b < blocks; b++) q.push({ ...emptyMsg(SD_DATA), block: b, text: t.text.slice(b * 8, b * 8 + 8) });
	q.push(msgOf(t, TX_REL));
	if (q.length % 2) q.push(emptyMsg(IDLE));
	for (let i = 0; i < q.length; i += 2) fb.facchFrame(q[i], q[i + 1]);
}

/** The symbols (-3 -1 +1 +3) of one transmission, preamble to the last frame, and the voice frames sent. */
export function nxdnTxSymbols(t, { validVoice = false, lich } = {}) {
	const sym = [];
	const voice = [];
	const fb = new FrameBuilder(sym, t.ran);
	for (let i = 0; i < 24; i++) sym.push(i % 2 ? -3 : 3); // preamble
	if (t.kind === 'site') siteFrames(fb, t);
	else if (t.kind === 'status') {
		const m = msgOf(t, STAT_REQ, { status: t.status });
		fb.facchFrame(m, m);
	} else if (t.kind === 'data') dataFrames(fb, t);
	else {
		const m = msgOf(t, VCALL);
		if (!t.noHeader) fb.facchFrame(m, m);
		const sf = buildMsg(m, 72);
		const bad = buildMsg({ ...m, cipher: t.sacchGlitchCipher, keyId: 5 }, 72);
		const n = Math.max(4, Math.round(t.durSec / (FRAME_SYM / t.baud) / 4) * 4);
		for (let f = 0; f < n; f++) {
			const use = t.sacchGlitchCipher && Math.floor(f / 4) === 2 ? bad : sf;
			const p = fb.sacch(3 - (f % 4), use.subarray(18 * (f % 4), 18 * (f % 4) + 18));
			for (let v = 0; v < 4; v++) {
				const vb = validVoice ? nxdnValidVoice(voice.length) : nxdnKnownVoice(voice.length);
				voice.push(vb);
				p.push(...vb);
			}
			fb.frame(lich ?? { rfct: RTCH, fct: FCT_SACCH_SF, opt: 3, dir: 1 }, p);
		}
		if (!t.noRelease) {
			const rel = msgOf(t, TX_REL);
			fb.facchFrame(rel, rel);
		}
	}
	return { sym: Int8Array.from(sym), voice };
}

export function nxdnTestSchedule() {
	return [
		tx({ kind: 'site', baud: 4800, durSec: 1, ran: 5, location: 0x0a4c2b }),
		tx({ baud: 2400, src: 1001, dst: 200, callType: 1, ran: 1, durSec: 2 }),
		tx({ kind: 'status', baud: 2400, src: 1002, dst: 1001, callType: 4, status: 17, ran: 1 }),
		tx({ kind: 'data', baud: 4800, src: 2005, dst: 2001, callType: 4, text: 'HELLO FROM NXDN96', ran: 5 }),
		tx({ baud: 4800, src: 2001, dst: 2002, callType: 4, ran: 5, durSec: 1.5 }),
	];
}

/** Raised cosine (roll-off 0.2) shaped frequency in Hz at 48 kHz: 350 Hz per level at 2400 baud, 800 at 4800. */
function shape(sym, baud, ppm) {
	const sps = 48000 / baud / (1 + ppm * 1e-6);
	const unit = baud === 4800 ? 800 : 350;
	const span = 4;
	const a = 0.2;
	const rc = (t) => {
		const sinc = Math.abs(t) < 1e-9 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
		const d = 1 - 4 * a * a * t * t;
		return sinc * (Math.abs(d) < 1e-9 ? Math.PI / 4 : Math.cos(Math.PI * a * t) / d);
	};
	const out = new Float32Array(Math.ceil(sym.length * sps));
	for (let n = 0; n < out.length; n++) {
		const t = n / sps;
		const c = Math.round(t);
		let f = 0;
		for (let k = c - span; k <= c + span; k++) if (k >= 0 && k < sym.length) f += sym[k] * unit * rc(t - k);
		out[n] = f;
	}
	return out;
}

/**
 * The transmissions in a row over the channel (OnAir NxdnGenerator): leadSec of no carrier first, each transmission
 * followed by its gap without carrier. symErrRate: fraction of the symbols after the preamble, frame syncs excepted,
 * sent one level wrong. cnrDb in bandwidthHz (OnAir: 12.5 kHz), the channel filter at filterHz.
 */
export function nxdnSignal(txs, o = {}) {
	const { cnrDb = 99, cfoHz = 0, ppm = 0, symErrRate = 0, leadSec = 0.3, seed = 3, validVoice = false, lich } = o;
	const { bandwidthHz = 12500, filterHz = 6000 } = o;
	const rng = rngOf(seed * 747796405 + 1);
	const parts = [new Float32Array(Math.round(leadSec * 48000)).fill(NaN)];
	const voice = [];
	for (const t of txs) {
		const { sym, voice: v } = nxdnTxSymbols(t, { validVoice, lich });
		voice.push(...v);
		if (symErrRate > 0)
			for (let k = 24; k < sym.length; k++) {
				if ((k - 24) % FRAME_SYM < FSW_SYM) continue;
				if (rng() < symErrRate) sym[k] = sym[k] === 3 ? 1 : sym[k] === -3 ? -1 : sym[k] === 1 ? 3 : -3;
			}
		parts.push(shape(sym, t.baud, ppm).map((f) => f + cfoHz));
		parts.push(new Float32Array(Math.round(t.gapSec * 48000)).fill(NaN));
	}
	const freq = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
	let pos = 0;
	for (const p of parts) {
		freq.set(p, pos);
		pos += p.length;
	}
	return { iq: channel(fmIq(freq), { cnrDb, bandwidthHz, filterHz, seed }), voice };
}
