// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/wmbus/wmbus_proto.cpp (CRC, 3-out-of-6 code, frame formats A and B,
// link layer, application header, phySpec), https://github.com/adswill/OnAir; see third_party/onair. Changes: S1, T1 and C1
// only (the Wize branch of CI 0x20 and the N / R2 specs are not ported); no decryption (decryptFrame needs a key store);
// the encryption method is kept for the report; buildFrame and encodeChips live in the test signal.

import type { WmbusFrame, WmbusPhy, WmbusPhySpec } from './types';
import { parseRecords } from './records';

const PHY_NAMES: Record<WmbusPhy, string> = { S1: 'S1', T1: 'T1', C1A: 'C1 (A)', C1B: 'C1 (B)' };
export const phyName = (phy: WmbusPhy): string => PHY_NAMES[phy];

const PHY_SPECS: Record<WmbusPhy, WmbusPhySpec> = {
	S1: { phy: 'S1', chipRate: 32768, devHz: 50000, coding: 'manchester', sync: 0x7696 },
	T1: { phy: 'T1', chipRate: 100000, devHz: 50000, coding: 'threeOfSix', sync: 0x543d },
	C1A: { phy: 'C1A', chipRate: 100000, devHz: 50000, coding: 'nrz', sync: 0x543d },
	C1B: { phy: 'C1B', chipRate: 100000, devHz: 50000, coding: 'nrz', sync: 0x543d },
};
export const phySpec = (phy: WmbusPhy): WmbusPhySpec => PHY_SPECS[phy];

/** EN 13757-4 CRC: polynomial 0x3D65, initial value 0, result inverted (CRC-16/EN-13757). */
export function crc16(data: Uint8Array, from = 0, to = data.length): number {
	let c = 0;
	for (let i = from; i < to; i++) {
		c ^= data[i] << 8;
		for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x3d65) & 0xffff : (c << 1) & 0xffff;
	}
	return ~c & 0xffff;
}

/** EN 13757-4 3-out-of-6 table: the 6 chips of each nibble. */
const T36 = [0x16, 0x0d, 0x0e, 0x0b, 0x1c, 0x19, 0x1a, 0x13, 0x2c, 0x25, 0x26, 0x23, 0x34, 0x31, 0x32, 0x29];
const D36 = new Int8Array(64).fill(-1);
T36.forEach((word, nibble) => (D36[word] = nibble));
export const encode36 = (nibble: number): number => T36[nibble & 15];
/** The nibble, or -1 for six chips that are not a code word. */
export const decode36 = (six: number): number => D36[six & 63];

/** Bytes on air (with the CRCs) for a length field L. */
export function airLength(L: number, formatB: boolean): number {
	const n = L + 1;
	if (formatB) return n;
	if (n <= 10) return n + 2;
	return n + 2 + 2 * Math.floor((n - 10 + 15) / 16);
}

export function mfrCodeToString(m: number): string {
	return String.fromCharCode(((m >> 10) & 31) + 64, ((m >> 5) & 31) + 64, (m & 31) + 64);
}

export function mfrStringToCode(t: string): number {
	return (((t.charCodeAt(0) - 64) & 31) << 10) | (((t.charCodeAt(1) - 64) & 31) << 5) | ((t.charCodeAt(2) - 64) & 31);
}

const DEVICE_TYPES = new Map<number, string>([
	[0x00, 'other'],
	[0x01, 'oil'],
	[0x02, 'electricity'],
	[0x03, 'gas'],
	[0x04, 'heat (outlet)'],
	[0x05, 'steam'],
	[0x06, 'warm water'],
	[0x07, 'water'],
	[0x08, 'heat cost allocator'],
	[0x09, 'compressed air'],
	[0x0a, 'cooling (outlet)'],
	[0x0b, 'cooling (inlet)'],
	[0x0c, 'heat (inlet)'],
	[0x0d, 'heat / cooling'],
	[0x0e, 'bus / system'],
	[0x0f, 'unknown'],
	[0x15, 'hot water'],
	[0x16, 'cold water'],
	[0x17, 'dual water'],
	[0x18, 'pressure'],
	[0x19, 'A/D converter'],
	[0x1a, 'smoke detector'],
	[0x1b, 'room sensor'],
	[0x1c, 'gas detector'],
	[0x20, 'breaker (electricity)'],
	[0x21, 'valve (gas or water)'],
	[0x25, 'customer unit'],
	[0x28, 'waste water'],
	[0x29, 'garbage'],
	[0x2a, 'carbon dioxide'],
	[0x31, 'communication controller'],
	[0x32, 'unidirectional repeater'],
	[0x33, 'bidirectional repeater'],
	[0x36, 'radio converter (system)'],
	[0x37, 'radio converter (meter)'],
]);
export const deviceTypeName = (type: number): string => DEVICE_TYPES.get(type) ?? 'reserved';

