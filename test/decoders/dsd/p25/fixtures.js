// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR from OnAir core/src/p25/p25_gen.cpp (FrameBuilder, lduHex, ldu, tsbkFrame,
// p25KnownVoice, p25TxSymbols, p25TestSchedule, P25Generator: raised cosine C4FM, clock error) and
// core/include/dect2/p25/p25_gen.h (P25GenTx), rust/onair_p25/src/imbe.rs (unflatten), https://github.com/adswill/OnAir;
// see third_party/onair.
// Changes: the signal is made at BrowSDR's 48 kHz DSD rate with the channel at 0 Hz plus the tuning error; the noise is a
// carrier-to-noise ratio in 12.5 kHz followed by a channel filter (voice-fixtures.js); with validVoice the voice frames
// are valid IMBE frames (OnAir sends a known bit pattern, there is no free encoder).
import { P25_IW, P25_IX, P25_IY, P25_IZ } from '@/worker/decoders/dsd/constants';
import { rsEncode } from '@/worker/decoders/dsd/p25p2/rs';
import {
	ALG_CLEAR,
	HDU,
	LC_GROUP,
	LC_TERM,
	LC_UNIT,
	LDU1,
	LDU2,
	OP_ADJ_STS,
	OP_GRP_V_GRANT,
	OP_GRP_V_GRANT_UPD,
	OP_IDEN_UP,
	OP_IDEN_UP_VU,
	OP_NET_STS,
	OP_RFSS_STS,
	PDU,
	STATUS_EVERY,
	SYNC,
	TDU,
	TDULC,
	TSBK,
	crcCcitt,
	esHexbits,
	frameLen,
	golay18Encode,
	golay24Encode,
	hamming10Encode,
	hduHexbits,
	isStatusPos,
	lcHexbits,
	nidEncode,
	symToDibit,
	dibitToSym,
	trellisEncode,
	tsbkBits,
} from '@/worker/decoders/dsd/p25/proto';
import { channel, fmIq, imbeEncode, randomBits } from '../voice-fixtures.js';

export function tx(overrides = {}) {
	return {
		kind: 'voice',
		nac: 0x293,
		wacn: 0xbee00,
		sysId: 0x3a1,
		rfss: 1,
		site: 5,
		ctrlChannel: 0x1001,
		adjSite: 6,
		adjChannel: 0x1009,
		idenBaseHz: 851006250,
		idenSpacingHz: 12500,
		script: [],
		grantTg: 1201,
		grantSrc: 1234567,
		grantChannel: 0x1010,
		src: 1234567,
		dst: 1201,
		group: true,
		emergency: false,
		algId: ALG_CLEAR,
		keyId: 0,
		noHeader: false,
		noTerm: false,
		llid: 1234567,
		/** BrowSDR: the number of the first voice frame (OnAir's known voice starts at 0 in each call). */
		voiceBase: 0,
		durSec: 2,
		gapSec: 0.6,
		...overrides,
	};
}

const LEN = [23, 23, 23, 23, 15, 15, 15, 7];

/** OnAir's known IMBE bits (c0..c7) of voice frame fn. */
export function p25KnownVoice(fn) {
	let s = (Math.imul(fn, 2654435761) + 777) >>> 0;
	const out = new Uint8Array(144);
	for (let i = 0; i < 144; i++) {
		s = (Math.imul(s, 1103515245) + 12345) >>> 0;
		out[i] = (s >>> 16) & 1;
	}
	return out;
}

/** 144 bits c0 first -> the 8 x 23 matrix as mbelib takes it (imbe.rs unflatten). */
export function imbeMatrix(bits) {
	const fr = new Int8Array(184);
	let p = 0;
	for (let r = 0; r < 8; r++) for (let j = 0; j < LEN[r]; j++) fr[r * 23 + j] = bits[p++];
	return fr;
}

/** The 72 dibits as sent of an 8 x 23 matrix (imbe.rs interleave). */
export function interleave(fr) {
	return Array.from({ length: 72 }, (_, i) => (fr[P25_IW[i] * 23 + P25_IX[i]] << 1) | fr[P25_IY[i] * 23 + P25_IZ[i]]);
}

const valBits = (v, n) => Array.from({ length: n }, (_, i) => Math.floor(Number(v) / 2 ** (n - 1 - i)) & 1);
const toDibits = (b) => Array.from({ length: b.length / 2 }, (_, i) => (b[2 * i] << 1) | b[2 * i + 1]);

