// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/aero/aero_su.cpp (SU type names, aeroSplitSus, aeroParseSystemSu,
// aeroDescribeSu) and core/include/dect2/aero/aero_su.h, https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the type names are a table; the builders of the test signal are in the tests.
//
// Inmarsat Aero signal units: 12 bytes, 10 of message and the CRC-16 (low byte first). Facts from JAERO (Jonti Olds, MIT,
// aerol.cpp and aerol.h): the SU type octets, the system table field positions; interleaver block sizes (aerol.cpp
// setSettings: 600 6 x 64, 1200 9 x 64, 10500 78 x 64 channel bits, rate 1/2 coding).

import { aeroSuCrcOk } from './phy';
import type { AeroSu, AeroSysInfo } from './types';

export const SU_FILL = 0x01;
export const SU_GES_CHANNELS = 0x05;
export const SU_SATELLITE = 0x0c;
export const SU_LOGON_CONFIRM = 0x11;
export const SU_LOGOFF_REQUEST = 0x12;
export const SU_PR_CONTROL = 0x40;
export const SU_USER_ISU = 0x71;

/** P channel SU type octets (aerol.h AEROTypeP). */
const TYPE_NAMES: Record<number, string> = {
	0x00: 'Reserved 0',
	0x01: 'Fill-in',
	0x05: 'System table: GES channels',
	0x07: 'System table: GES beam support',
	0x0a: 'System table: index',
	0x0c: 'System table: satellite',
	0x10: 'Log-on request',
	0x11: 'Log-on confirm',
	0x12: 'Log-off request',
	0x13: 'Log-on reject',
	0x14: 'Log-on interrogation',
	0x15: 'Log-on/off acknowledge',
	0x16: 'Log-on prompt',
	0x17: 'Data channel reassignment',
	0x18: 'Reserved',
	0x19: 'Reserved',
	0x26: 'Reserved',
	0x21: 'Call announcement',
	0x28: 'EIRP table',
	0x30: 'Call progress',
	0x31: 'C channel assignment (distress)',
	0x32: 'C channel assignment (flight safety)',
	0x33: 'C channel assignment (other safety)',
	0x34: 'C channel assignment (non-safety)',
	0x40: 'P/R channel control',
	0x41: 'T channel control',
	0x51: 'T channel assignment',
	0x61: 'Request for acknowledgement',
	0x62: 'Acknowledgement',
	0x71: 'User data ISU',
	0x74: 'User data 3-octet LSDU',
	0x76: 'User data 4-octet LSDU',
};
export const suTypeName = (t: number): string => TYPE_NAMES[t] ?? ((t & 0xc0) === 0xc0 ? 'User data SSU' : 'Unknown');

/** Types whose octets 1..3 are the AES id and octet 4 the GES id (JAERO: SendLogOnOff, CreateCAssignmentItem, ISUData). */
const AES_GES = new Set([0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x21, 0x30, 0x31, 0x32, 0x33, 0x34, 0x71]);

const chanToMHz = (ch: number): number => ch * 0.0025 + 1510;

/** Information bytes per interleaver block at 600 / 1200 / 10500 bit/s (2, 3 and 26 SUs); 0 for an unknown rate. */
export const aeroBlockBytes = (bitRate: number): number => ({ 600: 24, 1200: 36, 10500: 312 })[bitRate] ?? 0;
export const aeroSusPerBlock = (bitRate: number): number => aeroBlockBytes(bitRate) / 12;

