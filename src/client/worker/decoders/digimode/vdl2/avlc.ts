// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir rust/onair_vdl2/src/avlc.rs (addresses, control octet, parse_frame)
// and core/src/vdl2/vdl2_proto.cpp (vdl2Frame, vdl2ControlI), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the detail lines are labelled; the ACARS block is read here (vdl2ReadAcars of vdl2_proto_rs.cpp).
//
// AVLC (Aviation VHF Link Control, ICAO Annex 10 Vol III Part I section 6.3.4, Doc 9776): the two 4-octet addresses
// with the A/G and C/R bits, the control octet (I, S and U frames) and what the information field carries.

import { readAcars } from './acars';
import { rev } from './bits';
import { fcs } from './burst';
import { hexNum, readX25 } from './proto';
import type { Vdl2Addr, Vdl2Message } from './types';
import { readXid } from './xid';

export const CTRL_UI = 0x03;
export const CTRL_XID = 0xaf;

/** Writes an address into 4 octets: the 28 bit value is bit-reversed and sent 7 bits per octet, the last octet carries the HDLC address-end bit. */
export function putAddr(a: Vdl2Addr, last: boolean): Uint8Array {
	const v = ((a.status ? 1 : 0) << 27) | ((a.type & 7) << 24) | (a.addr & 0xffffff);
	const t = rev(v, 28);
	const o = new Uint8Array(4);
	for (let i = 0; i < 4; i++) o[i] = ((t >>> (7 * i)) & 0x7f) << 1;
	if (last) o[3] |= 1;
	return o;
}

/** Reads an address from 4 octets. */
export function getAddr(o: Uint8Array): Vdl2Addr {
	let t = 0;
	for (let i = 0; i < 4; i++) t |= ((o[i] >> 1) & 0x7f) << (7 * i);
	const v = rev(t, 28);
	return { addr: v & 0xffffff, type: (v >>> 24) & 7, status: ((v >>> 27) & 1) === 1 };
}

/** Address type name. */
export function addrTypeName(t: number): string {
	return { 1: 'aircraft', 4: 'ground station (ADM)', 5: 'ground station (DEL)', 7: 'all stations' }[t] ?? 'reserved';
}

/** The control octet of an I frame. */
export const controlI = (ns: number, nr: number, p: boolean): number => ((ns & 7) << 1) | (p ? 0x10 : 0) | ((nr & 7) << 5);

/** A complete frame: addresses, control, information, FCS (low octet first). */
export function avlcFrame(dst: Vdl2Addr, src: Vdl2Addr, control: number, info: ArrayLike<number>): Uint8Array {
	const f = new Uint8Array(9 + info.length + 2);
	f.set(putAddr(dst, false), 0);
	f.set(putAddr(src, true), 4);
	f[8] = control;
	f.set(info, 9);
	const c = fcs(f.subarray(0, 9 + info.length));
	f[9 + info.length] = c & 0xff;
	f[10 + info.length] = c >> 8;
	return f;
}

/** True when the information field starts an ACARS block: the 0xFF 0xFF prefix of ARINC 618 followed by SOH. */
const acarsInfo = (info: Uint8Array): boolean => info.length > 3 && info[0] === 0xff && info[1] === 0xff && info[2] === 0x01;

function emptyMessage(d: Vdl2Addr, s: Vdl2Addr, info: Uint8Array): Vdl2Message {
	return {
		dst: d.addr,
		dstType: d.type,
		src: s.addr,
		srcType: s.type,
		onGround: d.status,
		response: s.status,
		fromAir: s.type === 1,
		fromGround: s.type === 4 || s.type === 5,
		frameKind: '',
		frameName: '',
		ns: -1,
		nr: -1,
		pf: false,
		proto: '',
		summary: '',
		detail: [
			['Source', `${hexNum(s.addr, 6)} (${addrTypeName(s.type)})`],
			['Destination', `${hexNum(d.addr, 6)} (${addrTypeName(d.type)})`],
			['Link', `${d.status ? 'on ground' : 'airborne'}, ${s.status ? 'response' : 'command'}`],
		],
		info,
		acarsAt: -1,
		hasPos: false,
		lat: 0,
		lon: 0,
		posKind: '',
		hasAlt: false,
		altFt: 0,
	};
}

function readI(m: Vdl2Message, c: number): void {
	m.frameKind = 'I';
	m.frameName = 'I';
	m.ns = (c >> 1) & 7;
	m.nr = (c >> 5) & 7;
	m.pf = ((c >> 4) & 1) === 1;
	m.detail.push(['Frame', `I frame, N(S) ${m.ns}, N(R) ${m.nr}${m.pf ? ', poll' : ''}, ${m.info.length} octets of information`]);
	if (acarsInfo(m.info)) m.acarsAt = 11;
	else if (m.info.length) readX25(m.info, m);
	else m.summary = 'I frame, no information';
}

function readS(m: Vdl2Message, c: number): void {
	m.frameKind = 'S';
	m.frameName = ['RR', 'RNR', 'REJ', 'SREJ'][(c >> 2) & 3];
	m.nr = (c >> 5) & 7;
	m.pf = ((c >> 4) & 1) === 1;
	m.summary = `${m.frameName} N(R) ${m.nr}`;
	m.detail.push(['Frame', `S frame ${m.frameName}, N(R) ${m.nr}${m.pf ? ', poll/final' : ''}`]);
}

const U_NAMES: Record<number, string> = { 0x00: 'UI', 0x03: 'DM', 0x10: 'DISC', 0x18: 'UA', 0x21: 'FRMR', 0x2b: 'XID', 0x38: 'TEST' };

function readU(m: Vdl2Message, c: number): void {
	m.frameKind = 'U';
	m.pf = ((c >> 4) & 1) === 1;
	const mf = (c >> 2) & 0x3b;
	const name = U_NAMES[mf] ?? 'U?';
	const n = m.info.length;
	m.frameName = name;
	m.detail.push(['Frame', `U frame ${name}${m.pf ? ', poll/final' : ''}, ${n} octets of information`]);
	if (mf === 0x2b) readXid(m.info, m);
	else if (mf === 0x00 && acarsInfo(m.info)) m.acarsAt = 11;
	else m.summary = n ? `${name} (${n} octets)` : name;
}

/**
 * Decodes a frame whose FCS was good, without its FCS: addresses, control and the information field, an ACARS block
 * included. Undefined when the frame is too short to be AVLC.
 */
export function parseFrame(f: Uint8Array): Vdl2Message | undefined {
	if (f.length < 9) return undefined;
	const m = emptyMessage(getAddr(f.subarray(0, 4)), getAddr(f.subarray(4, 8)), f.subarray(9));
	const c = f[8];
	if ((c & 1) === 0) readI(m, c);
	else if ((c & 3) === 1) readS(m, c);
	else readU(m, c);
	if (m.acarsAt >= 0) readAcars(f.subarray(m.acarsAt), m);
	return m;
}
