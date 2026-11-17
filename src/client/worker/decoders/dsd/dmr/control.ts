// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/p25/trunk_ctrl.cpp (DmrModel::onCsbk, DmrModel::onCsbkVendor),
// core/include/dect2/p25/trunk.h (DmrOpcodes, Grant) and core/src/dmr/dmr_link.cpp (activityName and the short LC part
// of Link::handleCach), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: OnAir's Tier III opcode table is marked unverified there (docs/trunking.md) and is not fed from the air; here
// the grant opcodes (0x30 PV_GRANT, 0x31 TV_GRANT, 0x32 BTV_GRANT, 0x33..0x37 data and duplex grants) and the grant
// field positions (12 bit logical physical channel, slot, late entry, emergency, then target and source) follow ETSI TS
// 102 361-4 clause 7.1.1.1.1 as DSD-FME's dmr_csbk.c reads it (Louis Wilson lwvmobile, GPL-3.0; layout read, no code
// taken), where OnAir swaps TV and PV and puts the channel in the low twelve bits. Added from the same layout: the
// C_ALOHA system identity (model, network, site, partition), the C_BCAST announcement kinds and the Tier III CSBK names.
// The CACH short LC pieces are joined only when their bursts follow each other on the air (BrowSDR skips bursts).
import { crc8Short, getBits } from './codes';
import { be24 } from './lc';
import { shortLcDecode } from './product';
import { conPlusParse, type CapPlus } from './vendor';
import type { Csbk, DmrGrant, DmrSystemCode } from './types';

const TIER3_NAMES: Readonly<Record<number, string>> = {
	0x19: 'C_ALOHA',
	0x1a: 'C_UDTHD',
	0x1c: 'C_AHOY',
	0x1e: 'C_ACKVIT',
	0x1f: 'C_RAND',
	0x20: 'C_ACKD',
	0x21: 'C_ACKU',
	0x22: 'P_ACKD',
	0x23: 'P_ACKU',
	0x28: 'C_BCAST',
	0x2a: 'P_MAINT',
	0x2e: 'P_CLEAR',
	0x2f: 'P_PROTECT',
	0x30: 'PV_GRANT private voice',
	0x31: 'TV_GRANT talkgroup voice',
	0x32: 'BTV_GRANT broadcast voice',
	0x33: 'PD_GRANT private data',
	0x34: 'TD_GRANT talkgroup data',
	0x35: 'PV_GRANT_DX duplex private voice',
	0x36: 'PD_GRANT_DX duplex private data',
	0x37: 'PD_GRANT private data, multi item',
	0x39: 'C_MOVE',
};
/** Tier III (TS 102 361-4) name of a standard CSBK opcode, '' when it is not one. */
export const tier3Name = (op: number, fid: number) => (fid ? '' : (TIER3_NAMES[op] ?? ''));

const BCAST_KINDS = [
	'announce/withdraw TSCC',
	'call timer parameters',
	'vote now',
	'local time',
	'mass registration',
	'channel/frequency',
	'adjacent site',
	'general site parameters',
];

/** A Tier III channel grant (opcodes 0x30..0x37, FID 0). */
export function tier3Grant(c: Csbk): DmrGrant | null {
	if (c.fid !== 0 || c.opcode < 0x30 || c.opcode > 0x37) return null;
	const d = c.data;
	return {
		channel: (d[0] << 4) | (d[1] >> 4),
		slot: (d[1] >> 3) & 1,
		emergency: ((d[1] >> 1) & 1) !== 0,
		tg: be24(d, 2),
		src: be24(d, 5),
		group: c.opcode === 0x31 || c.opcode === 0x32 || c.opcode === 0x34,
		data: c.opcode === 0x33 || c.opcode === 0x34 || c.opcode >= 0x36,
	};
}

const MODELS: ReadonlyArray<readonly [string, number]> = [
	['Tiny', 9],
	['Small', 7],
	['Large', 4],
	['Huge', 2],
];

/** The system code of a C_ALOHA (14 bits at CSBK bit 40: model 2, network and site 12; then the partition, 2 bits). */
export function tier3SystemCode(c: Csbk): DmrSystemCode | null {
	if (c.fid !== 0 || c.opcode !== 0x19) return null;
	const bits = Array.from({ length: 64 }, (_, i) => (c.data[i >> 3] >> (7 - (i & 7))) & 1);
	const code = getBits(bits, 24, 14); // CSBK bit 40 = data bit 24
	const [model, netBits] = MODELS[code >> 12];
	const net = (code >> (12 - netBits)) & ((1 << netBits) - 1);
	const site = code & ((1 << (12 - netBits)) - 1);
	const par = ['reserved', 'A', 'B', 'AB'][getBits(bits, 38, 2)];
	return { model, net: net + 1, site: site + 1, par, code };
}

