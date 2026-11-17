// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/dmr/dmr_vendor.cpp (vendorCsbkName, CapPlus::feed,
// conPlusParse, ipService), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the Capacity Plus accumulator keeps its blocks in Uint8Arrays and returns the grants or null; TMS text is a
// JavaScript string (an unpaired surrogate becomes '?').
//
// DMR beyond the ETSI grants: Motorola Capacity Plus and Connect Plus CSBKs (OnAir read the layouts from DSD-FME
// dmr_csbk.c by Louis Wilson lwvmobile, GPL-3.0, whose notes credit OP25 (Graham J. Norbury, boatbod) and Eric
// Cottrell; partly reverse-engineered by those projects), and the Motorola IP services carried as data: ARS (UDP port
// 4005) and text messages, TMS (UDP port 4007).
import type { CapPlusGrant, ConPlus, IpService } from './types';

/** Name of a Capacity Plus (FID 0x10) or Connect Plus (FID 0x06) CSBK, '' for other makes. */
export function vendorCsbkName(fid: number, op: number): string {
	if (fid === 0x10) {
		const names: Record<number, string> = { 0x3a: 'control', 0x3b: 'adjacent sites', 0x3e: 'channel status' };
		return names[op] ? `Capacity Plus: ${names[op]}` : 'Capacity Plus';
	}
	if (fid === 0x06) {
		const names: Record<number, string> = { 0x01: 'adjacent sites', 0x03: 'voice grant', 0x06: 'data grant', 0x0c: 'slot termination' };
		return names[op] ? `Connect Plus: ${names[op]}` : 'Connect Plus';
	}
	return '';
}

/** Capacity Plus channel status (FID 0x10, opcode 0x3E): the blocks of one transmission are accumulated per slot. */
export class CapPlus {
	private bits = [new Uint8Array(64), new Uint8Array(64)];
	private blocks = [0, 0];

	/** data: the 8 bytes after opcode and FID. The groups on air and the rest channel when this block completed a table, else null. */
	feed(d: Uint8Array): { grants: CapPlusGrant[]; rest: number } | null {
		const fl = d[0] >> 6;
		const ts = (d[0] >> 5) & 1;
		const rest = d[0] & 0x0f;
		const b = this.bits[ts];
		if (fl === 2 || fl === 3) {
			// first or only block
			b.fill(0);
			b.set(d.subarray(0, 8), 0);
			this.blocks[ts] = 0;
		} else {
			// a further block: seven more bytes
			if (this.blocks[ts] >= 6) return null;
			b.set(d.subarray(1, 8), 8 + 7 * this.blocks[ts]);
			this.blocks[ts]++;
		}
		if (fl !== 1 && fl !== 3) return null;
		const bank1 = b[1];
		let tally = 0;
		for (let i = 0; i < 8; i++) if (bank1 & (0x80 >> i)) tally++;
		const bank2 = 2 + tally < b.length ? b[2 + tally] : 0;
		const grants: CapPlusGrant[] = [];
		let k = 0;
		for (let i = 0; i < 16; i++) {
			const on = i < 8 ? (bank1 >> (7 - i)) & 1 : (bank2 >> (15 - i)) & 1;
			if (i === 8) k++; // the second bank's byte sits between the two lists
			if (!on) continue;
			const at = 2 + k;
			if (at >= b.length) break;
			k++;
			if (b[at]) grants.push({ lsn: i + 1, tg: b[at] });
		}
		return { grants, rest };
	}
}

/** Connect Plus voice grant (0x03), data grant (0x06), slot termination (0x0C), neighbours (0x01); null for other opcodes. */
export function conPlusParse(op: number, d: Uint8Array): ConPlus | null {
	const o: ConPlus = { opcode: op, src: 0, dst: 0, lcn: -1, slot: 0, neighbours: [] };
	const be24 = (at: number) => (d[at] << 16) | (d[at + 1] << 8) | d[at + 2];
	switch (op) {
		case 0x01:
			o.neighbours = Array.from(d.subarray(0, 5), (x) => x & 0x3f);
			return o;
		case 0x03:
			return { ...o, src: be24(0), dst: be24(3), lcn: d[6] >> 4, slot: (d[6] >> 3) & 1 };
		case 0x06:
			return { ...o, dst: be24(0), lcn: d[3] >> 4, slot: (d[3] >> 3) & 1 };
		case 0x0c:
			return { ...o, dst: be24(0) };
		default:
			return null;
	}
}

/** The text of a Motorola TMS message from `ptr` (UTF-16 big-endian, the first character's high byte reused). */
function tmsText(p: Uint8Array, ptr: number, len: number): string {
	const lenText = len > 31 ? len - (ptr - 31) : len;
	let q = ptr - 2;
	let t = '';
	for (let i = 0; i + 1 < lenText && q + 1 < p.length; i += 2, q += 2) {
		const u = i === 0 ? p[q + 1] : (p[q] << 8) | p[q + 1];
		if (u < 0x20) continue;
		t += u >= 0xd800 && u < 0xe000 ? '?' : String.fromCharCode(u);
	}
	return t;
}

/** A Motorola service in an IPv4 / UDP datagram, or null when `p` is not one. */
export function ipService(p: Uint8Array): IpService | null {
	const n = p.length;
	if (n < 28 || p[0] >> 4 !== 4) return null;
	const ihl = (p[0] & 15) * 4;
	if (ihl < 20 || n < ihl + 8 || p[9] !== 17) return null;
	const src = (p[ihl] << 8) | p[ihl + 1];
	const dst = (p[ihl + 2] << 8) | p[ihl + 3];
	if (src === 4005 || dst === 4005) {
		const name = Array.from(p.subarray(ihl + 8, ihl + 48))
			.filter((c) => c >= 0x20 && c < 0x7f)
			.map((c) => String.fromCharCode(c))
			.join('');
		return { port: 4005, ack: false, kind: 'ARS', text: name };
	}
	if (src !== 4007 && dst !== 4007) return null;
	let ptr = ihl + 8;
	if (n < ptr + 4) return null;
	const len = (p[ptr] << 8) | p[ptr + 1];
	ptr += 2;
	const hdr = p[ptr++];
	const adl = p[ptr++];
	ptr += adl;
	if (ptr < n) {
		let more = p[ptr] >> 7;
		while (more && ptr + 1 < n) {
			more = p[ptr++] >> 7;
			if (more) ptr++;
		}
	}
	if (hdr & 0x0f) return { port: 4007, ack: true, kind: 'TMS', text: 'acknowledgment' };
	if (ptr < 2 || ptr > n) return null;
	return { port: 4007, ack: false, kind: 'TMS', text: tmsText(p, ptr, len) };
}