/** Little-endian BCD to 8 digits. */
export function bcdId(b: Uint8Array, at: number): string {
	let s = '';
	for (let i = 0; i < 4; i++) {
		const byte = b[at + 3 - i];
		s += String((byte >> 4) % 10) + String((byte & 15) % 10);
	}
	return s;
}

const C_NAMES = new Map<number, string>([
	[0x44, 'SND-NR (send, no reply)'],
	[0x46, 'SND-IR (installation)'],
	[0x47, 'ACC-NR (access)'],
	[0x48, 'ACC-DMD (demand)'],
	[0x08, 'RSP-UD (response)'],
	[0x40, 'SND-NKE'],
	[0x43, 'SND-UD (send user data)'],
	[0x53, 'SND-UD (send user data)'],
	[0x73, 'SND-UD (send user data)'],
	[0x5a, 'REQ-UD1'],
	[0x7a, 'REQ-UD1'],
	[0x5b, 'REQ-UD2'],
	[0x7b, 'REQ-UD2'],
]);
export const cName = (c: number): string => C_NAMES.get(c) ?? 'other';

const CI_NAMES = new Map<number, string>([
	[0x72, 'long header, variable data'],
	[0x7a, 'short header, variable data'],
	[0x78, 'variable data, no header'],
	[0x7b, 'compact data, short header'],
	[0x79, 'compact data, no header'],
	[0x8c, 'extended link layer (short)'],
	[0x8d, 'extended link layer (with payload CRC)'],
	[0x51, 'data send'],
	[0x52, 'selection of slaves'],
	[0x70, 'application error'],
	[0x71, 'alarm'],
	[0x69, 'reduced format'],
	[0x6a, 'reduced format'],
	[0x6b, 'reduced format'],
	[0x90, 'authentication / fragmentation'],
]);
export const ciName = (ci: number): string => CI_NAMES.get(ci) ?? (ci >= 0xa0 && ci <= 0xb7 ? 'manufacturer specific' : 'other');

/** Security modes of the configuration word (EN 13757-7 / OMS) that have a short name. */
const SECURITY_MODES = new Map<number, string>([
	[5, 'mode 5 (AES-128-CBC)'],
	[7, 'mode 7 (AES-128-CBC, ephemeral key)'],
]);

function emptyFrame(formatB: boolean): WmbusFrame {
	return {
		ok: false,
		crcOk: false,
		formatB,
		L: 0,
		C: 0,
		ci: 0,
		version: 0,
		type: 0,
		mfrCode: 0,
		mfr: '',
		id: '',
		typeName: '',
		cName: '',
		ciName: '',
		shortHeader: false,
		longHeader: false,
		acc: 0,
		status: 0,
		config: 0,
		encrypted: false,
		encryption: '',
		statusText: '',
		data: new Uint8Array(0),
		payload: new Uint8Array(0),
		records: [],
		hasManufacturerData: false,
		error: '',
	};
}

/** Checks the block CRCs and keeps the data without them; false for a length that format B cannot have. */
function checkBlocks(b: Uint8Array, f: WmbusFrame): boolean {
	const N = f.L + 1;
	const data = new Uint8Array(N);
	let pos = 0;
	let size = 0;
	let ok = true;
	const block = (length: number) => {
		const crc = crc16(b, pos, pos + length);
		if (crc !== ((b[pos + length] << 8) | b[pos + length + 1])) ok = false;
		data.set(b.subarray(pos, pos + length), size);
		size += length;
		pos += length + 2;
	};
	if (!f.formatB) {
		let left = N;
		let length = Math.min(10, left);
		block(length);
		left -= length;
		while (left) {
			length = Math.min(16, left);
			block(length);
			left -= length;
		}
	} else {
		if (N < 3 || (N > 128 && N < 131)) return false;
		if (N <= 128) block(N - 2);
		else {
			block(126);
			block(N - 128 - 2);
		}
	}
	f.crcOk = ok;
	f.data = data.subarray(0, size);
	return true;
}