class FrameBuilder {
	constructor(out, nac) {
		this.out = out;
		this.nac = nac;
		this.statusSym = 3; // "11": idle (outbound)
	}
	/** Sync, NID and payload dibits, the status symbols put in, null dibits up to len (0: the next multiple of 36). */
	frame(duid, payload, len = 0) {
		const d = [...SYNC.map(symToDibit), ...toDibits(nidEncode(this.nac, duid)), ...payload];
		let p = 0;
		for (const v of d) {
			if (isStatusPos(p)) {
				this.out.push(dibitToSym(this.statusSym));
				p++;
			}
			this.out.push(dibitToSym(v));
			p++;
		}
		if (!len) len = Math.ceil(p / STATUS_EVERY) * STATUS_EVERY;
		for (; p < len; p++) this.out.push(dibitToSym(isStatusPos(p) ? this.statusSym : 0));
	}
}

/** 24 hexbits (data + RS parity) as Hamming (10,6) words: 240 bits as 120 dibits, in six pieces of 20. */
function lduHex(data, k) {
	const s = new Uint8Array(24);
	s.set(data.subarray(0, k));
	rsEncode(s, 24, k);
	return toDibits(Array.from(s, (h) => valBits(hamming10Encode(h), 10)).flat());
}

function ldu(fb, duid, hexD, voice, { validVoice, voiceBase }) {
	const p = [];
	const vc = () => {
		const fn = voice.length + voiceBase;
		const bits = validVoice ? imbeEncode(randomBits((fn * 7907 + 3) >>> 0, 88)) : null;
		const fr = bits ? null : imbeMatrix(p25KnownVoice(fn));
		const dib = bits ? toDibits(bits) : interleave(fr);
		voice.push(Uint8Array.from(dib));
		p.push(...dib);
	};
	vc();
	vc();
	for (let i = 0; i < 6; i++) {
		p.push(...hexD.slice(20 * i, 20 * (i + 1)));
		vc();
	}
	p.push(...new Array(16).fill(0)); // low speed data: zeros (a codeword of its cyclic code)
	vc();
	fb.frame(duid, p, frameLen(duid));
}

function tsbkFrame(fb, ts) {
	const p = [];
	ts.forEach((t, i) => p.push(...trellisEncode(tsbkBits({ last: i + 1 === ts.length, prot: false, mfid: 0, ...t }))));
	fb.frame(TSBK, p);
}

function controlFrames(fb, t) {
	const n = Math.max(1, Math.round(t.durSec / (360 / 4800)));
	const b = BigInt;
	const idenUp =
		(1n << 60n) | (100n << 51n) | (180n << 42n) | (b(Math.round(t.idenSpacingHz / 125)) << 32n) | b(Math.round(t.idenBaseHz / 5));
	const idenVu = (2n << 60n) | (4n << 56n) | (((1n << 13n) | 800n) << 42n) | (50n << 32n) | b(460000000 / 5);
	const net = (b(t.wacn) << 36n) | (b(t.sysId) << 24n) | (b(t.ctrlChannel) << 8n) | 0x70n;
	const rfss = (b(t.sysId) << 40n) | (b(t.rfss) << 32n) | (b(t.site) << 24n) | (b(t.ctrlChannel) << 8n) | 0x70n;
	const adj = (b(t.sysId) << 40n) | (b(t.rfss) << 32n) | (b(t.adjSite) << 24n) | (b(t.adjChannel) << 8n) | 0x70n;
	const grant = (b(t.grantChannel) << 40n) | (b(t.grantTg) << 24n) | b(t.grantSrc);
	const upd = (b(t.grantChannel) << 48n) | (b(t.grantTg) << 32n) | (0x2005n << 16n) | 1300n;
	const ts = (opcode, args) => ({ opcode, args });
	for (let f = 0; f < n; f++) {
		if (t.script.length)
			tsbkFrame(
				fb,
				t.script[f % t.script.length].map(([op, args]) => ts(op, args)),
			);
		else if (f % 2 === 0) tsbkFrame(fb, [ts(OP_NET_STS, net), ts(OP_RFSS_STS, rfss), ts(OP_IDEN_UP, idenUp)]);
		else
			tsbkFrame(fb, [
				ts(OP_ADJ_STS, adj),
				ts(OP_GRP_V_GRANT, grant),
				f % 4 === 1 ? ts(OP_IDEN_UP_VU, idenVu) : ts(OP_GRP_V_GRANT_UPD, upd),
			]);
	}
}

function dataFrame(fb, t) {
	const v = [
		...valBits(0x15 | 0x20, 8),
		...valBits(0xc4, 8),
		...valBits(0, 8),
		...valBits(t.llid, 24),
		...valBits(0x80, 8),
		...valBits(0, 24),
	];
	const b = [...v, ...valBits(crcCcitt(v, 80), 16)];
	fb.frame(PDU, Array.from(trellisEncode(b)));
}

