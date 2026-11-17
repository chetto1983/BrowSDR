// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir rust/onair_mesh/src/aprs.rs (clean_text, battery, le32, meshcom: the ack
// check, the "SRCPATH>DEST" + type + payload split, the 16-bit byte sum, the source call check, the trailer and flag
// summary, the TEXT / POSITION / HEY details), https://github.com/adswill/OnAir; see third_party/onair. Protocol facts as
// credited there: MeshCom firmware (icssw-org/MeshCom-Firmware, MIT): decodeAPRS / encodeAPRS in aprs_functions.cpp,
// handleACK in lora_functions.cpp, ack_functions.h. Changes: strings in place of fixed buffers (no truncation at their
// sizes); the cleaned bytes are decoded as UTF-8; the acknowledged id is kept as a number.

import { plausibleCall } from '@/worker/decoders/digimode/lora-aprs/proto';
import type { MeshComFrame, MeshComKind, MeshComSplit } from './types';

const utf8Decoder = new TextDecoder();
const latin1 = (p: Uint8Array): string => String.fromCharCode(...p);
const le32 = (p: Uint8Array, i: number): number => (p[i] | (p[i + 1] << 8) | (p[i + 2] << 16) | (p[i + 3] << 24)) >>> 0;
export const hex8upper = (v: number): string => (v >>> 0).toString(16).toUpperCase().padStart(8, '0');

/** Length of a UTF-8 sequence from its lead byte (0: not a lead byte). */
const seqLength = (c: number): number => ((c & 0xe0) === 0xc0 ? 2 : (c & 0xf0) === 0xe0 ? 3 : (c & 0xf8) === 0xf0 ? 4 : 0);

/** Invalid UTF-8 and control characters become '?' (comments may carry UTF-8; broken bytes must not reach the view). */
export function cleanText(s: Uint8Array): string {
	const out: number[] = [];
	for (let i = 0; i < s.length;) {
		const c = s[i];
		if (c < 0x80) {
			out.push(c < 0x20 || c === 0x7f ? 0x3f : c);
			i++;
			continue;
		}
		const len = seqLength(c);
		let ok = len > 0 && i + len <= s.length && c !== 0xc0 && c !== 0xc1 && c <= 0xf4;
		for (let k = 1; ok && k < len; k++) ok = (s[i + k] & 0xc0) === 0x80;
		if (!ok) {
			out.push(0x3f);
			i++;
			continue;
		}
		out.push(...s.subarray(i, i + len));
		i += len;
	}
	return utf8Decoder.decode(Uint8Array.from(out));
}

/** "/B=085" in a MeshCom position (aprsExtractTag 'B', at most three digits); -1 when absent. */
export function battery(s: Uint8Array): number {
	for (let p = 0; p + 3 <= s.length; p++) {
		if (s[p] !== 0x2f || s[p + 1] !== 0x42 || s[p + 2] !== 0x3d) continue;
		let v = 0,
			nd = 0;
		for (let i = p + 3; i < s.length && s[i] >= 0x30 && s[i] <= 0x39 && nd < 3; i++, nd++) v = v * 10 + s[i] - 0x30;
		return nd ? v : -1;
	}
	return -1;
}

function emptyFrame(): MeshComFrame {
	return {
		ok: false,
		kind: 'ack',
		hasAprs: false,
		hopLimit: -1,
		batteryPct: -1,
		packetId: 0,
		note: '',
		typeName: '',
		detail: '',
		tail: '',
		src: '',
		aprsPath: '',
		aprsDest: '',
		destCall: '',
		aprsInfo: '',
		channel: '',
		text: '',
	};
}

/**
 * ack_functions.h isPlausibleAckFrame: 12 bytes or more, byte 5 = 0x80 | remaining hops (at most 7); bytes 10 and 11 are
 * 0x01 0x00 in nearly every real ack: the firmware does not check them, OnAir does, so that random data is not an ack.
 */
function ack(p: Uint8Array, r: MeshComFrame): MeshComFrame {
	if (p.length < 12 || (p[5] & 0x80) !== 0x80 || (p[5] & 0x7f) > 7 || p[10] !== 0x01 || p[11] !== 0x00) {
		r.note = 'not a MeshCom ack';
		return r;
	}
	r.ok = true;
	r.typeName = 'ACK';
	r.packetId = le32(p, 1);
	r.ackedId = le32(p, 6);
	r.hopLimit = p[5] & 0x7f;
	r.detail = `ack of ${hex8upper(r.ackedId)}`;
	return r;
}