/** An SU from its 12 bytes, with its check and the ids it carries. */
export function aeroSu(bytes: Uint8Array): AeroSu {
	const crcOk = aeroSuCrcOk(bytes);
	const type = bytes[0];
	let aesId = 0,
		gesId = -1;
	if (AES_GES.has(type)) {
		aesId = (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
		gesId = bytes[4];
	} else if (type === SU_GES_CHANNELS) gesId = bytes[3];
	else if (type === SU_PR_CONTROL) gesId = bytes[4];
	return { type, typeName: crcOk ? suTypeName(type) : 'Bad CRC', bytes, crcOk, aesId, gesId };
}

/** The SUs of one interleaver block. */
export function aeroSplitSus(block: Uint8Array, bitRate: number): AeroSu[] {
	const per = aeroBlockBytes(bitRate);
	if (!per) return [];
	const n = Math.floor(Math.min(block.length, per) / 12);
	return Array.from({ length: n }, (_, k) => aeroSu(block.slice(k * 12, k * 12 + 12)));
}

/** System table bit rate codes (JAERO). */
const RATE_CODES: Record<number, number> = { 0: 600, 1: 1200, 2: 2400, 3: 4800, 4: 6000, 5: 5250, 6: 10500, 7: 8400, 9: 21000 };
export const bitRateOfCode = (c: number): number => RATE_CODES[c] ?? 0;
export const codeOfBitRate = (r: number): number => {
	const hit = Object.entries(RATE_CODES).find(([, v]) => v === r);
	return hit ? Number(hit[0]) : 15;
};

function gesChannels(b: Uint8Array, r: AeroSysInfo): void {
	r.kind = 1;
	r.gesId = b[3];
	r.seq = (b[2] >> 2) & 0x3f;
	r.lsu = b[2] & 3;
	for (let i = 0; i < 3; i++) r.freqMHz[i] = chanToMHz((b[4 + 2 * i] << 8) | b[5 + 2 * i]);
	if (r.lsu <= 1) {
		r.freqMHz[1] += 101.5;
		r.freqMHz[2] += 101.5;
		r.names = 'Psmc Rsmc0 Rsmc1';
	} else {
		for (let i = 0; i < 3; i++) r.freqMHz[i] += 101.5;
		r.names = r.lsu === 2 ? 'Rsmc2 Rsmc3 Rsmc4' : 'Rsmc5 Rsmc6 Rsmc7';
	}
}

/** JAERO's reading of the P channel system table SUs; kind 0 for any other SU. */
export function aeroParseSystemSu(su: AeroSu): AeroSysInfo {
	const r: AeroSysInfo = {
		kind: 0,
		gesId: -1,
		seq: 0,
		lsu: 0,
		satId: -1,
		lonDeg: 0,
		bitRate: 0,
		freqMHz: [0, 0, 0],
		spotBeam: false,
		names: '',
	};
	if (!su.crcOk) return r;
	const b = su.bytes;
	if (su.type === SU_GES_CHANNELS) gesChannels(b, r);
	else if (su.type === SU_SATELLITE) {
		r.kind = 2;
		r.seq = (b[2] >> 2) & 0x3f;
		r.satId = ((b[2] << 4) & 0x30) | ((b[3] >> 4) & 0x0f);
		const lon = b[5] * 1.5;
		r.lonDeg = lon > 180 ? lon - 360 : lon;
		r.freqMHz[0] = chanToMHz(((b[6] & 0x7f) << 8) | b[7]);
		const ch2 = ((b[8] & 0x7f) << 8) | b[9];
		r.freqMHz[1] = ch2 ? chanToMHz(ch2) : 0;
		r.spotBeam = (b[6] & 0x80) !== 0;
	} else if (su.type === SU_PR_CONTROL) {
		r.kind = 3;
		r.gesId = b[4];
		r.bitRate = bitRateOfCode((b[7] >> 4) & 0x0f);
		r.freqMHz[0] = chanToMHz(((b[8] & 0x7f) << 8) | b[9]);
		r.spotBeam = (b[8] & 0x80) !== 0;
	}
	return r;
}

const hex = (v: number, n: number): string => v.toString(16).toUpperCase().padStart(n, '0');
export const lonText = (lon: number): string => `${Math.abs(lon).toFixed(1)}°${lon < 0 ? 'W' : 'E'}`;

/** One line: the type name plus the decoded fields of the SU types known. */
export function aeroDescribeSu(su: AeroSu): string {
	if (!su.crcOk) return su.typeName;
	let s = su.typeName;
	if (su.aesId || su.type === SU_USER_ISU || su.type === SU_LOGON_CONFIRM)
		s += `: AES ${hex(su.aesId, 6)} GES ${hex(Math.max(su.gesId, 0), 2)}`;
	const i = aeroParseSystemSu(su);
	const f = (mhz: number) => mhz.toFixed(4);
	if (i.kind === 1) {
		const [a, b, c] = i.names.split(' ');
		s += `: GES ${hex(i.gesId, 2)} ${a} ${f(i.freqMHz[0])}, ${b} ${f(i.freqMHz[1])}, ${c} ${f(i.freqMHz[2])} MHz`;
	} else if (i.kind === 2) {
		s += `: satellite ${i.satId} at ${lonText(i.lonDeg)}, P channel ${f(i.freqMHz[0])} MHz${i.spotBeam ? ' (spot beam)' : ''}`;
		if (i.freqMHz[1] > 0) s += `, ${f(i.freqMHz[1])} MHz`;
	} else if (i.kind === 3)
		s += `: GES ${hex(i.gesId, 2)} P channel ${f(i.freqMHz[0])} MHz at ${i.bitRate} bit/s${i.spotBeam ? ' (spot beam)' : ''}`;
	return s;
}