/** The C4FM symbols (-3 -1 +1 +3) of one transmission, and its voice frames as sent (72 dibits each). */
export function p25TxSymbols(t, { validVoice = false } = {}) {
	const sym = [];
	const voice = [];
	const fb = new FrameBuilder(sym, t.nac);
	if (t.kind === 'control') controlFrames(fb, t);
	else if (t.kind === 'data') dataFrame(fb, t);
	else {
		fb.statusSym = 1; // "01": busy
		const mi = t.algId !== ALG_CLEAR ? '112233445566778899' : '000000000000000000';
		const cr = { mi, algId: t.algId, keyId: t.keyId, mfid: 0, tg: t.group ? t.dst : 0 };
		if (!t.noHeader) {
			const h = new Uint8Array(36);
			h.set(hduHexbits(cr));
			rsEncode(h, 36, 20);
			fb.frame(HDU, toDibits(Array.from(h, (x) => valBits(golay18Encode(x), 18)).flat()), frameLen(HDU));
		}
		const svcOpts = (t.emergency ? 0x80 : 0) | (t.algId !== ALG_CLEAR ? 0x40 : 0) | 4;
		const lc = { lco: t.group ? LC_GROUP : LC_UNIT, mfid: 0, prot: false, svcOpts, tg: t.dst, src: t.src, dst: t.dst };
		const lcD = lduHex(lcHexbits(lc), 12);
		const esD = lduHex(esHexbits(cr), 16);
		const n = Math.max(1, Math.round(t.durSec / ((2 * 864) / 4800)));
		for (let f = 0; f < n; f++) {
			ldu(fb, LDU1, lcD, voice, { validVoice, voiceBase: t.voiceBase });
			ldu(fb, LDU2, esD, voice, { validVoice, voiceBase: t.voiceBase });
		}
		if (!t.noTerm) {
			const th = new Uint8Array(24);
			th.set(lcHexbits({ lco: LC_TERM, mfid: 0, prot: false, svcOpts: 0, tg: -1, src: -1, dst: t.dst }));
			rsEncode(th, 24, 12);
			const words = Array.from({ length: 12 }, (_, i) => valBits(golay24Encode((th[2 * i] << 6) | th[2 * i + 1]), 24)).flat();
			fb.frame(TDULC, toDibits(words), frameLen(TDULC));
			fb.frame(TDU, [], frameLen(TDU));
		}
	}
	return { sym: Int8Array.from(sym), voice };
}

export function p25TestSchedule() {
	return [
		tx({ kind: 'control', durSec: 1.5 }),
		tx({ src: 1234567, dst: 1201, durSec: 2 }),
		tx({ src: 7654321, dst: 1300, algId: 0x84, keyId: 0x1234, durSec: 1.5 }),
		tx({ kind: 'data', llid: 2002 }),
		tx({ src: 2002, dst: 2003, group: false, emergency: true, durSec: 1 }),
	];
}

/** Raised cosine (roll-off 0.2) C4FM at 48 kHz, 600 Hz per level (+3 = 1800 Hz). */
function shape(sym, ppm) {
	const sps = 10 / (1 + ppm * 1e-6);
	const a = 0.2;
	const rc = (t) => {
		const sinc = Math.abs(t) < 1e-9 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
		const d = 1 - 4 * a * a * t * t;
		return sinc * (Math.abs(d) < 1e-9 ? Math.PI / 4 : Math.cos(Math.PI * a * t) / d);
	};
	const out = new Float32Array(Math.ceil((sym.length + 4) * sps));
	for (let n = 0; n < out.length; n++) {
		const t = n / sps;
		const c = Math.round(t);
		let f = 0;
		for (let k = c - 4; k <= c + 4; k++) if (k >= 0 && k < sym.length) f += sym[k] * 600 * rc(t - k);
		out[n] = f;
	}
	return out;
}

/** The transmissions in a row over the channel (OnAir P25Generator): leadSec of no carrier, a gap after each. */
export function p25Signal(txs, { cnrDb = 99, cfoHz = 0, ppm = 0, leadSec = 0.3, seed = 3, validVoice = false } = {}) {
	const parts = [new Float32Array(Math.round(leadSec * 48000)).fill(NaN)];
	const voice = [];
	for (const t of txs) {
		const { sym, voice: v } = p25TxSymbols(t, { validVoice });
		voice.push(v);
		parts.push(shape(sym, ppm).map((f) => f + cfoHz));
		parts.push(new Float32Array(Math.round(t.gapSec * 48000)).fill(NaN));
	}
	const freq = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
	let pos = 0;
	for (const p of parts) {
		freq.set(p, pos);
		pos += p.length;
	}
	return { iq: channel(fmIq(freq), { cnrDb, bandwidthHz: 12500, filterHz: 6000, seed }), voice };
}