/** The transport header of CI 0x7A / 0x72 / 0x7B: access number, status, configuration word (encryption mode). */
function transportHeader(f: WmbusFrame, ci: number, at: number): number {
	let p = at;
	if (ci === 0x72) {
		f.longHeader = true;
		p += 8;
	} else f.shortHeader = true;
	f.acc = f.data[p];
	f.status = f.data[p + 1];
	f.config = f.data[p + 2] | (f.data[p + 3] << 8);
	p += 4;
	const st = f.status & 3;
	f.statusText = st === 0 ? 'ok' : st === 1 ? 'busy' : st === 2 ? 'application error' : 'alarm';
	if (f.status & 4) f.statusText += ', low power';
	if (f.status & 8) f.statusText += ', permanent error';
	if (f.status & 16) f.statusText += ', temporary error';
	const mode = (f.config >> 8) & 0x1f;
	if (mode !== 0) {
		f.encrypted = true;
		f.encryption = SECURITY_MODES.get(mode) ?? `mode ${mode}`;
	}
	return p;
}

/** Everything after the CI field: extended link layer, transport header, payload and its records. */
function applicationLayer(f: WmbusFrame): void {
	let p = 11;
	let ci = f.ci;
	const sz = f.data.length;
	if (ci === 0x8c) {
		if (p + 3 > sz) return;
		p += 2;
		ci = f.data[p++];
	} else if (ci === 0x8d) {
		if (p + 9 > sz) return;
		// the session number is 4 bytes little-endian after CC and ACC; ENC is its bits 29-31
		const enc = (f.data[p + 5] >> 5) & 7;
		if (enc) {
			f.encrypted = true;
			f.encryption = enc === 1 ? 'ELL AES-128-CTR' : `ELL mode ${enc}`;
			f.payload = f.data.slice(p);
			return;
		}
		p += 8;
		ci = f.data[p++];
	}
	if (ci === 0x7a || ci === 0x72 || ci === 0x7b) {
		const headerLength = ci === 0x72 ? 12 : 4;
		if (p + headerLength > sz) return;
		p = transportHeader(f, ci, p);
	}
	f.payload = f.data.slice(p);
	if (!f.encrypted && (ci === 0x7a || ci === 0x72 || ci === 0x78)) {
		const parsed = parseRecords(f.payload);
		f.records = parsed.records;
		f.hasManufacturerData = parsed.manufacturerData;
		if (!parsed.complete) f.error = 'record cut off';
	}
}

/**
 * Checks the CRCs and strips them; fills the link layer fields and, for an unencrypted payload, the records.
 * `n` is what was received (at least airLength). `ok` is false for a failed CRC or a frame too short for a link layer.
 */
export function parseFrame(b: Uint8Array, n: number, formatB: boolean): WmbusFrame {
	const f = emptyFrame(formatB);
	if (n < 3) {
		f.error = 'too short';
		return f;
	}
	f.L = b[0];
	if (n < airLength(f.L, formatB)) {
		f.error = 'incomplete';
		return f;
	}
	if (!checkBlocks(b, f)) {
		f.error = 'bad length';
		return f;
	}
	if (f.data.length < 11) {
		f.error = 'too short for a link layer';
		return f;
	}
	f.C = f.data[1];
	f.cName = cName(f.C);
	f.mfrCode = f.data[2] | (f.data[3] << 8);
	f.mfr = mfrCodeToString(f.mfrCode);
	f.id = bcdId(f.data, 4);
	f.version = f.data[8];
	f.type = f.data[9];
	f.typeName = deviceTypeName(f.type);
	f.ci = f.data[10];
	f.ciName = ciName(f.ci);
	applicationLayer(f);
	f.ok = f.crcOk;
	return f;
}