const printableChar = (c: number): boolean => c >= 0x20 && c <= 0x7e;

/** "SRCPATH>DEST" + type character + payload + NUL, from byte 6 on. */
function split(p: Uint8Array, kind: number): MeshComSplit | string {
	const n = p.length;
	let i = 6;
	while (i < n && i - 6 < 120 && p[i] !== 0x3e && printableChar(p[i])) i++;
	const srcPath = p.subarray(6, i);
	if (i >= n || p[i] !== 0x3e) return "MeshCom: no '>' after the source";
	const d0 = ++i;
	while (i < n && i - d0 < 120 && p[i] !== kind && printableChar(p[i])) i++;
	const dest = p.subarray(d0, i);
	if (i >= n || p[i] !== kind) return 'MeshCom: no type character after the destination';
	const pay0 = ++i;
	while (i < n && p[i] !== 0) i++;
	if (i >= n) return 'MeshCom: payload not ended';
	return { srcPath, dest, payload: p.subarray(pay0, i), trailer: i + 1 };
}

/** The hardware, modulation, country and firmware of the trailer and the flags of byte 5. */
function tailText(p: Uint8Array, i: number): string {
	const fw = i + 4 < p.length ? p[i + 4] : -1;
	let t = `HW ${p[i]}, MOD ${p[i + 1] & 0x0f}, country ${p[i + 1] >> 4}`;
	if (fw >= 0) t += `, FW ${fw}`;
	const flags: Array<[number, string]> = [
		[0x80, 'server'],
		[0x40, 'track'],
		[0x20, 'app offline'],
		[0x10, 'mesh'],
	];
	for (const [bit, name] of flags) if (p[5] & bit) t += `, ${name}`;
	return t;
}

/** The kind's text: TEXT and HEY get their detail, a text message its channel and text, a position its battery. */
function body(r: MeshComFrame, kind: number, payload: Uint8Array): void {
	const head = `${cleanText(payload.subarray(0, 60))} (${r.tail})`;
	const k: MeshComKind = kind === 0x3a ? 'text' : kind === 0x21 ? 'position' : 'hey';
	r.kind = k;
	r.typeName = k.toUpperCase();
	if (k === 'position') {
		r.batteryPct = battery(payload);
		return;
	}
	r.detail = head;
	if (k === 'text') {
		r.channel = r.destCall === '*' ? 'MeshCom all' : `MeshCom ${r.destCall}`;
		r.text = cleanText(payload);
	}
}

/** Decodes a MeshCom frame; `note` says what is wrong when `ok` stays false. */
export function meshcom(p: Uint8Array): MeshComFrame {
	const n = p.length;
	const r = emptyFrame();
	if (n === 0) return r;
	const kind = p[0];
	if (kind === 0x41) return ack(p, r);
	if (kind !== 0x3a && kind !== 0x21 && kind !== 0x40) {
		r.note = 'not a MeshCom packet';
		return r;
	}
	if (n < 16) {
		r.note = 'short MeshCom packet';
		return r;
	}
	const s = split(p, kind);
	if (typeof s === 'string') {
		r.note = s;
		return r;
	}
	const i = s.trailer;
	if (i + 4 > n) {
		r.note = 'MeshCom: trailer cut off';
		return r;
	}
	let sum = 0;
	for (let k = 0; k < i + 2; k++) sum += p[k];
	if ((sum & 0xffff) !== ((p[i + 2] << 8) | p[i + 3])) {
		r.note = 'MeshCom: checksum wrong';
		return r;
	}
	const comma = s.srcPath.indexOf(0x2c);
	const src = comma < 0 ? s.srcPath : s.srcPath.subarray(0, comma);
	if (!plausibleCall(src)) {
		r.note = 'MeshCom: bad source call';
		return r;
	}
	const last = s.dest.lastIndexOf(0x2c);
	r.ok = true;
	r.hasAprs = true;
	r.src = latin1(src);
	r.aprsPath = comma < 0 ? '' : latin1(s.srcPath.subarray(comma + 1));
	r.aprsDest = latin1(s.dest);
	r.destCall = latin1(last < 0 ? s.dest : s.dest.subarray(last + 1));
	r.aprsInfo = String.fromCharCode(kind) + latin1(s.payload);
	r.packetId = le32(p, 1);
	r.hopLimit = p[5] & 0x0f;
	r.tail = tailText(p, i);
	body(r, kind, s.payload);
	return r;
}
