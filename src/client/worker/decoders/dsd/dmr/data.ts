// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir rust/onair_dmr/src/data.rs (dpf_name, sap_name, pack_data_header,
// parse_data_header, data_block_bytes, data_block_encode, data_block_parse), https://github.com/adswill/OnAir; see
// third_party/onair.
// Changes: the header parser returns null for an unknown format; the field readers are split per format.
//
// DMR data packets (ETSI TS 102 361-1 clauses 9.2 and 9.3): the data header formats, the data block sizes, and the
// blocks of rate 1/2 (BPTC), rate 3/4 (trellis) and rate 1 data with the confirmed block serial number and CRC-9.
import { bytesToBits, crc9 } from './codes';
import { be24, putBe24 } from './lc';
import { bptc196Encode, rate1Encode, trellis34Encode } from './product';
import type { DataBlock, DataHeader } from './types';

export const DPF_UDT = 0;
export const DPF_RESPONSE = 1;
export const DPF_UNCONFIRMED = 2;
export const DPF_CONFIRMED = 3;
export const DPF_SHORT_DEFINED = 13;
export const DPF_SHORT_RAW = 14;
export const DPF_PROPRIETARY = 15;

export const DT_PI_HEADER = 0;
export const DT_VOICE_LC_HEADER = 1;
export const DT_TERMINATOR_LC = 2;
export const DT_CSBK = 3;
export const DT_MBC_HEADER = 4;
export const DT_MBC_CONTINUATION = 5;
export const DT_DATA_HEADER = 6;
export const DT_RATE12 = 7;
export const DT_RATE34 = 8;
export const DT_IDLE = 9;
export const DT_RATE1 = 10;
export const DT_USBD = 11;

/** 9 bit CRC masks of the confirmed blocks. */
const MASK_RATE12 = 0x0f0;
const MASK_RATE34 = 0x1ff;
const MASK_RATE1 = 0x10f;

const DPF_NAMES: Readonly<Record<number, string>> = {
	[DPF_UDT]: 'UDT',
	[DPF_RESPONSE]: 'response',
	[DPF_UNCONFIRMED]: 'unconfirmed data',
	[DPF_CONFIRMED]: 'confirmed data',
	[DPF_SHORT_DEFINED]: 'short data (defined)',
	[DPF_SHORT_RAW]: 'short data (raw/status)',
	[DPF_PROPRIETARY]: 'proprietary data',
};
export const dpfName = (d: number) => DPF_NAMES[d] ?? 'data';

const SAP_NAMES: Readonly<Record<number, string>> = {
	0: 'UDT',
	2: 'TCP/IP header compression',
	3: 'UDP/IP header compression',
	4: 'IP',
	5: 'ARP',
	9: 'proprietary',
	10: 'short data',
};
export const sapName = (s: number) => SAP_NAMES[s] ?? 'SAP';

export function emptyDataHeader(dpf = 0): DataHeader {
	return {
		dpf,
		sap: 0,
		group: false,
		resp: false,
		dst: 0,
		src: 0,
		blocks: 0,
		pad: 0,
		fmf: false,
		fsn: 0,
		ns: 0,
		dd: 0,
		sp: 0,
		dp: 0,
		resync: false,
		sarq: false,
		status: 0,
	};
}

/** The first ten octets of a header (the CRC is added by crcBlockInfo with the data header mask). */
export function packDataHeader(h: DataHeader): Uint8Array {
	const o = new Uint8Array(10);
	const b = h.blocks;
	const flags = (h.group ? 0x80 : 0) | (h.resp ? 0x40 : 0);
	putBe24(o, 2, h.dst);
	putBe24(o, 5, h.src);
	if (h.dpf === DPF_UNCONFIRMED || h.dpf === DPF_CONFIRMED) {
		o[0] = flags | (((h.pad >> 4) & 1) << 4) | h.dpf;
		o[1] = (h.sap << 4) | (h.pad & 15);
		o[8] = (h.fmf ? 0x80 : 0) | (b & 0x7f);
		o[9] = h.dpf === DPF_CONFIRMED ? (h.resync ? 0x80 : 0) | ((h.ns & 7) << 4) | (h.fsn & 15) : h.fsn & 15;
	} else if (h.dpf === DPF_SHORT_DEFINED || h.dpf === DPF_SHORT_RAW) {
		o[0] = flags | (((b >> 4) & 3) << 4) | h.dpf;
		o[1] = (h.sap << 4) | (b & 15);
		const tail = (h.sarq ? 2 : 0) | (h.fmf ? 1 : 0);
		if (h.dpf === DPF_SHORT_DEFINED) o[8] = ((h.dd & 63) << 2) | tail;
		else o[8] = ((h.sp & 7) << 5) | ((h.dp & 7) << 2) | (b === 0 ? (h.status >> 8) & 3 : tail);
		o[9] = h.dpf === DPF_SHORT_RAW && b === 0 ? h.status & 0xff : h.pad;
	} else {
		o.fill(0);
		o[0] = h.dpf;
	}
	return o;
}

