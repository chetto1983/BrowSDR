// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir rust/onair_dmr/src/lc.rs (pack_full_lc, parse_full_lc, flco_name,
// service_options_text, lc_burst_info, lc_burst_decode, crc_block_info, crc_block_check, csbk_info, csbk_parse,
// csbk_name, be24, put_be24), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the GPS info LC (FLCO 8), which OnAir only names, is decoded here after TS 102 361-2 clauses 7.1.1.3 and
// 7.2.15 to 7.2.17 (field positions checked against DSD-FME's dsd_gps.c, GPL-3.0; no code taken); Motorola's talker
// alias and GPS opcodes under FID 0x10 (FLCO 0x14 to 0x18, as DSD-FME's dmr_flco.c reads them) map to the standard ones.
//
// DMR link control and control blocks (ETSI TS 102 361-1 clause 7 and annex B).
import { bitsToBytes, bytesToBits, crcCcitt, getBits, rs129Correct, rs129Parity } from './codes';
import type { Csbk, DmrLocation, FullLc } from './types';

export const FLCO_GROUP_VOICE = 0;
export const FLCO_UNIT_VOICE = 3;
export const FLCO_TA_HEADER = 4;
export const FLCO_TA_BLOCK3 = 7;
export const FLCO_GPS_INFO = 8;

export const MASK_PI = 0x6969;
export const MASK_CSBK = 0xa5a5;
export const MASK_MBC_HEADER = 0xaaaa;
export const MASK_DATA_HEADER = 0xcccc;
export const MASK_USBD = 0x3333;

export const be24 = (p: ArrayLike<number>, at = 0) => (p[at] << 16) | (p[at + 1] << 8) | p[at + 2];
export function putBe24(p: Uint8Array, at: number, v: number): void {
	p[at] = (v >> 16) & 0xff;
	p[at + 1] = (v >> 8) & 0xff;
	p[at + 2] = v & 0xff;
}

/** The nine octets of a full LC (PF + FLCO, FID, service options, destination, source). */
export function packFullLc(lc: Pick<FullLc, 'pf' | 'flco' | 'fid' | 'svc' | 'dst' | 'src'>): Uint8Array {
	const out = new Uint8Array(9);
	out[0] = (lc.pf ? 0x80 : 0) | (lc.flco & 0x3f);
	out[1] = lc.fid & 0xff;
	out[2] = lc.svc & 0xff;
	putBe24(out, 3, lc.dst);
	putBe24(out, 6, lc.src);
	return out;
}

/** Reads the nine octets of a full LC; Motorola's alias and GPS opcodes (FID 0x10, FLCO 0x14..0x18) are taken as the standard ones. */
export function parseFullLc(raw: Uint8Array): FullLc {
	let flco = raw[0] & 0x3f;
	let fid = raw[1];
	if (fid === 0x10 && flco >= 0x14 && flco <= 0x18) {
		flco -= 0x10;
		fid = 0;
	}
	return { raw, pf: (raw[0] & 0x80) !== 0, flco, fid, svc: raw[2], dst: be24(raw, 3), src: be24(raw, 6) };
}

export function flcoName(f: number): string {
	if (f === FLCO_GROUP_VOICE) return 'group voice';
	if (f === FLCO_UNIT_VOICE) return 'unit to unit voice';
	if (f === FLCO_TA_HEADER) return 'talker alias header';
	if (f > FLCO_TA_HEADER && f <= FLCO_TA_BLOCK3) return 'talker alias block';
	return f === FLCO_GPS_INFO ? 'GPS info' : 'link control';
}

/** Service options in words ("emergency privacy broadcast OVCM priority 2"). */
export function serviceOptionsText(svc: number): string {
	const words = [
		svc & 0x80 && 'emergency',
		svc & 0x40 && 'privacy',
		svc & 0x08 && 'broadcast',
		svc & 0x04 && 'OVCM',
		svc & 3 && `priority ${svc & 3}`,
	];
	return words.filter(Boolean).join(' ');
}

