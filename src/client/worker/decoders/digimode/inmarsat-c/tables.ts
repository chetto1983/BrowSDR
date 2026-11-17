// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/inmc/inmc_pkt.cpp (satName, lesName, serviceName, serviceKind,
// priorityName, addressLength, descriptorName, servicesText, frameTimeText, ita2ToText, textToIta2, decodeText),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: the switch tables are lookup tables; textToIta2 (for
// the test signal) is kept beside its decoder.
//
// OnAir's sources (facts only): packet descriptors, service and address codes, satellite and station tables from the open
// decoder "inmarsatc" (inmarsatc_parser.cpp), cross-checked against stdcdec (stdc_decode.c); the ITA2 tables as in the
// table of that decoder (from the baudot project).

import { FRAME_SECONDS } from './code';

const SATS: Record<number, string> = {
	0: 'Atlantic Ocean Region West (AOR-W)',
	1: 'Atlantic Ocean Region East (AOR-E)',
	2: 'Pacific Ocean Region (POR)',
	3: 'Indian Ocean Region (IOR)',
	9: 'All ocean regions of the station',
};
export const satName = (sat: number): string => SATS[sat] ?? 'Unknown';

/** Land earth stations by region * 100 + station (inmarsatc getLesName / stdcdec get_les_name). */
const LES: Array<[number[], string]> = [
	[[1, 101, 201, 301], 'Vizada-Telenor, USA'],
	[[2, 102, 302], 'Stratos Global (Burum-2), Netherlands'],
	[[202], 'Stratos Global (Auckland), New Zealand'],
	[[3, 103, 203, 303], 'KDDI, Japan'],
	[[4, 104, 204, 304], 'Vizada-Telenor, Norway'],
	[[44, 144, 244, 344], 'NCS'],
	[[105, 335], 'Telecom Italia'],
	[[305, 120], 'OTESTAT, Greece'],
	[[306], 'VSNL, India'],
	[[110, 310], 'Turk Telecom, Turkey'],
	[[211, 311], 'Beijing MCN, China'],
	[[12, 112, 212, 312], 'Stratos Global (Burum), Netherlands'],
	[[114], 'Embratel, Brazil'],
	[[116, 316], 'Telekomunikacja Polska, Poland'],
	[[117, 217, 317], 'Morsviazsputnik, Russia'],
	[[21, 121, 221, 321], 'Vizada (FT), France'],
	[[127, 327], 'Bezeq, Israel'],
	[[210, 328], 'Singapore Telecom, Singapore'],
	[[330], 'VISHIPEL, Vietnam'],
];
const LES_BY_CODE = new Map(LES.flatMap(([codes, name]) => codes.map((code): [number, string] => [code, name])));
/** "" when not in the table. */
export const lesName = (sat: number, les: number): string => LES_BY_CODE.get(les + sat * 100) ?? '';

const SERVICES: Record<number, string> = {
	0x00: 'System, all ships (general call)',
	0x02: 'FleetNET, group call',
	0x04: 'SafetyNET, warning to a rectangular area',
	0x11: 'System, Inmarsat system message',
	0x13: 'SafetyNET, coastal warning',
	0x14: 'SafetyNET, shore-to-ship distress alert to a circular area',
	0x23: 'System, EGC system message',
	0x24: 'SafetyNET, warning to a circular area',
	0x31: 'SafetyNET, NAVAREA/METAREA warning or forecast',
	0x33: 'System, download group identity',
	0x34: 'SafetyNET, SAR coordination to a rectangular area',
	0x44: 'SafetyNET, SAR coordination to a circular area',
	0x72: 'FleetNET, chart correction service',
	0x73: 'SafetyNET, chart correction service for fixed areas',
};
export const serviceName = (code: number): string => SERVICES[code] ?? 'Unknown service';

/** 0 other or system, 1 SafetyNET, 2 FleetNET. */
export function serviceKind(code: number): number {
	if ([0x04, 0x13, 0x14, 0x24, 0x31, 0x34, 0x44, 0x73].includes(code)) return 1;
	return code === 0x02 || code === 0x72 ? 2 : 0;
}

const PRIORITIES = ['Routine', 'Safety', 'Urgency', 'Distress'];
export const priorityName = (p: number): string => PRIORITIES[p & 3];

const ADDRESS_LENGTHS: Record<number, number> = {
	0x00: 3,
	0x11: 4,
	0x31: 4,
	0x02: 5,
	0x72: 5,
	0x13: 6,
	0x23: 6,
	0x33: 6,
	0x73: 6,
	0x04: 7,
	0x14: 7,
	0x24: 7,
	0x34: 7,
	0x44: 7,
};
/** Bytes of address after the EGC header, the first one included. */
export const addressLength = (code: number): number => ADDRESS_LENGTHS[code] ?? 3;

