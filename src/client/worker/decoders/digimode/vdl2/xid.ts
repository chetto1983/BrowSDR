// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir rust/onair_vdl2/src/xid.rs (read_xid),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: the parameter lines are labelled.
//
// XID frames (exchange identification, ICAO Doc 9776 section 6.3 / ISO 4335): the VDL parameter groups of ground
// station information frames (GSIF) and of link establishment, handoff and parameter negotiation: parameter set,
// connection management (h and r bits), sequencing, airports, aircraft / ground station locations (12 bit signed
// tenths of a degree), frequency and modulation lists.

import { cstr, hexNum, hexs } from './proto';
import type { Vdl2Line, Vdl2Message, Vdl2XidBits as Bits } from './types';

/** 12 bit two's complement. */
const signed12 = (v: number): number => (v & 0x800 ? v - 0x1000 : v);

const NAMES = [
	'XID',
	'XID_CMD_LCR',
	'XID_CMD_HO',
	'GSIF',
	'XID_CMD_LE',
	'XID',
	'XID_CMD_HO',
	'XID_CMD_LPM',
	'XID',
	'XID',
	'XID',
	'XID',
	'XID_RSP_LE',
	'XID_RSP_LCR',
	'XID_RSP_HO',
	'XID_RSP_LPM',
];

const DESCRIPTIONS: Record<string, string> = {
	GSIF: 'ground station information',
	XID_CMD_LE: 'link establishment',
	XID_RSP_LE: 'link establishment response',
	XID_CMD_HO: 'handoff',
	XID_RSP_HO: 'handoff response',
	XID_CMD_LCR: 'link connection refused',
};

const TEXT_PARAMS: Record<number, string> = {
	0x00: 'Parameter set',
	0x83: 'Destination airport',
	0xc1: 'Airport coverage',
	0xc3: 'Nearest airport',
};

function location(id: number, v: Uint8Array, m: Vdl2Message): Vdl2Line {
	const la = signed12((v[0] << 4) | (v[1] >> 4)) / 10;
	const lo = signed12(((v[1] & 0xf) << 8) | v[2]) / 10;
	m.hasPos = true;
	m.lat = la;
	m.lon = lo;
	const alt = id === 0x84 && v.length >= 4;
	if (alt) {
		m.hasAlt = true;
		m.altFt = v[3] * 1000;
	}
	m.posKind = id === 0x84 ? 'XID aircraft location' : 'XID ground station location';
	const text = `${Math.abs(la).toFixed(1)}${la < 0 ? 'S' : 'N'} ${Math.abs(lo).toFixed(1)}${lo < 0 ? 'W' : 'E'}${alt ? ` ${v[3] * 1000} ft` : ''}`;
	return [id === 0x84 ? 'Aircraft location' : 'Ground station location', text];
}

/** One parameter of the VDL group (0xF0). */
function vdlParam(id: number, v: Uint8Array, m: Vdl2Message, bits: Bits): Vdl2Line | undefined {
	const len = v.length;
	if (TEXT_PARAMS[id]) return [TEXT_PARAMS[id], cstr(v)];
	switch (id) {
		case 0x01:
			if (len < 1) return undefined;
			bits.r = v[0] & 1;
			bits.h = (v[0] >> 1) & 1;
			return ['Connection management', `h ${bits.h}, r ${bits.r}`];
		case 0x03:
			return len >= 1 ? ['XID sequencing', `seq ${v[0] & 7}, retry ${v[0] >> 4}`] : undefined;
		case 0x84:
		case 0xc8:
			return len >= 3 ? location(id, v, m) : undefined;
		case 0xc0:
			return ['Frequency support list', `${len} octets`];
		case 0x82:
			return ['Alternate ground stations', `${len} octets`];
		case 0x81:
			return ['Modulation support', len ? hexs(v) : '-'];
		default:
			return [`VDL parameter ${hexNum(id, 2)}`, hexs(v)];
	}
}

/** The parameters of one group; false when nothing was read. */
function readGroup(gid: number, g: Uint8Array, m: Vdl2Message, bits: Bits, lines: Vdl2Line[]): boolean {
	let any = false;
	for (let k = 0; k + 2 <= g.length;) {
		const id = g[k];
		const len = g[k + 1];
		if (k + 2 + len > g.length) break;
		const v = g.subarray(k + 2, k + 2 + len);
		any = true;
		const line = gid === 0xf0 ? vdlParam(id, v, m, bits) : gid === 0x80 ? ([`Public parameter ${id}`, hexs(v)] as Vdl2Line) : undefined;
		if (line) lines.push(line);
		k += 2 + len;
	}
	return any;
}

/**
 * Reads an XID information field (public parameter group 0x80 and the VDL group 0xF0) and names the frame by its C/R,
 * P/F, h and r bits (`m.response` and `m.pf` are already set).
 */
export function readXid(p: Uint8Array, m: Vdl2Message): void {
	const n = p.length;
	m.proto = 'XID';
	const bits: Bits = { h: 1, r: 1 };
	const lines: Vdl2Line[] = [];
	let any = false;
	if (n >= 3 && p[0] === 0x82) {
		for (let o = 1; o + 3 <= n;) {
			const gid = p[o];
			const glen = (p[o + 1] << 8) | p[o + 2];
			o += 3;
			if (o + glen > n) break;
			if (readGroup(gid, p.subarray(o, o + glen), m, bits, lines)) any = true;
			o += glen;
		}
	}
	const kind = ((m.response ? 1 : 0) << 3) | ((m.pf ? 1 : 0) << 2) | (bits.h << 1) | bits.r;
	const name = NAMES[kind & 15];
	m.frameName = name;
	const desc = DESCRIPTIONS[name] ?? 'link parameters';
	m.summary = `${name} (${desc})`;
	m.detail.push(['XID', desc + (any ? '' : ', no parameters read')], ...lines);
}
