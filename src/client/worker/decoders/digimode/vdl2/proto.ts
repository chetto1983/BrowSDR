// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir rust/onair_vdl2/src/proto.rs (X.25, CLNP and COTP readers),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: the detail lines are labelled; the X.25 reader is
// split by packet kind.
//
// The protocols an AVLC information field carries, as text: ISO 8208 / X.25 packets (data, call set-up, clear, reset,
// restart, flow control), ISO 8473 CLNP headers with the NSAP addresses and the ISO 8073 COTP TPDU around ATN
// application data. ICAO Doc 9880, Doc 9776, ISO 8208, ISO 8473, ISO 8073. The packet itself goes with the record to
// the app (atnApplication), which reassembles the ATN layers and decodes CM and CPDLC with the ACARS library.

import type { DigimodeAtnApplication } from '@/worker/decoders/digimode/types';
import type { Vdl2Message } from './types';

/** Upper case hex, zero padded to `width` digits. */
export const hexNum = (v: number, width: number): string => v.toString(16).toUpperCase().padStart(width, '0');

/** Upper case hex of at most `max` octets, "..." appended when there are more. */
export function hexs(p: Uint8Array, max = 24): string {
	let s = '';
	for (const b of p.subarray(0, max)) s += hexNum(b, 2);
	return p.length > max ? `${s}...` : s;
}

/** `%.*s`: the bytes as characters, stopping at a NUL. */
export function cstr(p: Uint8Array): string {
	let s = '';
	for (const c of p) {
		if (c === 0) break;
		s += String.fromCharCode(c);
	}
	return s;
}

function bcd(p: Uint8Array, digits: number, startNibble: number): string {
	let s = '';
	for (let i = 0; i < digits; i++) {
		const nib = startNibble + i;
		const v = (p[nib >> 1] >> (nib % 2 ? 0 : 4)) & 0xf;
		s += v < 10 ? String(v) : '?';
	}
	return s;
}

/** COTP TPDU type name (ISO 8073 13.2). */
function cotpName(c: number): string {
	const names: Record<number, string> = {
		0xe0: 'CR (connection request)',
		0xd0: 'CC (connection confirm)',
		0xf0: 'DT (data)',
		0x80: 'DR (disconnect request)',
		0xc0: 'DC (disconnect confirm)',
		0x60: 'AK (acknowledgement)',
		0x10: 'ED (expedited data)',
		0x20: 'EA (expedited ack)',
		0x70: 'ER (error)',
	};
	return names[c & 0xf0] ?? 'unknown TPDU';
}

const CLNP_TYPES: Record<number, string> = {
	0x1c: 'DT (data)',
	0x01: 'ER (error report)',
	0x1e: 'ERQ (echo request)',
	0x1f: 'ERP (echo reply)',
};

/** The COTP TPDU of a CLNP data PDU and the ATN application data it carries. */
function readCotp(q: Uint8Array, m: Vdl2Message): void {
	const qn = q.length;
	if (qn < 2 || q[0] >= qn) return;
	m.proto = 'COTP';
	const name = cotpName(q[1]);
	m.detail.push(['COTP (ISO 8073)', `${name}, ${qn - q[0] - 1} octets of user data`]);
	m.summary += `, COTP ${name.slice(0, 2)}`;
	if ((q[1] & 0xf0) === 0xf0 && qn > q[0] + 1) {
		m.detail.push(['ATN application data', `CPDLC, ADS-C, CM over ATN (ASN.1 PER): ${hexs(q.subarray(q[0] + 1))}`]);
		m.summary += ', ATN application data';
	}
}

