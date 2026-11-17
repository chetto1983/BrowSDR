// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR from OnAir core/src/dpmr/dpmr_gen.cpp (Builder, dpmrKnownVoice, dpmrTxSymbols,
// dpmrTestSchedule, DpmrGenerator: raised cosine 4FSK, symbol errors, clock error) and core/include/dect2/dpmr/dpmr_gen.h
// (DpmrGenTx), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the signal is made at BrowSDR's 48 kHz DSD rate with the channel at 0 Hz plus the tuning error, the noise is a
// carrier-to-noise ratio in 6.25 kHz followed by a channel filter (voice-fixtures.js); with validVoice the voice frames
// are valid AMBE+2 frames (OnAir sends a known bit pattern, there is no free encoder) so that mbelib counts their errors.
import {
	FS1,
	FS2,
	FS3,
	FS4,
	MODE_DATA2,
	MODE_PACKET,
	blockEncode,
	ccSymbols,
	cchBits,
	dataBits,
	dibitToSym,
	endBits,
	headerBits,
	pn9,
} from '@/worker/decoders/dsd/dpmr/proto';
import { ambeEncode, channel, fmIq, randomBits, rngOf } from '../voice-fixtures.js';

export function tx(overrides = {}) {
	return {
		kind: 'voice',
		own: 1001,
		called: 200,
		callType: 1,
		cc: 7,
		status: 0,
		emergency: false,
		text: '',
		durSec: 2,
		gapSec: 0.8,
		noHeader: false,
		noEnd: false,
		...overrides,
	};
}

/** OnAir's known voice bits of voice frame fn (there is no free AMBE+2 encoder). */
export function dpmrKnownVoice(fn) {
	let s = (Math.imul(fn, 2246822519) + 777) >>> 0;
	const out = new Uint8Array(72);
	for (let i = 0; i < 72; i++) {
		s = (Math.imul(s, 1103515245) + 12345) >>> 0;
		out[i] = (s >>> 16) & 1;
	}
	return out;
}

/** BrowSDR: a valid AMBE+2 frame for voice frame fn. */
export function dpmrValidVoice(fn) {
	return ambeEncode(randomBits((fn * 7919 + 5) >>> 0, 49));
}

class Builder {
	sym = [];
	sync = [];
	add(v, isSync) {
		this.sym.push(v);
		this.sync.push(isSync ? 1 : 0);
	}
	syms(v, isSync) {
		for (const x of v) this.add(x, isSync);
	}
	bits(b) {
		for (let i = 0; i + 1 < b.length; i += 2) this.add(dibitToSym((b[i] << 1) | b[i + 1]), false);
	}
	block(info, nWords) {
		this.bits(blockEncode(info, nWords));
	}
	cc(c) {
		this.syms(ccSymbols(c), false);
	}
	header(h, c, packet) {
		this.syms(packet ? FS4 : FS1, true);
		const info = headerBits(h);
		this.block(info, 10);
		this.cc(c);
		this.block(info, 10);
	}
	frameStart(f, c) {
		if (f % 2 === 0) this.syms(FS2, true);
		else this.cc(c);
	}
	cch(x) {
		this.block(cchBits(x), 6);
	}
	end(own) {
		this.syms(FS3, true);
		this.block(endBits({ type: 0, own }), 6);
	}
}

const idPart = (t, f) => ((f % 4 < 2 ? t.called : t.own) >> (f % 2 ? 0 : 12)) & 0xfff;

