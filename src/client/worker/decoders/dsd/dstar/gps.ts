// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir rust/onair_dstar/src/gps.rs (nmea_checksum, dprs_crc, field, coord,
// parse_nmea, parse_dprs, crc_with_cr), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: lines are strings; a parser returns the fix or null (OnAir's "partly filled" outcome is not needed); the C
// library's atof / atoi / strtoul / lround are written out for the number formats these lines carry.
//
// GPS text carried in the D-STAR slow data: NMEA sentences ($GPRMC / $GPGGA, also GN, GL ...; checksum checked) and
// D-PRS lines ($$CRCxxxx,CALL>DEST,...:!DDMM.mmN/DDDMM.mmE..., CRC-CCITT of the text after the comma).
import { dstarCrc } from './header';
import type { DstarFix } from './types';

const atof = (s: string): number => {
	const v = parseFloat(s);
	return Number.isFinite(v) ? v : 0;
};
const atoi = (s: string): number => {
	const v = parseInt(s, 10);
	return Number.isFinite(v) ? v : 0;
};
const lround = (x: number): number => Math.sign(x) * Math.round(Math.abs(x));
const codes = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0) & 0xff);

function emptyFix(aprs = false): DstarFix {
	return { lat: 0, lon: 0, altM: 0, speedKmh: 0, course: 0, altValid: false, velValid: false, call: '', comment: '', aprs };
}

/** The two hex digits of the XOR of body, for "$<body>*hh". */
export function nmeaChecksum(body: string): string {
	let x = 0;
	for (const c of codes(body)) x ^= c;
	return x.toString(16).toUpperCase().padStart(2, '0');
}

/** The CRC of a D-PRS line (the text after "$$CRCxxxx,"). */
export function dprsCrc(s: string): number {
	return dstarCrc(codes(s));
}

/** ddmm.mmmm (or dddmm.mmmm) and a hemisphere letter into degrees; NaN when not one. */
function coord(v: string, h: string, degDigits: number): number {
	if (v.length < degDigits + 2 || !h.length || !/^[0-9.]*$/.test(v)) return NaN;
	const min = atof(v.slice(degDigits));
	if (min >= 60) return NaN;
	const out = atof(v.slice(0, degDigits)) + min / 60;
	if (h[0] === 'S' || h[0] === 'W') return -out;
	return h[0] === 'N' || h[0] === 'E' ? out : NaN;
}

function nmeaRmc(p: (i: number) => string): DstarFix | null {
	const f = emptyFix();
	if (p(2) !== 'A') return null;
	f.lat = coord(p(3), p(4), 2);
	f.lon = coord(p(5), p(6), 3);
	if (Number.isNaN(f.lat) || Number.isNaN(f.lon)) return null;
	if (p(7)) {
		f.speedKmh = atof(p(7)) * 1.852;
		f.course = lround(atof(p(8)));
		f.velValid = true;
	}
	return f;
}

function nmeaGga(p: (i: number) => string): DstarFix | null {
	const f = emptyFix();
	if (!p(6) || p(6) === '0') return null;
	f.lat = coord(p(2), p(3), 2);
	f.lon = coord(p(4), p(5), 3);
	if (Number.isNaN(f.lat) || Number.isNaN(f.lon)) return null;
	if (p(9)) {
		f.altM = atof(p(9));
		f.altValid = true;
	}
	return f;
}

/** $GPRMC / $GPGGA (and the other talker ids): position, speed and course, or altitude. */
export function parseNmea(line: string): DstarFix | null {
	if (line.length < 10 || line[0] !== '$') return null;
	const star = line.indexOf('*');
	if (star < 0 || star + 3 > line.length) return null;
	const body = line.slice(1, star);
	if (nmeaChecksum(body) !== line.slice(star + 1, star + 3)) return null;
	const fields = body.split(',');
	if (fields[0].length !== 5) return null;
	const t = fields[0].slice(2);
	const p = (i: number) => fields[i] ?? '';
	if (t === 'RMC' && fields.length >= 9) return nmeaRmc(p);
	if (t === 'GGA' && fields.length >= 10) return nmeaGga(p);
	return null;
}

/** The CRC of s followed by a carriage return (the line may have lost it). */
function crcWithCr(s: string): number {
	return dstarCrc([...codes(s), 13]);
}

/** Course / speed and "/A=" altitude out of a D-PRS comment. */
function dprsComment(f: DstarFix, c: string): void {
	if (c.length >= 7 && c[3] === '/' && /[0-9]/.test(c[0]) && /[0-9]/.test(c[4])) {
		f.course = atoi(c.slice(0, 3));
		f.speedKmh = atoi(c.slice(4, 7)) * 1.852;
		f.velValid = true;
		c = c.slice(7);
	}
	const a = c.indexOf('/A=');
	if (a >= 0 && a + 9 <= c.length) {
		f.altM = atof(c.slice(a + 3, a + 9)) * 0.3048;
		f.altValid = true;
		c = c.slice(0, a) + c.slice(a + 9);
	}
	f.comment = c.replace(/[\r\n ]+$/, '');
}

/** A D-PRS line (CRC checked; the CRC may include a closing carriage return that the line lost). */
export function parseDprs(line: string): DstarFix | null {
	if (line.length < 11 || !line.startsWith('$$CRC') || line[9] !== ',') return null;
	const rest = line.slice(10);
	const hex = /^[0-9A-Fa-f]*/.exec(line.slice(5, 9))?.[0] ?? '';
	const want = hex ? parseInt(hex, 16) : 0;
	if (dprsCrc(rest) !== want && crcWithCr(rest) !== want) return null;
	const gt = rest.indexOf('>');
	const colon = rest.indexOf(':');
	if (gt < 0 || colon < 0 || colon + 20 > rest.length) return null;
	const f = emptyFix(true);
	f.call = rest.slice(0, gt);
	const pos0 = rest.slice(colon + 1);
	if (!'!=/@'.includes(pos0[0])) return null;
	const pos = pos0.slice(pos0[0] === '/' || pos0[0] === '@' ? 8 : 1); // a time stamp first with / and @
	if (pos.length < 19) return null;
	f.lat = coord(pos.slice(0, 7), pos.slice(7, 8), 2);
	f.lon = coord(pos.slice(9, 17), pos.slice(17, 18), 3);
	if (Number.isNaN(f.lat) || Number.isNaN(f.lon)) return null;
	dprsComment(f, pos.length > 19 ? pos.slice(19) : '');
	return f;
}