/** CLNP (ISO 8473) header and what it carries: the PDU type, lifetime, segment length, the NSAP addresses and, for data PDUs, the COTP TPDU. */
export function readClnp(p: Uint8Array, m: Vdl2Message): void {
	const n = p.length;
	if (n < 9) {
		m.detail.push(['CLNP', `cut short (${n} octets)`]);
		return;
	}
	const [li, ver, life, ty] = [p[1], p[2], p[3], p[4] & 0x1f];
	const segLen = (p[5] << 8) | p[6];
	const tn = CLNP_TYPES[ty] ?? 'unknown';
	m.proto = 'CLNP';
	const flags = (p[4] & 0x80 ? ', segmented' : '') + (p[4] & 0x20 ? ', error reports wanted' : '');
	m.detail.push([
		'CLNP',
		`${tn}, version ${ver}, lifetime ${(life * 0.5).toFixed(1)} s, segment ${segLen} octets, header ${li} octets${flags}`,
	]);
	let o = 9;
	let dst: Uint8Array = new Uint8Array(0);
	let src: Uint8Array = new Uint8Array(0);
	if (o < n) {
		const dl = p[o++];
		if (o + dl <= n) {
			dst = p.subarray(o, o + dl);
			o += dl;
		}
	}
	if (o < n) {
		const sl = p[o++];
		if (o + sl <= n) src = p.subarray(o, o + sl);
	}
	m.detail.push(['Destination NSAP', dst.length ? hexs(dst, 20) : '-']);
	m.detail.push(['Source NSAP', src.length ? hexs(src, 20) : '-']);
	m.summary = `CLNP ${ty === 0x1c ? 'DT' : tn}`;
	if (ty === 0x1c && li < n) readCotp(p.subarray(li), m);
}

/** Packet text for one of the named X.25 packets. */
function simple(m: Vdl2Message, name: string, lcn: number): void {
	m.summary = `X.25 ${name}, LCN ${lcn}`;
	m.detail.push(['X.25 (ISO 8208)', `${name}, logical channel ${lcn}`]);
}

function readData(p: Uint8Array, m: Vdl2Message, lcn: number): void {
	const pt = p[2];
	const [pr, ps, more] = [pt >> 5, (pt >> 1) & 7, (pt >> 4) & 1];
	m.summary = `X.25 data, LCN ${lcn}, P(S) ${ps} P(R) ${pr}${more ? ', more follows' : ''}`;
	m.detail.push([
		'X.25 (ISO 8208)',
		`data packet, GFI ${hexNum(p[0] >> 4, 1)}, logical channel ${lcn}, P(S) ${ps}, P(R) ${pr}${more ? ', M bit set' : ''}, ${p.length - 3} octets of user data`,
	]);
	const u = p.subarray(3);
	if (!u.length) return;
	if (u[0] === 0x81) {
		const outer = m.summary;
		readClnp(u, m);
		m.summary = `${outer}: ${m.summary}`;
	} else if (u[0] === 0x82) {
		m.proto = 'ES-IS';
		m.summary += ': ES-IS';
		m.detail.push(['ES-IS', `ISO 9542 routeing exchange, ${u.length} octets`]);
	} else if (u[0] === 0x85) {
		m.proto = 'IDRP';
		m.summary += ': IDRP';
		m.detail.push(['IDRP', `ISO 10747 inter-domain routeing, ${u.length} octets`]);
	} else {
		m.summary += ': compressed CLNP header';
		m.detail.push(['SNDCF', `ICAO SNDCF compressed (LREF) CLNP header: ${hexs(u)}`]);
	}
}

function readCall(p: Uint8Array, m: Vdl2Message, lcn: number): void {
	const n = p.length;
	let called = '';
	let calling = '';
	let o = 3;
	if (n > 3) {
		const [lcalling, lcalled] = [p[3] >> 4, p[3] & 0xf];
		o = 4;
		const bytes = (lcalling + lcalled + 1) >> 1;
		if (o + bytes <= n) {
			called = bcd(p.subarray(o), lcalled, 0);
			calling = bcd(p.subarray(o), lcalling, lcalled);
			o += bytes;
		}
	}
	let facLen = -1;
	if (o < n) {
		facLen = p[o];
		o += 1 + facLen;
	}
	simple(m, p[2] === 0x0b ? 'call request' : 'call accepted', lcn);
	m.detail.push(['Call', `called DTE ${called || '-'}, calling DTE ${calling || '-'}, facilities ${Math.max(0, facLen)} octets`]);
	if (o < n) m.detail.push(['Call user data', hexs(p.subarray(o)) + (p[o] === 0xc1 ? ' (ICAO SNDCF)' : '')]);
}

