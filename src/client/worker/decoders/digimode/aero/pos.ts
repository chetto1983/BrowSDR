// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/aero/aero_pos.cpp and core/include/dect2/aero/aero_pos.h,
// https://github.com/adswill/OnAir; see third_party/onair. Changes: OnAir's general ACARS text interpreter
// (acarsInterpret, core/src/acars/acars_text.cpp), its last resort for a position, is not ported (as in the VDL2 mode);
// an ADS-C emergency report is marked.
//
// Aircraft positions from Aero ACARS messages: ADS-C reports (adsc.ts) and the plain-text position reports whose layout
// is published (each from airframesio/acars-decoder-typescript, lib/plugins, with the example messages of its tests):
//   any label, ARINC 702 style "POS" report: "POSN43312W123174,EASON,215754,370,..." and the same position after "/PS" in
//     slash-field reports; latitude N/S + 5 digits as degrees and minutes with tenths (DDMMm), longitude E/W + 6 digits
//     (DDDMMm); then a waypoint (may be left out or empty), the time HHMMSS and the flight level (3 digits, x 100 ft);
//   label 20 "POSN38160W077075,...": the same field shape but thousandths of a degree;
//   label 16 "N 44.203,W 86.546,31965,6, 290" and "N 28.177/W 96.055": decimal degrees, altitude in feet.

import { aeroAdscTagName, aeroDecodeAdsc } from './adsc';
import type { AeroAdscMessage, AeroPosition } from './types';

const digits = (s: string, a: number, n: number): boolean => a + n <= s.length && /^\d+$/.test(s.slice(a, a + n));
const num = (s: string, a: number, n: number): number => Number(s.slice(a, a + n));

function blank(kind: string, source: number): AeroPosition {
	return {
		source,
		kind,
		lat: 0,
		lon: 0,
		altFt: null,
		trackDeg: null,
		speedKt: null,
		secPastHour: -1,
		secOfDay: -1,
		flightId: '',
		icao: 0,
		emergency: false,
	};
}

/**
 * A position as reported may be out of range or wrapped: latitude beyond +-90 or not a number is refused (null),
 * longitude is brought into -180 .. 180, and exactly 0, 0 (a receiver with no fix) is refused.
 */
export function aeroSanitizePosition(lat: number, lon: number): [number, number] | null {
	if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 360) return null;
	const l = lon > 180 ? lon - 360 : lon < -180 ? lon + 360 : lon;
	return lat === 0 && l === 0 ? null : [lat, l];
}

/** [NS]ddddd[ ][EW]dddddd at p; minutes: DDMMm (else thousandths of a degree). The end and the position, or null. */
function coords(s: string, p: number, minutes: boolean): [end: number, lat: number, lon: number] | null {
	if ((s[p] !== 'N' && s[p] !== 'S') || !digits(s, p + 1, 5)) return null;
	let q = p + 6;
	if (s[q] === ' ') q++;
	if ((s[q] !== 'E' && s[q] !== 'W') || !digits(s, q + 1, 6)) return null;
	const a = num(s, p + 1, 5),
		b = num(s, q + 1, 6);
	let lat = a / 1000,
		lon = b / 1000;
	if (minutes) {
		if (a % 1000 >= 600 || b % 1000 >= 600) return null;
		lat = Math.floor(a / 1000) + (a % 1000) / 600;
		lon = Math.floor(b / 1000) + (b % 1000) / 600;
	}
	if (lat > 90 || lon > 180) return null;
	return [q + 7, s[p] === 'S' ? -lat : lat, s[q] === 'W' ? -lon : lon];
}

const isTime = (t: string): boolean => t.length === 6 && digits(t, 0, 6) && num(t, 0, 2) < 24 && num(t, 2, 2) < 60 && num(t, 4, 2) < 60;

/** ",[waypoint,]HHMMSS,FL" after the position. */
function timeAndLevel(s: string, e: number, out: AeroPosition): void {
	const f: string[] = [];
	for (let i = e; i < s.length && s[i] === ',' && f.length < 4;) {
		let j = i + 1;
		while (j < s.length && !',/\r\n'.includes(s[j])) j++;
		f.push(s.slice(i + 1, j));
		i = j;
	}
	const k = f.length && !isTime(f[0]) ? 1 : 0; // the waypoint (or an empty field) comes first
	if (k >= f.length || !isTime(f[k])) return;
	out.secOfDay = num(f[k], 0, 2) * 3600 + num(f[k], 2, 2) * 60 + num(f[k], 4, 2);
	const fl = f[k + 1];
	if (fl && fl.length <= 3 && digits(fl, 0, fl.length)) out.altFt = num(fl, 0, fl.length) * 100;
}

function label16(s: string): AeroPosition | null {
	const m = /^([NS]) (\d+(?:\.\d*)?)[,/]([EW]) *(\d+(?:\.\d*)?)(,(\d+|GRD))?/.exec(s);
	if (!m) return null;
	const la = Number(m[2]),
		lo = Number(m[4]);
	if (la > 90 || lo > 180) return null;
	const out = blank('label 16 position', 2);
	out.lat = m[1] === 'S' ? -la : la;
	out.lon = m[3] === 'W' ? -lo : lo;
	if (m[6]) out.altFt = m[6] === 'GRD' ? 0 : Number(m[6]);
	return out;
}

/** Text reports only; null when the text has none of the formats above. */
export function aeroParseTextPosition(label: string, text: string): AeroPosition | null {
	if (label === '16' || label === '12') {
		const p = label16(text);
		if (p) return p;
	}
	for (const key of ['POS', '/PS'])
		for (let f = text.indexOf(key); f >= 0; f = text.indexOf(key, f + 1)) {
			const c = coords(text, f + 3, label !== '20');
			if (!c) continue;
			const out = blank(label === '20' ? 'label 20 POS report' : 'POS report', 2);
			[, out.lat, out.lon] = c;
			timeAndLevel(text, c[0], out);
			return out;
		}
	return null;
}

function fromAdsc(a: AeroAdscMessage): AeroPosition {
	const out = blank(`ADS-C ${aeroAdscTagName(a.posTag)}`, 1);
	out.lat = a.lat;
	out.lon = a.lon;
	out.altFt = a.altFt;
	out.secPastHour = a.timeSec;
	if (a.earth?.valid) out.trackDeg = a.earth.trackDeg;
	else if (a.air?.valid) out.trackDeg = a.air.headingDeg;
	if (a.earth) out.speedKt = a.earth.groundKt;
	out.flightId = a.flightId;
	out.icao = a.icao;
	out.emergency = a.posTag === 9;
	return out;
}

/** The ADS-C application of a message, if any, and the position it or a text report carries (checked and wrapped). */
export function aeroPositionFromMessage(
	label: string,
	text: string,
	uplink: boolean,
): { adsc: AeroAdscMessage | null; pos: AeroPosition | null } {
	const adsc = aeroDecodeAdsc(text, uplink);
	// a message with an ADS-C application has no text position: only a checked ADS-C report gives one
	const pos = adsc ? (adsc.crcOk && adsc.hasPos ? fromAdsc(adsc) : null) : aeroParseTextPosition(label, text);
	const ok = pos && aeroSanitizePosition(pos.lat, pos.lon);
	if (pos && ok) [pos.lat, pos.lon] = ok;
	return { adsc, pos: ok ? pos : null };
}