/** The symbols of one transmission, preamble to end frame, the sync flags and the voice frames sent. */
export function dpmrTxSymbols(t, { validVoice = false } = {}) {
	const b = new Builder();
	const voice = [];
	for (let i = 0; i < 36; i++) b.add(i % 2 ? -3 : 3, true); // preamble (kept free of symbol errors, like the syncs)
	const h = { type: 0, called: t.called, own: t.own, commMode: 0, callType: t.callType, emergency: t.emergency, extra: 0 };
	if (t.kind === 'status') {
		b.header({ ...h, type: 5, commMode: 2, extra: t.status }, t.cc, false);
		b.end(t.own);
		return { sym: Int8Array.from(b.sym), sync: Uint8Array.from(b.sync), voice };
	}
	if (t.kind === 'message' || t.kind === 'packet') {
		const blocks = Math.max(1, Math.floor((t.text.length + 20) / 21));
		const commMode = t.kind === 'packet' ? MODE_PACKET : MODE_DATA2;
		b.header({ ...h, commMode, extra: blocks }, t.cc, t.kind === 'packet');
		for (let f = 0; f < blocks; f++) {
			b.frameStart(f, t.cc);
			b.cch({ frame: f % 4, idPart: idPart(t, f), commMode, version: 0, callType: t.callType, emergency: false, slowData: 0 });
			b.block(dataBits(f, t.text.slice(f * 21, f * 21 + 21)), 24);
		}
		b.end(t.own);
		return { sym: Int8Array.from(b.sym), sync: Uint8Array.from(b.sync), voice };
	}
	if (!t.noHeader) b.header(h, t.cc, false);
	const n = Math.max(4, Math.round(t.durSec / 0.08 / 4) * 4);
	const pn = pn9(288);
	for (let f = 0; f < n; f++) {
		b.frameStart(f, t.cc);
		b.cch({ frame: f % 4, idPart: idPart(t, f), commMode: 0, version: 0, callType: t.callType, emergency: t.emergency, slowData: 0x2a5a5 });
		const tch = new Uint8Array(288);
		for (let v = 0; v < 4; v++) {
			const frame = validVoice ? dpmrValidVoice(voice.length) : dpmrKnownVoice(voice.length);
			voice.push(frame);
			tch.set(frame, 72 * v);
		}
		for (let i = 0; i < 288; i++) tch[i] ^= pn[i];
		b.bits(tch);
	}
	if (!t.noEnd) b.end(t.own);
	return { sym: Int8Array.from(b.sym), sync: Uint8Array.from(b.sync), voice };
}

export function dpmrTestSchedule() {
	return [
		tx({ own: 1001, called: 200, callType: 1, cc: 7, durSec: 2 }),
		tx({ kind: 'status', own: 1002, called: 1001, callType: 0, status: 17, cc: 7 }),
		tx({ kind: 'message', own: 2005, called: 2001, callType: 0, cc: 12, text: 'HELLO FROM DPMR PMR446 CHANNEL' }),
		tx({ kind: 'packet', own: 2006, called: 0xffffff, callType: 2, cc: 12, text: 'PACKET DATA' }),
		tx({ own: 2001, called: 2002, callType: 0, cc: 12, durSec: 1.5, emergency: true }),
	];
}

/** Raised cosine (roll-off 0.2) shaped frequency in Hz at 48 kHz, 350 Hz per level. */
function shape(sym, rateScale) {
	const sps = 20 / rateScale;
	const span = 4;
	const out = new Float32Array(Math.ceil((sym.length + 2 * span) * sps));
	const a = 0.2;
	const rc = (t) => {
		const sinc = Math.abs(t) < 1e-9 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
		const d = 1 - 4 * a * a * t * t;
		return sinc * (Math.abs(d) < 1e-9 ? Math.PI / 4 : Math.cos(Math.PI * a * t) / d);
	};
	for (let n = 0; n < out.length; n++) {
		const t = n / sps - span;
		const c = Math.round(t);
		let f = 0;
		for (let k = c - span; k <= c + span; k++) if (k >= 0 && k < sym.length) f += sym[k] * 350 * rc(t - k);
		out[n] = f;
	}
	return out;
}

/**
 * The transmissions in a row over the channel (OnAir DpmrGenerator): leadSec of no carrier first, each transmission
 * followed by its gap without carrier. symErrRate: fraction of the non-sync symbols sent one level wrong.
 */
export function dpmrSignal(txs, { cnrDb = 99, cfoHz = 0, ppm = 0, symErrRate = 0, leadSec = 0.3, seed = 3, validVoice = false } = {}) {
	const rng = rngOf(seed * 747796405 + 1);
	const parts = [new Float32Array(Math.round(leadSec * 48000)).fill(NaN)];
	const voice = [];
	for (const t of txs) {
		const { sym, sync, voice: v } = dpmrTxSymbols(t, { validVoice });
		voice.push(...v);
		if (symErrRate > 0)
			for (let k = 0; k < sym.length; k++)
				if (!sync[k] && rng() < symErrRate) sym[k] = sym[k] === 3 ? 1 : sym[k] === -3 ? -1 : sym[k] === 1 ? 3 : -3;
		parts.push(shape(sym, 1 + ppm * 1e-6).map((f) => f + cfoHz));
		parts.push(new Float32Array(Math.round(t.gapSec * 48000)).fill(NaN));
	}
	const freq = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
	let pos = 0;
	for (const p of parts) {
		freq.set(p, pos);
		pos += p.length;
	}
	return { iq: channel(fmIq(freq), { cnrDb, bandwidthHz: 6250, filterHz: 3600, seed }), voice };
}
