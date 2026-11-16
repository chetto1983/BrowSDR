// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-FileCopyrightText: Copyright (C) 2014 CSP Innovazione nelle ICT s.c.a r.l.
// SPDX-FileCopyrightText: Copyright (C) 2018 Matthias P. Braendli
// SPDX-FileCopyrightText: Copyright (C) 2015 Data Path
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir rust/onair_dab/src/fig.rs (fib_walk, fig0_eid, fig0_subchannels,
// fig0_services, fig1) and core/src/dab/dab_fig_0a.cpp / dab_fig_label.cpp (FIG 0/0 CIF count, the FIG 1 short label
// mask; ported there from etisnoop), https://github.com/adswill/OnAir; see third_party/onair. Changes: the walk calls
// a visitor instead of filling an array; the parsers return plain records.

import type { FigComponent, FigLabel, FigService, FigSubchannel, FigVisitor } from './types';

/** Byte i of d[from .. from + n), 0 past the end. */
const rd = (d: Uint8Array, from: number, n: number, i: number) => (i < n ? d[from + i] : 0);
const rd16 = (d: Uint8Array, from: number, n: number, i: number) => (rd(d, from, n, i) << 8) | rd(d, from, n, i + 1);
const rd32 = (d: Uint8Array, from: number, n: number, i: number) => rd16(d, from, n, i) * 65536 + rd16(d, from, n, i + 2);

/**
 * Walks the FIGs of a 30-byte FIB data field (EN 300 401 clause 5.2): type (3 bits), length (5 bits) and data; 0xFF ends
 * the list and a FIG that runs past byte 30 stops it; FIGs of length 0 are skipped. Returns the bytes used.
 */
export function walkFib(fib: Uint8Array, from: number, visit: FigVisitor): number {
	let i = 0;
	while (i < 30 && fib[from + i] !== 0xff) {
		const head = fib[from + i];
		const type = head >> 5,
			len = head & 31;
		if (i + 1 + len > 30) break;
		const off = from + i + 1;
		i += 1 + len;
		if (len >= 1) visit(type, off, len);
	}
	return Math.min(i, 30);
}

/** FIG 0/0 ensemble identifier (d = the FIG data field incl. the header byte). */
export function fig0Eid(d: Uint8Array, from: number, n: number): number | null {
	return n >= 3 ? rd16(d, from, n, 1) : null;
}

/** FIG 0/0 CIF count (0..4999) of the CIF the FIB belongs to, null when too short (EN 300 401 clause 6.4). */
export function fig0CifCount(d: Uint8Array, from: number, n: number): number | null {
	return n >= 5 ? (d[from + 3] & 0x1f) * 250 + d[from + 4] : null;
}

/** FIG 0/1 sub-channel organisation, short (UEP) and long (EEP) form. */
export function fig0Subchannels(d: Uint8Array, from: number, len: number): FigSubchannel[] {
	const b = from + 1,
		n = len - 1;
	const out: FigSubchannel[] = [];
	let p = 0;
	while (p + 3 <= n) {
		const s: FigSubchannel = {
			id: d[b + p] >> 2,
			start: ((d[b + p] & 3) << 8) | d[b + p + 1],
			eep: false,
			uepTable: false,
			option: 0,
			level: 0,
			size: 0,
			uepIndex: 0,
		};
		const form = d[b + p + 2];
		if (form & 0x80) {
			if (p + 4 > n) break;
			s.eep = true;
			s.option = (form >> 4) & 7;
			s.level = (form >> 2) & 3;
			s.size = ((form & 3) << 8) | d[b + p + 3];
			p += 4;
		} else {
			s.uepIndex = form & 0x3f;
			s.uepTable = (form & 0x40) !== 0;
			p += 3;
		}
		out.push(s);
	}
	return out;
}

function component(d: Uint8Array, at: number): FigComponent {
	const a = d[at],
		b = d[at + 1];
	const c: FigComponent = { tmid: a >> 6, ascty: -1, dscty: -1, subId: -1, scid: -1, primary: ((b >> 1) & 1) === 1 };
	if (c.tmid === 0) {
		c.ascty = a & 63;
		c.subId = b >> 2;
	} else if (c.tmid === 1) {
		c.dscty = a & 63;
		c.subId = b >> 2;
	} else if (c.tmid === 3) c.scid = ((a & 0x3f) << 6) | (b >> 2);
	else c.primary = true;
	return c;
}

/** FIG 0/2 service organisation: services (16-bit SId, or 32-bit with P/D = 1) and their components. */
export function fig0Services(d: Uint8Array, from: number, len: number): FigService[] {
	const pd = (d[from] >> 5) & 1;
	const b = from + 1,
		n = len - 1;
	const out: FigService[] = [];
	let p = 0;
	while (p + 3 <= n) {
		let sid: number;
		if (pd === 0) {
			sid = rd16(d, b, n, p);
			p += 2;
		} else {
			if (p + 5 > n) break;
			sid = rd32(d, b, n, p);
			p += 4;
		}
		const ncomp = rd(d, b, n, p) & 15;
		p++;
		const comps: FigComponent[] = [];
		for (let k = 0; k < ncomp && p + 2 <= n; k++, p += 2) comps.push(component(d, b + p));
		out.push({ sid, comps });
	}
	return out;
}

/** FIG 1 label (EN 300 401 clause 8.1.13): ensemble (0), programme service (1), component (4), data service (5). */
export function fig1(d: Uint8Array, from: number, len: number): FigLabel | null {
	const head = d[from];
	const ext = head & 7,
		charset = head >> 4;
	const n = len - 1,
		b = from + 1;
	const l: FigLabel = { ext, charset, sid: 0, scids: 0, off: 0 };
	if (ext === 0 && n >= 18) l.off = 3;
	else if (ext === 1 && n >= 18) {
		l.sid = rd16(d, b, n, 0);
		l.off = 3;
	} else if (ext === 5 && n >= 20) {
		l.sid = rd32(d, b, n, 0);
		l.off = 5;
	} else if (ext === 4 && n >= 20) {
		const pd = (d[b] & 0x80) !== 0;
		l.scids = d[b] & 0x0f;
		const il = pd ? 4 : 2;
		if (n < 1 + il + 18) return null;
		l.sid = pd ? rd32(d, b, n, 1) : rd16(d, b, n, 1);
		l.off = 2 + il;
	} else return null;
	return l;
}

/** The characters the character flag field after a FIG 1 label selects (the short label), or null when it is not sent. */
export function shortLabelBytes(d: Uint8Array, from: number, len: number, off: number): Uint8Array | null {
	if (off + 18 > len) return null;
	const mask = (d[from + off + 16] << 8) | d[from + off + 17];
	const out: number[] = [];
	for (let i = 0; i < 16; i++) if (mask & (0x8000 >> i)) out.push(d[from + off + i]);
	return Uint8Array.from(out);
}
