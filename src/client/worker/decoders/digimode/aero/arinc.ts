// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/aero/aero_adsc.cpp (aeroArincCrc, the search for the ground
// address and IMI) and core/src/aero/aero_cpdlc.cpp (aeroDecodeCpdlc, aeroDescribeCpdlc), https://github.com/adswill/OnAir;
// see third_party/onair. Changes: the FANS-1/A CPDLC body is not decoded here: OnAir hands it to the asn1c unaligned PER
// tables of libacars (Tomasz Lemiech, MIT), which are not ported; the envelope (application, ground facility, aircraft,
// CRC) is read, and a body whose CRC is good goes with the record to the app, which decodes it with the ACARS library
// it already loads (cpdlcApplication).
//
// ARINC 622 ATS applications inside ACARS text, as libacars reads them (arinc.c): [/]GGGGGGG.IMI.RRRRRRR HEX... CCCC,
// a ground address of 7 (or 4) characters, the IMI, the aircraft address as 7 characters, the binary part as hex and the
// CRC-16 (polynomial 0x1021, start 0xFFFF; the register over everything including the CRC ends at 0x1D0F).

import type { DigimodeCpdlcApplication } from '@/worker/decoders/digimode/types';
import type { AeroCpdlcMessage } from './types';

export const ARINC_CRC_GOOD = 0x1d0f;

/** CRC-16/CCITT-FALSE register after the bytes (without the final inversion). */
export function aeroArincCrc(p: ArrayLike<number>, init = 0xffff): number {
	let crc = init;
	for (let i = 0; i < p.length; i++) {
		crc ^= p[i] << 8;
		for (let k = 0; k < 8; k++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
	}
	return crc;
}

export const upperOrDigit = (s: string, at: number, n: number): boolean =>
	at >= 0 && at + n <= s.length && /^[A-Z0-9]*$/.test(s.slice(at, at + n));

const hexVal = (c: string | undefined): number => (c && /^[0-9A-Fa-f]$/.test(c) ? parseInt(c, 16) : -1);

/** The bytes of the hex digits from `at` on, up to the first character that is not a pair of them. */
export function hexBytes(text: string, at: number): number[] {
	const out: number[] = [];
	for (let k = at; k + 1 < text.length; k += 2) {
		const h = hexVal(text[k]),
			l = hexVal(text[k + 1]);
		if (h < 0 || l < 0) break;
		out.push(h * 16 + l);
	}
	return out;
}

const charCodes = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
export const toHex = (b: ArrayLike<number>): string => Array.from(b, (v) => v.toString(16).toUpperCase().padStart(2, '0')).join('');

/** The earliest FANS-1/A CPDLC IMI (AT1, CR1, CC1, DR1) with its ground address in front. */
function findCpdlc(text: string): [at: number, groundLen: number] | null {
	let at = -1;
	for (const imi of ['.AT1', '.CR1', '.CC1', '.DR1']) {
		const f = text.indexOf(imi);
		if (f >= 0 && (at < 0 || f < at)) at = f;
	}
	if (at < 0) return null;
	// the 7 (or 4) upper-case / digit characters before the IMI; whatever precedes them (a "- #MD/AA " prefix, a "/") is skipped
	const gl = upperOrDigit(text, at - 7, 7) ? 7 : upperOrDigit(text, at - 4, 4) ? 4 : 0;
	if (!gl || (gl === 7 && upperOrDigit(text, at - 8, 1))) return null; // an 8th address character: not a ground address
	return [at, gl];
}

/** A FANS-1/A CPDLC application in an ACARS text, null when there is none. */
export function aeroDecodeCpdlc(text: string): AeroCpdlcMessage | null {
	const found = findCpdlc(text);
	if (!found) return null;
	const [at, gl] = found;
	const payload = text.slice(at + 1); // IMI, registration, hex body with the CRC
	if (payload.length < 3 + 7 + 4) return null;
	const reg = payload
		.slice(3, 10)
		.replace(/[ .]+$/, '')
		.replace(/^\.+/, '');
	const body = hexBytes(payload, 10);
	const m: AeroCpdlcMessage = { imi: payload.slice(0, 3), groundAddr: text.slice(at - gl, at), reg, crcOk: false, bodyHex: '' };
	if (body.length < 2) return m;
	m.crcOk = aeroArincCrc([...charCodes(payload.slice(0, 10)), ...body]) === ARINC_CRC_GOOD;
	m.bodyHex = toHex(body.slice(0, -2));
	return m;
}

/** The CPDLC body of an ACARS text for the app to decode, when there is one and its CRC is good. */
export function cpdlcApplication(text: string, uplink: boolean): DigimodeCpdlcApplication | undefined {
	const m = aeroDecodeCpdlc(text);
	return m?.crcOk && m.bodyHex ? { kind: 'cpdlc', uplink, hex: m.bodyHex } : undefined;
}

const CPDLC_KINDS: Record<string, string> = { AT1: 'message', CR1: 'connect request', CC1: 'connect confirm', DR1: 'disconnect request' };

/** Lines for the record: what the application is, and its body. */
export function aeroDescribeCpdlc(m: AeroCpdlcMessage): string {
	const crc = m.crcOk ? '' : ', CRC FAILED';
	const head = `FANS-1/A CPDLC ${CPDLC_KINDS[m.imi]} (${m.imi}), ground facility ${m.groundAddr}, aircraft ${m.reg}${crc}`;
	if (!m.bodyHex) return `${head}\n(no message body)`;
	return `${head}\nASN.1 PER body, ${m.bodyHex.length / 2} bytes: ${m.bodyHex}`;
}