function parsePacket(i: Uint8Array, h: DataHeader): void {
	h.group = (i[0] & 0x80) !== 0;
	h.resp = (i[0] & 0x40) !== 0;
	h.pad = (((i[0] >> 4) & 1) << 4) | (i[1] & 15);
	h.fmf = (i[8] & 0x80) !== 0;
	h.blocks = i[8] & 0x7f;
	if (h.dpf === DPF_CONFIRMED) {
		h.resync = (i[9] & 0x80) !== 0;
		h.ns = (i[9] >> 4) & 7;
	}
	h.fsn = i[9] & 15;
}

function parseShort(i: Uint8Array, h: DataHeader): void {
	h.group = (i[0] & 0x80) !== 0;
	h.resp = (i[0] & 0x40) !== 0;
	h.blocks = (((i[0] >> 4) & 3) << 4) | (i[1] & 15);
	if (h.dpf === DPF_SHORT_DEFINED) {
		h.dd = i[8] >> 2;
		h.sarq = ((i[8] >> 1) & 1) !== 0;
		h.fmf = (i[8] & 1) !== 0;
		h.pad = i[9];
		return;
	}
	h.sp = i[8] >> 5;
	h.dp = (i[8] >> 2) & 7;
	if (h.blocks === 0) h.status = ((i[8] & 3) << 8) | i[9];
	else {
		h.sarq = ((i[8] >> 1) & 1) !== 0;
		h.fmf = (i[8] & 1) !== 0;
		h.pad = i[9];
	}
}

/** Parses the ten octets of a header; null for a format that is not known. */
export function parseDataHeader(i: Uint8Array): DataHeader | null {
	const h = emptyDataHeader(i[0] & 15);
	if (h.dpf === DPF_PROPRIETARY) {
		h.sap = i[0] >> 4;
		return h;
	}
	h.sap = i[1] >> 4;
	h.dst = be24(i, 2);
	h.src = be24(i, 5);
	if (h.dpf === DPF_UNCONFIRMED || h.dpf === DPF_CONFIRMED) parsePacket(i, h);
	else if (h.dpf === DPF_SHORT_DEFINED || h.dpf === DPF_SHORT_RAW) parseShort(i, h);
	else if (h.dpf === DPF_RESPONSE) {
		h.resp = (i[0] & 0x40) !== 0;
		h.fmf = (i[8] & 0x80) !== 0;
		h.blocks = i[8] & 0x7f;
		h.status = i[9];
	} else if (h.dpf === DPF_UDT) {
		h.group = (i[0] & 0x80) !== 0;
		h.resp = (i[0] & 0x40) !== 0;
		h.blocks = i[8] & 3;
	} else return null;
	return h;
}

const BLOCK_BYTES: Readonly<Record<number, number>> = { [DT_RATE12]: 12, [DT_RATE34]: 18, [DT_RATE1]: 24 };
const CONFIRMED_MASK: Readonly<Record<number, number>> = { [DT_RATE12]: MASK_RATE12, [DT_RATE34]: MASK_RATE34, [DT_RATE1]: MASK_RATE1 };

/** Octets of a data block of type `dt`: 12 / 18 / 24 unconfirmed, 10 / 16 / 22 confirmed; 0 for other types. */
export function dataBlockBytes(dt: number, confirmed: boolean): number {
	const n = BLOCK_BYTES[dt] ?? 0;
	return n && confirmed ? n - 2 : n;
}

/**
 * One data block as its 196 payload bits in transmit order: `user` is the data of the block (cut or zero-padded to the
 * block size; confirmed blocks carry the serial number `dbsn` and a CRC-9 in front).
 */
export function dataBlockEncode(dt: number, user: ArrayLike<number>, confirmed: boolean, dbsn: number): Uint8Array {
	const total = BLOCK_BYTES[dt] ?? 24;
	const oct = new Uint8Array(24);
	if (confirmed) {
		const u = new Uint8Array(total - 2);
		for (let i = 0; i < Math.min(user.length, u.length); i++) u[i] = user[i];
		const crc = (crc9(u, dbsn) ^ (CONFIRMED_MASK[dt] ?? MASK_RATE12)) & 0x1ff;
		oct[0] = ((dbsn & 0x7f) << 1) | ((crc >> 8) & 1);
		oct[1] = crc & 0xff;
		oct.set(u, 2);
	} else for (let i = 0; i < Math.min(user.length, total); i++) oct[i] = user[i];
	if (dt === DT_RATE34) return trellis34Encode(oct);
	if (dt === DT_RATE1) return rate1Encode(oct);
	return bptc196Encode(bytesToBits(oct.subarray(0, 12)));
}

/** Splits the decoded octets of a block (12 / 18 / 24 octets by type); null for a type that is not a data block type. */
export function dataBlockParse(dt: number, oct: Uint8Array, confirmed: boolean): DataBlock | null {
	const total = BLOCK_BYTES[dt];
	if (!total || oct.length < total) return null;
	if (!confirmed) return { bytes: oct.slice(0, total), dbsn: 0, crcOk: true };
	const dbsn = oct[0] >> 1;
	const rx = ((oct[0] & 1) << 8) | oct[1];
	const body = oct.slice(2, total);
	return { bytes: body, dbsn, crcOk: rx === ((crc9(body, dbsn) ^ CONFIRMED_MASK[dt]) & 0x1ff) };
}
