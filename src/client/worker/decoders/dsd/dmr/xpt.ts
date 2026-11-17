// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/dmr/dmr_xpt.cpp (xptParseCsbk, xptParseCall, xptSiteStatusCsbk,
// xptCallLc, xptSummary), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: none beyond the language.
//
// Hytera XPT (eXtended Pseudo Trunk, DMR Tier II with a trunking layer): the manufacturer-specific control blocks
// FID 0x68 that list the site's repeaters. Read only; OnAir took the field positions from DSD-FME (dmr_csbk.c,
// dmr_flco.c, by Louis Wilson lwvmobile and the DSD-FME authors, ISC / GPL-3.0-or-later), which calls this work
// experimental: no document from the maker is public and no real XPT system was heard.
import type { Csbk, FullLc, XptState } from './types';

export const XPT_FID = 0x68;
export const XPT_SITE_STATUS_OP = 0x0a;
export const XPT_ADJACENT_OP = 0x0b;
export const XPT_CALL_SETUP_FLCO = 0x09;

export function xptState(): XptState {
	return {
		seen: false,
		lastSec: -1e9,
		freeLcn: -1,
		lsn: Array.from({ length: 24 }, () => ({ status: -1, tg: 0, lastSec: -1e9 })),
		adjacent: [],
		calls: [],
	};
}

function bitsAt(d: Uint8Array, bit: number, n: number): number {
	let v = 0;
	for (let i = 0; i < n; i++) v = v * 2 + ((d[(bit + i) >> 3] >> (7 - ((bit + i) & 7))) & 1);
	return v;
}
function putBitsAt(d: Uint8Array, bit: number, n: number, v: number): void {
	for (let i = 0; i < n; i++) if (Math.floor(v / 2 ** (n - 1 - i)) & 1) d[(bit + i) >> 3] |= 1 << (7 - ((bit + i) & 7));
}

/** One block with FID 0x68 and one of the two opcodes: updates st and returns true. */
export function xptParseCsbk(c: Csbk, now: number, st: XptState): boolean {
	if (c.fid !== XPT_FID) return false;
	if (c.opcode === XPT_SITE_STATUS_OP) {
		const seq = (c.lb ? 2 : 0) | (c.pf ? 1 : 0); // lb and pf carry a sequence number on this block
		if (seq > 2) return false; // the fourth value has not been seen in use
		st.seen = true;
		st.lastSec = now;
		st.freeLcn = bitsAt(c.data, 0, 4);
		for (let i = 0; i < 6; i++) st.lsn[seq * 6 + i] = { status: bitsAt(c.data, 4 + 2 * i, 2), tg: c.data[2 + i], lastSec: now };
		return true;
	}
	if (c.opcode !== XPT_ADJACENT_OP) return false;
	st.seen = true;
	st.lastSec = now;
	for (let i = 0; i < 4; i++) {
		const site = bitsAt(c.data, 16 * i, 5);
		if (!site) continue;
		const freeLcn = bitsAt(c.data, 8 + 16 * i, 4);
		const known = st.adjacent.find((a) => a.site === site);
		if (known) Object.assign(known, { freeLcn, lastSec: now });
		else st.adjacent.push({ site, freeLcn, lastSec: now });
	}
	return true;
}

/** Full link control with FID 0x68, FLCO 0x09 (call set-up). */
export function xptParseCall(f: FullLc, now: number, st: XptState): boolean {
	if (f.fid !== XPT_FID || f.flco !== XPT_CALL_SETUP_FLCO) return false;
	const c = {
		lcn: bitsAt(f.raw, 16, 4),
		freeLcn: bitsAt(f.raw, 24, 4),
		handshake: bitsAt(f.raw, 28, 4),
		target: bitsAt(f.raw, 32, 16),
		source: bitsAt(f.raw, 56, 16),
		sec: now,
	};
	st.seen = true;
	st.lastSec = now;
	const first = st.calls[0];
	if (!first || first.target !== c.target || first.source !== c.source || now - first.sec > 3) st.calls.unshift(c);
	else st.calls[0] = c;
	if (st.calls.length > 32) st.calls.pop();
	return true;
}

/** A site status block as the receiver expects it (tests, generator). */
export function xptSiteStatusCsbk(seq: number, freeLcn: number, status: number[], tg: number[]): Csbk {
	const data = new Uint8Array(8);
	putBitsAt(data, 0, 4, freeLcn);
	for (let i = 0; i < 6; i++) {
		putBitsAt(data, 4 + 2 * i, 2, status[i]);
		data[2 + i] = tg[i];
	}
	return { lb: (seq & 2) !== 0, pf: (seq & 1) !== 0, opcode: XPT_SITE_STATUS_OP, fid: XPT_FID, data };
}

/** The nine octets of a call set-up LC (tests, generator). */
export function xptCallLc(lcn: number, freeLcn: number, handshake: number, target: number, source: number): Uint8Array {
	const raw = new Uint8Array(9);
	raw[0] = XPT_CALL_SETUP_FLCO;
	raw[1] = XPT_FID;
	putBitsAt(raw, 16, 4, lcn);
	putBitsAt(raw, 24, 4, freeLcn);
	putBitsAt(raw, 28, 4, handshake);
	putBitsAt(raw, 32, 16, target);
	putBitsAt(raw, 56, 16, source);
	return raw;
}

export function xptSummary(st: XptState): string {
	if (!st.seen) return '';
	const busy = st.lsn.filter((l) => l.status === 3 || l.status === 2).length;
	return `Hytera XPT: free LCN ${st.freeLcn}, ${busy} slot${busy === 1 ? '' : 's'} in use`;
}
