// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/fusion/fusion_proto.cpp (buildFrameBits, parseFrameBits) and
// core/src/fusion/fusion_rx.cpp (FusionReceiver::Impl::tryFrame, lsq, slice), https://github.com/adswill/OnAir;
// see third_party/onair.
// Changes: the frame builder and parser are split per data type; readYsfFrame works on the symbols of BrowSDR's DSD
// clock recovery (one value per symbol, scaled to Hz) instead of OnAir's 10 samples per symbol, and leaves the sync
// search and the frame timing to the DSD decoder.
import {
	YSF_FRAME_BITS,
	YSF_FRAME_DIBITS,
	YSF_SYNC_DIBITS,
	bitsToBytes,
	bytesToBits,
	dchDecode,
	dchEncode,
	fichDecode,
	fichEncode,
	levelDibit,
	syncBits,
	syncLevels,
	vd2VoiceDecode,
	vd2VoiceEncode,
} from './proto';
import type { YsfFrameContent, YsfFrameRead, YsfVoiceUnit } from './types';

function unitBits(c: YsfFrameContent, i: number, nbytes: number): Uint8Array | null {
	return i < c.units.length && c.units[i].length === nbytes ? dchEncode(c.units[i]) : null;
}

function pushRange(out: number[], bits: Uint8Array, from: number, to: number): void {
	for (let i = from; i < to; i++) out.push(bits[i]);
}

function buildTwoUnits(c: YsfFrameContent, out: number[]): boolean {
	const u0 = unitBits(c, 0, 20);
	const u1 = unitBits(c, 1, 20);
	if (!u0 || !u1) return false;
	for (let i = 0; i < 5; i++) {
		pushRange(out, u0, 72 * i, 72 * (i + 1));
		pushRange(out, u1, 72 * i, 72 * (i + 1));
	}
	return true;
}

function buildVd1(c: YsfFrameContent, out: number[]): boolean {
	const u = unitBits(c, 0, 20);
	if (!u || c.voice.length !== 5) return false;
	for (let i = 0; i < 5; i++) {
		if (c.voice[i].bytes.length !== 9) return false;
		pushRange(out, u, 72 * i, 72 * (i + 1));
		bytesToBits(c.voice[i].bytes, out);
	}
	return true;
}

function buildVd2(c: YsfFrameContent, out: number[]): boolean {
	const u = unitBits(c, 0, 10);
	if (!u || c.voice.length !== 5) return false;
	for (let i = 0; i < 5; i++) {
		if (c.voice[i].bytes.length !== 7) return false;
		const v: number[] = [];
		bytesToBits(c.voice[i].bytes, v);
		pushRange(out, u, 40 * i, 40 * (i + 1));
		pushRange(out, vd2VoiceEncode(v), 0, 104);
	}
	return true;
}

function buildVoiceFr(c: YsfFrameContent, out: number[]): boolean {
	if (c.fich.fn === 0 && c.fich.ft === 1) {
		const u = unitBits(c, 0, 20);
		if (!u || c.voice.length !== 2) return false;
		pushRange(out, u, 0, u.length);
		for (let i = 0; i < 72; i++) out.push(0); // reserved
	} else if (c.voice.length !== 5) return false;
	for (const v of c.voice) {
		if (v.bytes.length !== 18) return false;
		bytesToBits(v.bytes, out);
	}
	return true;
}

/** The 960 bits of a frame (sync included); null when the content does not fit its data type. */
export function buildFrameBits(c: YsfFrameContent): Uint8Array | null {
	const out = Array.from(syncBits());
	pushRange(out, fichEncode(c.fich), 0, 200);
	const header = c.fich.fi === 0 || c.fich.fi === 2;
	let ok: boolean;
	if (header || c.fich.dt === 1) ok = buildTwoUnits(c, out);
	else if (c.fich.dt === 0) ok = buildVd1(c, out);
	else if (c.fich.dt === 2) ok = buildVd2(c, out);
	else ok = buildVoiceFr(c, out);
	return ok && out.length === YSF_FRAME_BITS ? Uint8Array.from(out) : null;
}

function addUnit(c: YsfFrameContent, coded: number[]): void {
	const decoded = dchDecode(Uint8Array.from(coded));
	c.units.push(decoded ? decoded.bytes : new Uint8Array(coded.length === 360 ? 20 : 10));
	c.unitOk.push(decoded !== null);
}

function collect(bits: Uint8Array, p: number, stride: number, from: number, to: number, count = 5): number[] {
	const out: number[] = [];
	for (let i = 0; i < count; i++) pushRange(out, bits, p + stride * i + from, p + stride * i + to);
	return out;
}