/** A grant in words: "TG 2149 ← 2145007 on channel 12 slot 2". */
export function grantText(g: DmrGrant): string {
	const who = `${g.group ? 'TG' : 'ID'} ${g.tg}${g.src >= 0 ? ` ← ${g.src}` : ''}`;
	return `${who} on channel ${g.channel} slot ${g.slot + 1}${g.data ? ' (data)' : ''}${g.emergency ? ' EMERGENCY' : ''}`;
}

/** What a Tier III CSBK says, in words ('' when it is not one). */
export function tier3Text(c: Csbk): string {
	const name = tier3Name(c.opcode, c.fid);
	if (!name) return '';
	const grant = tier3Grant(c);
	if (grant) return `${name}: ${grantText(grant)}`;
	const sys = tier3SystemCode(c);
	if (sys) return `${name}: ${sys.model} network ${sys.net} site ${sys.site} (${sys.par})`;
	if (c.opcode === 0x28) return `${name}: ${BCAST_KINDS[c.data[0] >> 3] ?? `kind ${c.data[0] >> 3}`}`;
	if (c.opcode === 0x1c || c.opcode === 0x2f) return `${name}: ${be24(c.data, 2)} ← ${be24(c.data, 5)}`;
	return name;
}

/** Capacity Plus channel status (FID 0x10, opcode 0x3E) and Connect Plus grants (FID 0x06, opcode 0x03), as grants. */
export function vendorGrants(c: Csbk, capPlus: CapPlus): { grants: DmrGrant[]; rest?: number } | null {
	if (c.fid === 0x10 && c.opcode === 0x3e) {
		const r = capPlus.feed(c.data);
		const grants = r?.grants.map((g) => ({
			group: true,
			tg: g.tg,
			src: -1,
			channel: g.lsn,
			slot: (g.lsn - 1) & 1,
			emergency: false,
			data: false,
		}));
		return r && { grants: grants ?? [], rest: r.rest };
	}
	if (c.fid === 0x06 && c.opcode === 0x03) {
		const g = conPlusParse(c.opcode, c.data);
		return g && { grants: [{ group: true, tg: g.dst, src: g.src, channel: g.lcn, slot: g.slot, emergency: false, data: false }] };
	}
	return null;
}

const ACTIVITY: Readonly<Record<number, string>> = {
	0: 'none',
	2: 'group CSBK',
	3: 'individual CSBK',
	8: 'group voice',
	9: 'individual voice',
	10: 'individual data',
	11: 'group data',
	12: 'emergency group voice',
	13: 'emergency individual voice',
};
const activityName = (a: number) => ACTIVITY[a] ?? 'reserved';

/** The short LC of a base station's CACH: four 17 bit pieces (LCSS 1, 3, 3, 2) from bursts that follow each other. */
export class ShortLc {
	private pieces: number[][] = [];
	private lastPos = -1;

	reset(): void {
		this.pieces = [];
		this.lastPos = -1;
	}

	/** One CACH (24 bits decoded by cachDecode) at absolute dibit position `pos`: the message text when the fourth piece completes it. */
	add(lcss: number, payload17: number, pos: number): string | null {
		const follows = this.lastPos >= 0 && Math.abs(pos - this.lastPos - 144) <= 2;
		this.lastPos = pos;
		const piece = Array.from({ length: 17 }, (_, i) => (payload17 >> (16 - i)) & 1);
		if (lcss === 1) this.pieces = [piece];
		else if (lcss === 3 && follows && this.pieces.length >= 1 && this.pieces.length <= 2) this.pieces.push(piece);
		else if (lcss === 2 && follows && this.pieces.length === 3) {
			const [e, lc] = shortLcDecode([...this.pieces, piece]);
			this.pieces = [];
			return e < 0 ? null : shortLcText(lc);
		} else this.pieces = [];
		return null;
	}
}

/** Short LC (28 bits) in words: null message, activity update or another opcode. */
export function shortLcText(lc: number): string {
	const slco = lc >> 24;
	if (slco === 0) return 'null';
	if (slco === 1) return `activity: slot 1 ${activityName((lc >> 20) & 15)}, slot 2 ${activityName((lc >> 16) & 15)}`;
	return `short LC opcode ${slco}`;
}

/** Hash of an address (B.3.7) as the activity update carries it (tests, generator). */
export const addressHash = (v: number) => crc8Short(v, 24);