const CONTROL_NAMES: Record<number, string> = {
	0x1b: 'reset request',
	0x1f: 'reset confirmation',
	0xfb: 'restart request',
	0xff: 'restart confirmation',
	0x23: 'interrupt',
	0x27: 'interrupt confirmation',
	0xf1: 'diagnostic',
};

function readOther(p: Uint8Array, m: Vdl2Message, lcn: number): void {
	const pt = p[2];
	if (pt === 0x13 || pt === 0x17) {
		m.summary = `X.25 clear ${pt === 0x13 ? 'request' : 'confirm'}, LCN ${lcn}`;
		m.detail.push(['X.25 (ISO 8208)', `clear ${pt === 0x13 ? 'request' : 'confirmation'}, logical channel ${lcn}`]);
		if (pt === 0x13 && p.length >= 5) m.detail.push(['Cause', `${p[3]}, diagnostic ${p[4]}`]);
		return;
	}
	if (CONTROL_NAMES[pt]) return simple(m, CONTROL_NAMES[pt], lcn);
	const flow = { 0x01: 'RR', 0x05: 'RNR', 0x09: 'REJ' }[pt & 0x1f];
	if (flow) {
		m.summary = `X.25 ${flow}, LCN ${lcn}, P(R) ${pt >> 5}`;
		m.detail.push(['X.25 (ISO 8208)', `${flow}, logical channel ${lcn}, P(R) ${pt >> 5}`]);
		return;
	}
	m.summary = `X.25 packet type ${hexNum(pt, 2)}, LCN ${lcn}`;
	m.detail.push(['X.25 (ISO 8208)', `packet type ${hexNum(pt, 2)}, logical channel ${lcn}, ${p.length} octets`]);
}

/** X.25 (ISO 8208) packet: general format identifier, logical channel number, packet type and the contents of data, call, clear and control packets. */
export function readX25(p: Uint8Array, m: Vdl2Message): void {
	m.proto = 'X.25';
	if (p.length < 3) {
		m.summary = 'X.25: cut short';
		m.detail.push(['X.25 (ISO 8208)', `${p.length} octets, too short`]);
		return;
	}
	const lcn = ((p[0] & 0xf) << 8) | p[1];
	const pt = p[2];
	if ((pt & 1) === 0) readData(p, m, lcn);
	else if (pt === 0x0b || pt === 0x0f) readCall(p, m, lcn);
	else readOther(p, m, lcn);
}

/** Octets of an X.25 packet sent to the app (VDL2's default N1, 8312 bits, is about 1040 octets). */
const ATN_MAX_OCTETS = 2000;
const isGround = (type: number): boolean => type === 4 || type === 5;

/**
 * The X.25 packet of an I frame between an aircraft and a ground station (the frame's check sequence was good), for the
 * app's ATN stack; aircraft to ground is downlink.
 */
export function atnApplication(m: Vdl2Message): DigimodeAtnApplication | undefined {
	if (m.frameKind !== 'I' || m.acarsAt >= 0 || m.info.length < 3 || m.info.length > ATN_MAX_OCTETS) return undefined;
	const down = m.srcType === 1 && isGround(m.dstType);
	if (!down && !(m.dstType === 1 && isGround(m.srcType))) return undefined;
	return {
		kind: 'atn',
		direction: down ? 'downlink' : 'uplink',
		source: { address: hexNum(m.src, 6), type: m.srcType },
		destination: { address: hexNum(m.dst, 6), type: m.dstType },
		hex: Array.from(m.info, (byte) => hexNum(byte, 2)).join(''),
	};
}