function voiceUnit(kind: number, bits: Uint8Array, start: number, nbits: number, errors?: number): YsfVoiceUnit {
	return { kind, bytes: bitsToBytes(bits, start, nbits), errors };
}

function parsePayload(b: Uint8Array, c: YsfFrameContent): void {
	const p = 240;
	const header = c.fich.fi === 0 || c.fich.fi === 2;
	if (header || c.fich.dt === 1) {
		addUnit(c, collect(b, p, 144, 0, 72));
		addUnit(c, collect(b, p, 144, 72, 144));
	} else if (c.fich.dt === 0) {
		for (let i = 0; i < 5; i++) c.voice.push(voiceUnit(1, b, p + 144 * i + 72, 72));
		addUnit(c, collect(b, p, 144, 0, 72));
	} else if (c.fich.dt === 2) {
		for (let i = 0; i < 5; i++) {
			const v = vd2VoiceDecode(b.subarray(p + 144 * i + 40, p + 144 * i + 144));
			c.voice.push(voiceUnit(2, v.bits, 0, 49, v.errors));
		}
		addUnit(c, collect(b, p, 144, 0, 40));
	} else if (c.fich.fn === 0 && c.fich.ft === 1) {
		addUnit(c, Array.from(b.subarray(p, p + 360)));
		for (let i = 0; i < 2; i++) c.voice.push(voiceUnit(3, b, p + 432 + 144 * i, 144)); // 360 DCH + 72 reserved
	} else {
		for (let i = 0; i < 5; i++) c.voice.push(voiceUnit(3, b, p + 144 * i, 144));
	}
}

/** Reads the 960 bits (the sync is not checked here); null when the FICH does not check. */
export function parseFrameBits(b: Uint8Array): YsfFrameContent | null {
	const fich = fichDecode(b.subarray(40, 240));
	if (!fich) return null;
	const c: YsfFrameContent = { fich: fich.fich, fichOk: true, fichFixes: fich.fixes, units: [], unitOk: [], voice: [] };
	parsePayload(b, c);
	return c;
}

function lsq(s: ArrayLike<number>, v: ArrayLike<number>, n: number): { g: number; d: number } {
	let ms = 0;
	let mv = 0;
	for (let i = 0; i < n; i++) {
		ms += s[i];
		mv += v[i];
	}
	ms /= n;
	mv /= n;
	let c = 0;
	let a = 0;
	for (let i = 0; i < n; i++) {
		c += (s[i] - ms) * (v[i] - mv);
		a += (s[i] - ms) * (s[i] - ms);
	}
	const g = a > 0 ? c / a : 0;
	return { g, d: mv - g * ms };
}

function slice(z: number): number {
	return z >= 2 ? 3 : z >= 0 ? 1 : z >= -2 ? -1 : -3;
}

const SYNC_LEVELS = syncLevels();

/** 900 Hz per level step nominal: a fit outside this range is not a Fusion frame. */
function levelOk(g: number): boolean {
	return Math.abs(g) >= 300 && Math.abs(g) <= 1800;
}

/**
 * Fit levels and offset to a frame's 480 symbol values (in Hz, the sync first), decide its bits and parse it.
 * Levels come from the sync and then twice from the frame's own decisions (a mirrored spectrum gives a negative gain);
 * while acquiring, a frame under 4 dB symbol SNR is not taken.
 */
export function readYsfFrame(v: Float32Array, acquiring: boolean): YsfFrameRead | null {
	if (v.length < YSF_FRAME_DIBITS) return null;
	const s = new Float32Array(YSF_FRAME_DIBITS);
	s.set(SYNC_LEVELS);
	let { g, d } = lsq(s, v, YSF_SYNC_DIBITS);
	if (!levelOk(g)) return null;
	for (let it = 0; it < 2; it++) {
		for (let i = YSF_SYNC_DIBITS; i < YSF_FRAME_DIBITS; i++) s[i] = slice((v[i] - d) / g);
		({ g, d } = lsq(s, v, YSF_FRAME_DIBITS));
		if (!levelOk(g)) return null;
	}
	let e = 0;
	const bits = new Uint8Array(YSF_FRAME_BITS);
	for (let i = 0; i < YSF_FRAME_DIBITS; i++) {
		const level = slice((v[i] - d) / g);
		const r = v[i] - g * s[i] - d;
		e += r * r;
		const dibit = levelDibit(level);
		bits[2 * i] = dibit >> 1;
		bits[2 * i + 1] = dibit & 1;
	}
	const snrDb = 10 * Math.log10((5 * g * g) / Math.max(e / YSF_FRAME_DIBITS, 1e-9));
	if (acquiring && snrDb < 4) return null;
	const content = parseFrameBits(bits);
	return content ? { content, snrDb, inverted: g < 0 } : null;
}