/** Header / terminator burst information: 72 bit LC + RS (12,9) parity masked per data type (0x96 header, 0x99 terminator) as 96 bits. */
export function lcBurstInfo(lc: ArrayLike<number>, terminator: boolean): Uint8Array {
	const w = new Uint8Array(12);
	for (let i = 0; i < 9; i++) w[i] = lc[i];
	const mask = terminator ? 0x99 : 0x96;
	rs129Parity(w).forEach((p, i) => (w[9 + i] = p ^ mask));
	return bytesToBits(w);
}

/** Decodes a header / terminator burst: [0 clean, 1 one octet corrected, -1 failed; the nine octets]. */
export function lcBurstDecode(info96: ArrayLike<number>, terminator: boolean): [number, Uint8Array] {
	const w = bitsToBytes(info96, 0, 96);
	const mask = terminator ? 0x99 : 0x96;
	for (let i = 9; i < 12; i++) w[i] ^= mask;
	const e = rs129Correct(w);
	return [e, w.slice(0, 9)];
}

/** 96 bits of a block: ten data octets and their CRC-CCITT XOR `mask`. */
export function crcBlockInfo(data10: ArrayLike<number>, mask: number): Uint8Array {
	const w = new Uint8Array(12);
	for (let i = 0; i < 10; i++) w[i] = data10[i];
	const crc = crcCcitt(w, 10) ^ mask;
	w[10] = crc >> 8;
	w[11] = crc & 0xff;
	return bytesToBits(w);
}

/** The ten data octets of a 96 bit block whose CRC matches, or null. */
export function crcBlockCheck(info96: ArrayLike<number>, mask: number): Uint8Array | null {
	const b = bitsToBytes(info96, 0, 96);
	return (crcCcitt(b, 10) ^ mask) === ((b[10] << 8) | b[11]) ? b.slice(0, 10) : null;
}

/** The 96 bits of a CSBK with its CRC. */
export function csbkInfo(c: Csbk): Uint8Array {
	const d = new Uint8Array(10);
	d[0] = (c.lb ? 0x80 : 0) | (c.pf ? 0x40 : 0) | (c.opcode & 0x3f);
	d[1] = c.fid;
	d.set(c.data.subarray(0, 8), 2);
	return crcBlockInfo(d, MASK_CSBK);
}

/** Parses 96 bits as a CSBK; null when the CRC does not match. */
export function csbkParse(info96: ArrayLike<number>): Csbk | null {
	const d = crcBlockCheck(info96, MASK_CSBK);
	return d && { lb: (d[0] & 0x80) !== 0, pf: (d[0] & 0x40) !== 0, opcode: d[0] & 0x3f, fid: d[1], data: d.slice(2) };
}

const CSBK_NAMES: Readonly<Record<number, string>> = {
	0x04: 'unit to unit voice request',
	0x05: 'unit to unit answer',
	0x07: 'channel timing',
	0x26: 'negative acknowledge',
	0x38: 'BS outbound activation',
	0x3d: 'preamble',
};
/** CSBK opcode name. */
export const csbkName = (op: number, fid: number) => (fid ? 'manufacturer CSBK' : (CSBK_NAMES[op] ?? 'CSBK'));

/** Two's complement value of an n-bit field. */
const signed = (v: number, n: number) => (v >= 2 ** (n - 1) ? v - 2 ** n : v);

/**
 * GPS info LC (FLCO 8, TS 102 361-2 7.1.1.3): reserved (4), position error (3), longitude (25, two's complement,
 * 360 / 2^25 degrees), latitude (24, two's complement, 180 / 2^24 degrees). Null when protected or out of range.
 */
export function gpsInfoParse(lc: FullLc): (DmrLocation & { errorM: number }) | null {
	if (lc.flco !== FLCO_GPS_INFO || lc.pf) return null;
	const bits = bytesToBits(lc.raw);
	const posErr = getBits(bits, 20, 3);
	const lon = (signed(getBits(bits, 23, 25), 25) * 360) / 2 ** 25;
	const lat = (signed(getBits(bits, 48, 24), 24) * 180) / 2 ** 24;
	if (Math.abs(lat) >= 90 || Math.abs(lon) >= 180 || (lat === 0 && lon === 0)) return null;
	// 7.2.15: less than 2 * 10^n metres; 7 is unknown or not valid
	return { hasFix: true, resultCode: 0, lat, lon, errorM: posErr === 7 ? -1 : 2 * 10 ** posErr };
}
