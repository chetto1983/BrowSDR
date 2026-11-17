// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/inmc/inmc_egc.cpp and core/include/dect2/inmc/inmc_egc.h,
// https://github.com/adswill/OnAir; see third_party/onair. Changes: the keyword tests of the subject are a table.
//
// What a SafetyNET / FleetNET message is about, read from its service code, its priority and its text: the NAVAREA or
// METAREA, the kind (navigational warning, weather forecast, distress relay, search and rescue, ...) and the warning
// number ("123/26"). The packet's own address bytes are NOT decoded (their layout is not in a public specification);
// mariners read the area from the text, where every NAVAREA / METAREA message names it, and so does this. Facts used:
// the 21 NAVAREAs / METAREAs of the IMO / IHO World-Wide Navigational Warning Service, the SafetyNET service and priority
// codes of IMO's SafetyNET Manual.

import type { InmcEgcInfo } from './types';

const ROMAN = [
	'',
	'I',
	'II',
	'III',
	'IV',
	'V',
	'VI',
	'VII',
	'VIII',
	'IX',
	'X',
	'XI',
	'XII',
	'XIII',
	'XIV',
	'XV',
	'XVI',
	'XVII',
	'XVIII',
	'XIX',
	'XX',
	'XXI',
];

export const romanNumeral = (n: number): string => (n >= 1 && n <= 21 ? ROMAN[n] : '');

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';
const isAlnum = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9]/.test(c);

/** A Roman numeral I..XXI (also 1..21 as digits) to its number, 0 when it is neither. */
export function areaNumberFromText(text: string): number {
	const s = text.toUpperCase();
	if (!s || s.length > 5) return 0;
	if (isDigit(s[0])) {
		if (!/^\d+$/.test(s)) return 0;
		const v = Number(s);
		return v >= 1 && v <= 21 ? v : 0;
	}
	const n = ROMAN.indexOf(s, 1);
	return n > 0 ? n : 0;
}

/** The letters at [i, i + n) form a whole word. */
const wordAt = (u: string, i: number, n: number): boolean => (i === 0 || !isAlnum(u[i - 1])) && (i + n >= u.length || !isAlnum(u[i + n]));

/** The first "NAVAREA x" / "METAREA x" (x a Roman numeral or a number); a message that names both keeps the first. */
function findArea(u: string): [string, number] {
	for (let i = 0; i + 7 <= u.length; i++) {
		const word = u.slice(i, i + 7);
		const nav = word === 'NAVAREA';
		if ((!nav && word !== 'METAREA') || !wordAt(u, i, 7)) continue;
		let j = i + 7;
		while (j < u.length && (u[j] === ' ' || u[j] === '\n' || u[j] === '\t')) j++;
		let e = j;
		while (e < u.length && isAlnum(u[e])) e++;
		const n = areaNumberFromText(u.slice(j, e));
		if (n) return [`${nav ? 'NAVAREA' : 'METAREA'} ${nav ? romanNumeral(n) : n}`, n];
	}
	return ['', 0];
}

/** The warning number "123/26" in the first 200 characters (NAVAREA IV 123/26, HYDROLANT 1234/26). */
function findIdent(u: string): string {
	const lim = Math.min(u.length, 200);
	for (let i = 0; i < lim; i++) {
		if (!isDigit(u[i]) || (i && isDigit(u[i - 1]))) continue;
		let e = i;
		while (e < lim && isDigit(u[e])) e++;
		if (e - i > 4 || e + 2 >= u.length || u[e] !== '/') continue;
		if (isDigit(u[e + 1]) && isDigit(u[e + 2]) && !(e + 3 < u.length && isDigit(u[e + 3]))) return u.slice(i, e + 3);
	}
	return '';
}

/** Kinds read from the words of the text, in order. */
const WORD_KINDS: Array<[string, string[], number[]]> = [
	['Search and rescue', ['SEARCH AND RESCUE', ' SAR ', 'SAR OPERATION'], [0x34, 0x44]],
	['Weather forecast', ['FORECAST', 'WEATHER BULLETIN', 'SYNOPSIS', 'OUTLOOK'], []],
	['Weather warning', ['GALE', 'STORM', 'CYCLONE', 'HURRICANE', 'TYPHOON', 'SEVERE WEATHER'], []],
	['Security / piracy', ['PIRAT', 'ARMED ROBBERY', 'SECURITY'], []],
	['Ice report', ['ICE ', 'ICEBERG', 'SEA ICE'], []],
];
/** Kinds from the service code alone, after the words. */
const SERVICE_KINDS: Record<number, string> = {
	0x13: 'Coastal warning',
	0x72: 'Chart correction',
	0x73: 'Chart correction',
	0x02: 'FleetNET message',
};
const NAV_WORDS = ['NAVAREA', 'HYDROLANT', 'HYDROPAC', 'HYDROARC', 'NAV WARN'];

function subjectOf(service: number, priority: number, u: string): string {
	const has = (w: string) => u.includes(w);
	if ([0x00, 0x11, 0x23, 0x33].includes(service)) return ''; // system messages
	const relay = priority >= 3 || has('MAYDAY') || (has('DISTRESS') && !has('DISTRESS CALL')) || service === 0x14;
	if (relay) return 'Distress relay';
	for (const [kind, words, services] of WORD_KINDS) if (services.includes(service) || words.some(has)) return kind;
	if (SERVICE_KINDS[service]) return SERVICE_KINDS[service];
	if (service === 0x31 || service === 0x04 || service === 0x24 || NAV_WORDS.some(has)) return 'Navigational warning';
	return '';
}

/** service: the EGC service code of the packet, priority 0..3 (3 = distress), text: the assembled text. */
export function classifyEgc(service: number, priority: number, text: string): InmcEgcInfo {
	const u = text.toUpperCase();
	const [area, areaNumber] = findArea(u);
	return { area, areaNumber, subject: subjectOf(service, priority, u), ident: findIdent(u) };
}
