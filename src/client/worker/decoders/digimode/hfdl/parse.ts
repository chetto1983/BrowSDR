// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir rust/onair_hfdl/src/parse.rs (spdu, read_lpdu, parse_pdu, Msg defaults)
// and core/src/hfdl/hfdl_proto_rs.cpp (hfdlParsePdu: the squitter's system table version),
// https://github.com/adswill/OnAir; see third_party/onair. Protocol facts as OnAir credits them: ARINC 635 / ICAO Doc
// 9741 as dumphfdl (szpajder, GPL-3.0) implements them, read for reference. Changes: the detail lines are labelled;
// the messages come back as a list (undefined when no check sequence comes out right).
//
// The PDU of one burst (padding after it allowed). An SPDU (squitter, 66 octets): byte 0 RLS / version / ISO 8208 /
// change note, byte 1 ground station id and UTC sync, bytes 2-3 the TDMA frame index (12 bits) and slot offset, 52 the
// minimum priority, 53-54 the system table version, then the frequency masks of the sender and of two other stations,
// FCS 64-65. An MPDU: byte 0 bit 0 set, bit 1 downlink; downlink: the LPDU count in bits 2-5, ground station id,
// aircraft id, 3 octets, one size octet per LPDU, FCS; uplink: the aircraft count - 1 in bits 4-6, ground station id,
// per aircraft (id, LPDU count << 4, sizes), FCS. Size octet = length - 1. LPDU: type octet, body, FCS (CRC-16/X.25).

import { fcsOk } from './phy';
import { gsName, hfdlStation, maskKhz } from './stations';
import { d2, hex, khzList, khzMask, readHfnpdu } from './hfnpdu';
import type { HfdlMessage } from './types';

const SPDU_LEN = 66;
/** Messages one PDU gives at most (OnAir's 128). */
const MAX_MESSAGES = 128;
const NOTES = ['none', 'channel down', 'upcoming frequency change', 'ground station down'];

/** A message with OnAir's defaults (-1 / empty / 0). */
export function newMessage(over: Partial<HfdlMessage> = {}): HfdlMessage {
	return {
		squitter: false,
		uplink: false,
		utcSync: false,
		gsId: 0,
		acId: -1,
		frameIndex: -1,
		systable: -1,
		activeKhz: [],
		icao: 0,
		kind: '',
		hfnpdu: '',
		summary: '',
		detail: [],
		flight: '',
		hasPos: false,
		lat: 0,
		lon: 0,
		posKind: '',
		utcSec: -1,
		bad: false,
		...over,
	};
}

/** The bits of an octet in reverse order. */
const rev8 = (x: number): number => {
	let v = x;
	v = ((v & 0xf0) >> 4) | ((v & 0x0f) << 4);
	v = ((v & 0xcc) >> 2) | ((v & 0x33) << 2);
	return ((v & 0xaa) >> 1) | ((v & 0x55) << 1);
};

function spdu(p: Uint8Array): HfdlMessage | undefined {
	if (p.length < SPDU_LEN || !fcsOk(p.subarray(0, SPDU_LEN))) return undefined;
	const gs = p[1] & 0x7f;
	const m = newMessage({ squitter: true, uplink: true, kind: 'SPDU', gsId: gs, utcSync: p[1] >> 7 !== 0 });
	m.frameIndex = p[2] | ((p[3] & 0xf) << 8);
	m.systable = p[53] | ((p[54] & 0xf) << 8);
	m.activeKhz = maskKhz(gs, (p[54] >> 4) | (p[55] << 4) | (p[56] << 12));
	const t = m.frameIndex * 32;
	m.detail.push(['SPDU', `squitter from ground station ${gsName(gs)}, ${m.utcSync ? 'UTC synchronised' : 'not UTC synchronised'}`]);
	m.detail.push([
		'Squitter',
		`version ${(p[0] >> 2) & 3}, change note: ${NOTES[(p[0] >> 6) & 3]}, RLS ${p[0] & 2 ? 'in use' : 'not in use'}, ISO 8208 ${p[0] & 0x20 ? 'supported' : 'not supported'}`,
	]);
	m.detail.push([
		'TDMA frame',
		`${m.frameIndex} (${d2(Math.trunc(t / 3600) % 24)}:${d2(Math.trunc((t % 3600) / 60))}:${d2(t % 60)} UTC at 32 s per frame), offset ${p[3] >> 4}, minimum priority ${p[52] & 0xf}, system table version ${m.systable}`,
	]);
	m.detail.push(['Frequencies in use', `${khzList(m.activeKhz)} kHz`]);
	const id1 = p[57] & 0x7f;
	const id2 = (p[60] >> 4) | ((p[61] & 7) << 4);
	const mask1 = p[58] | (p[59] << 8) | ((p[60] & 0xf) << 16);
	const mask2 = (p[61] >> 4) | (p[62] << 4) | (p[63] << 12);
	if (id1) m.detail.push(['Station', `${gsName(id1)}${p[57] & 0x80 ? ' (UTC)' : ''}: ${khzMask(id1, mask1)} kHz`]);
	if (id2) m.detail.push(['Station', `${gsName(id2)}${p[61] & 8 ? ' (UTC)' : ''}: ${khzMask(id2, mask2)} kHz`]);
	const name = hfdlStation(gs)?.name ?? `GS ${gs}`;
	m.summary = `Squitter ${name}, frame ${m.frameIndex}, ${m.activeKhz.length} frequencies in use`;
	return m;
}