const DESCRIPTORS: Record<number, string> = {
	0x27: 'Logical channel clear',
	0x2a: 'Inbound message ack',
	0x08: 'Acknowledgement request',
	0x6c: 'Signalling channel',
	0x7d: 'Bulletin board',
	0x81: 'Announcement',
	0x83: 'Logical channel assignment',
	0x91: 'Distress alert ack',
	0x92: 'Login ack',
	0x9a: 'Enhanced data report ack',
	0xa0: 'Distress test request',
	0xa3: 'Individual poll',
	0xa8: 'Confirmation',
	0xaa: 'Message',
	0xab: 'LES list',
	0xac: 'Request status',
	0xad: 'Test result',
	0xb1: 'EGC double header 1',
	0xb2: 'EGC double header 2',
	0xbd: 'Multiframe packet',
	0xbe: 'Multiframe continuation',
};
export const descriptorName = (d: number): string => DESCRIPTORS[d] ?? 'Other';

const SERVICE_BITS = [
	'Distress alerting',
	'SafetyNET',
	'Inmarsat-C',
	'Store and forward',
	'Half duplex',
	'Full duplex',
	'Closed network',
	'FleetNET',
	'Prefix SF',
	'Land mobile alerting',
	'Aero-C',
	'ITA2',
	'Data',
	'Basic X.400',
	'Enhanced X.400',
	'Low power CMES',
];
/** The services bit mask of the bulletin board in words, most significant bit first. */
export const servicesText = (mask: number): string => SERVICE_BITS.filter((_, i) => mask & (0x8000 >>> i)).join(', ');

/** Frame number times 8.64 s as h:mm:ss.s. */
export function frameTimeText(frame: number): string {
	const s = frame * FRAME_SECONDS;
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	return `${h}:${String(m).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}

// ITA2 tables; 0x1F shifts to letters, 0x1B to figures ('' is a code with no character)
const LTRS = [
	'',
	'E',
	'\n',
	'A',
	' ',
	'S',
	'I',
	'U',
	'\r',
	'D',
	'R',
	'J',
	'N',
	'F',
	'C',
	'K',
	'T',
	'Z',
	'L',
	'W',
	'H',
	'Y',
	'P',
	'Q',
	'O',
	'B',
	'G',
	'',
	'M',
	'X',
	'V',
	'',
];
const FIGS = [
	'',
	'3',
	'\n',
	'-',
	' ',
	"'",
	'8',
	'7',
	'\r',
	'',
	'4',
	'',
	',',
	'!',
	':',
	'(',
	'5',
	'+',
	')',
	'2',
	'$',
	'6',
	'0',
	'1',
	'9',
	'?',
	'&',
	'',
	'.',
	'/',
	';',
	'',
];

export function ita2ToText(codes: ArrayLike<number>): string {
	let s = '';
	let fig = false;
	for (let i = 0; i < codes.length; i++) {
		const c = codes[i] & 31;
		if (c === 0x1f) fig = false;
		else if (c === 0x1b) fig = true;
		else {
			const ch = fig ? FIGS[c] : LTRS[c];
			if (ch && ch !== '\r') s += ch;
		}
	}
	return s;
}

/** Text to ITA2 codes with the shifts it needs (the test signal); characters ITA2 lacks are left out. */
export function textToIta2(text: string): number[] {
	const out: number[] = [];
	let fig = false,
		known = false;
	for (const raw of text.toUpperCase()) {
		let code = LTRS.indexOf(raw, 1);
		let f = false;
		if (code < 1) {
			code = FIGS.indexOf(raw, 1);
			f = true;
		}
		if (code < 1 || !raw) continue;
		const shared = raw === ' ' || raw === '\n' || raw === '\r';
		if (!shared && (!known || f !== fig)) {
			out.push(f ? 0x1b : 0x1f);
			fig = f;
			known = true;
		}
		out.push(code);
	}
	return out;
}

/** The text of an EGC message: 0 IA5 (7 bits, ETX ends it), 6 ITA2, 7 binary (not shown). */
export function decodeText(presentation: number, b: Uint8Array): string {
	if (presentation === 6) return ita2ToText(b);
	if (presentation === 7) return `[binary, ${b.length} bytes]`;
	let s = '';
	for (const byte of b) {
		const c = byte & 0x7f;
		if (c === 0x03) break; // end of text
		if (c === 0x0d) continue;
		if (c === 0x0a || c === 0x09 || c >= 0x20) s += String.fromCharCode(c);
	}
	return s;
}