/** The 24-bit address of a logon LPDU at p[at ..]: its three octets are sent with their bits reversed. */
const icaoAt = (p: Uint8Array, len: number, at: number): number =>
	len >= at + 3 ? ((rev8(p[at]) << 16) | (rev8(p[at + 1]) << 8) | rev8(p[at + 2])) >>> 0 : 0;

const LOGON: Record<number, string> = { 0x8f: 'Logon request', 0xbf: 'Logon request (DLS)', 0x4f: 'Logon resume' };
const CONFIRM: Record<number, string> = { 0x9f: 'Logon confirm', 0x5f: 'Logon resume confirm' };
const DENIED: Record<number, string> = { 0x2f: 'Logon denied', 0x3f: 'Logoff request' };

/** The LPDU `p` (its check sequence already checked). */
function readLpdu(p: Uint8Array, m: HfdlMessage): void {
	const len = p.length - 2;
	const t = p[0];
	if (t === 0x0d || t === 0x1d) {
		m.kind = t === 0x0d ? 'Unnumbered data' : 'Unnumbered acked data';
		m.detail.push(['LPDU', `${m.kind}, ${len - 1} octets`]);
		readHfnpdu(p.subarray(1, len), m);
		return;
	}
	if (LOGON[t]) {
		m.kind = LOGON[t];
		m.icao = icaoAt(p, len, 1);
		m.summary = `${m.kind} from ${hex(m.icao, 6)}`;
	} else if (CONFIRM[t]) {
		m.kind = CONFIRM[t];
		m.icao = icaoAt(p, len, 1);
		if (len >= 5) m.acId = p[4];
		m.summary = `${m.kind} ${hex(m.icao, 6)}, aircraft id ${m.acId}`;
	} else if (DENIED[t]) {
		m.kind = DENIED[t];
		m.icao = icaoAt(p, len, 1);
		m.summary = `${m.kind} ${hex(m.icao, 6)}, reason ${len >= 5 ? p[4] : -1}`;
	} else {
		m.kind = 'LPDU';
		m.summary = `LPDU type 0x${hex(t, 2)} (${len} octets)`;
	}
	m.detail.push(['LPDU', m.summary]);
}

/** The (aircraft id, LPDU length) list and the header length of an MPDU; undefined when it is cut short. */
function mpduParts(p: Uint8Array, down: boolean): { parts: Array<[number, number]>; hdr: number } | undefined {
	const n = p.length;
	const parts: Array<[number, number]> = [];
	if (down) {
		const cnt = (p[0] >> 2) & 0xf;
		const hdr = 6 + cnt;
		if (n < hdr + 2) return undefined;
		for (let i = 0; i < cnt; i++) parts.push([p[2], p[6 + i] + 1]);
		return { parts, hdr };
	}
	const nac = ((p[0] & 0x70) >> 4) + 1;
	let at = 2;
	for (let k = 0; k < nac; k++) {
		if (n < at + 2) return undefined;
		const ac = p[at];
		const cnt = (p[at + 1] >> 4) & 0xf;
		if (n < at + 2 + cnt) return undefined;
		for (let i = 0; i < cnt; i++) parts.push([ac, p[at + 2 + i] + 1]);
		at += 2 + cnt;
	}
	return { parts, hdr: at };
}

/** The PDU of one burst (padding after it allowed): one message per SPDU or LPDU; undefined when no check sequence is right. */
export function parsePdu(p: Uint8Array): HfdlMessage[] | undefined {
	if (p.length < 4) return undefined;
	if ((p[0] & 1) === 0) {
		const m = spdu(p);
		return m ? [m] : undefined;
	}
	const down = (p[0] & 2) !== 0;
	const layout = mpduParts(p, down);
	if (!layout || p.length < layout.hdr + 2 || !fcsOk(p.subarray(0, layout.hdr + 2))) return undefined;
	const gs = p[1] & 0x7f;
	const out: HfdlMessage[] = [];
	let at = layout.hdr + 2;
	for (const [ac, len] of layout.parts) {
		if (at + len > p.length) break;
		const m = newMessage({ uplink: !down, gsId: gs, acId: ac });
		m.detail.push(['MPDU', `${down ? 'downlink' : 'uplink'}, ground station ${gsName(gs)}, aircraft id ${ac}`]);
		const lpdu = p.subarray(at, at + len);
		if (len >= 3 && fcsOk(lpdu)) readLpdu(lpdu, m);
		else {
			m.kind = 'LPDU';
			m.summary = 'LPDU with a bad check sequence';
			m.bad = true;
			m.detail.push(['LPDU', 'check sequence FAILED']);
		}
		if (out.length < MAX_MESSAGES) out.push(m);
		at += len;
	}
	if (!layout.parts.length)
		out.push(newMessage({ uplink: !down, gsId: gs, acId: down ? p[2] : -1, kind: 'MPDU', summary: 'MPDU without LPDUs' }));
	return out;
}
