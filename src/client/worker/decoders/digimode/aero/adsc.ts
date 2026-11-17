// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/aero/aero_adsc.cpp (aeroParseAdscGroups, aeroDecodeAdsc,
// aeroDescribeAdsc, aeroParseAdscUplink, aeroAdscNackReason, AdscContractBook::describe) and
// core/include/dect2/aero/aero_adsc.h, https://github.com/adswill/OnAir; see third_party/onair. Changes: the optional
// groups of a report are null when absent; the contract book shared between OnAir's decoders and the builders of the
// test signal (in the tests) are left out.
//
// ADS-C (FANS-1/A, ARINC 745) inside ACARS text. The binary part is a list of groups, each a tag octet then a fixed number
// of octets (bit layouts and scales: libacars adsc.c, Tomasz Lemiech, MIT, checked by OnAir against the decoded examples
// in its PROG_GUIDE.md; no code taken from it). Lat / lon: 21 bits two's complement, LSB 90/2^19 degrees; altitude 16
// bits two's complement x 4 ft; time stamp 15 bits x 0.125 s past the hour.

import { ARINC_CRC_GOOD, aeroArincCrc, hexBytes, upperOrDigit } from './arinc';
import type { AeroAdscMessage, AeroAdscPoint, AeroAdscRequest, AeroFields } from './types';

/** Reads big-endian bit fields. */
class Bits {
	private pos = 0;
	constructor(
		private readonly p: ArrayLike<number>,
		private readonly from: number,
	) {}
	get(k: number): number {
		let v = 0;
		for (let i = 0; i < k; i++, this.pos++) v = v * 2 + ((this.p[this.from + (this.pos >> 3)] >> (7 - (this.pos & 7))) & 1);
		return v;
	}
}

const sext = (v: number, bits: number): number => (v >= 2 ** (bits - 1) ? v - 2 ** bits : v);
/** A field of `bits` bits, two's complement, most significant bit worth `msbDeg`: the LSB is msbDeg / 2^(bits - 2). */
const angle = (v: number, bits: number, msbDeg: number): number => (sext(v, bits) * msbDeg) / 2 ** (bits - 2);
const heading = (v: number): number => {
	const d = angle(v, 12, 90);
	return d < 0 ? d + 360 : d;
};

/** The fixed length of a downlink group after its tag; -1 unknown, -2 variable. */
const GROUP_LEN: Record<number, number> = {
	3: 1,
	4: -2,
	5: -2,
	6: 0,
	7: 10,
	9: 10,
	10: 10,
	18: 10,
	19: 10,
	20: 10,
	12: 6,
	13: 17,
	14: 5,
	15: 5,
	16: 4,
	17: 3,
	22: 8,
	23: 9,
};
const POSITION_TAGS = [7, 9, 10, 18, 19, 20];

const TAG_NAMES: Record<number, string> = {
	3: 'Acknowledgement',
	4: 'Negative acknowledgement',
	5: 'Noncompliance notification',
	6: 'Cancel emergency mode',
	7: 'Basic report',
	9: 'Emergency basic report',
	10: 'Lateral deviation change event',
	12: 'Flight ID',
	13: 'Predicted route',
	14: 'Earth reference',
	15: 'Air reference',
	16: 'Meteorological data',
	17: 'Airframe ID',
	18: 'Vertical rate change event',
	19: 'Altitude range event',
	20: 'Waypoint change event',
	22: 'Intermediate projection',
	23: 'Fixed projection',
};
/** Downlink group name, "" when not known. */
export const aeroAdscTagName = (tag: number): string => TAG_NAMES[tag] ?? '';

export function emptyAdsc(): AeroAdscMessage {
	return {
		found: false,
		disconnect: false,
		uplink: false,
		crcOk: false,
		complete: false,
		groundAddr: '',
		airReg: '',
		tags: [],
		hasPos: false,
		posTag: 0,
		lat: 0,
		lon: 0,
		timeSec: 0,
		altFt: 0,
		accuracy: 0,
		redundancyOk: false,
		tcasOk: false,
		flightId: '',
		icao: 0,
		route: null,
		earth: null,
		air: null,
		meteo: null,
		reason: -1,
		requests: [],
		acks: [],
		nacks: [],
	};
}

/** The length of the group at `i` (after its tag); -1 when it is unknown or cut short. */
function groupLength(tag: number, p: ArrayLike<number>, i: number, n: number): number {
	let len = GROUP_LEN[tag] ?? -1;
	if (tag === 4) len = i + 1 < n && [1, 2, 7].includes(p[i + 1]) ? 3 : 2; // these reasons carry one more octet
	if (tag === 5) {
		// contract number, group count, then per group: tag, flags / count, and the parameter numbers as nibbles
		if (i + 2 > n) return -1;
		let j = i + 2;
		for (let g = 0; g < p[i + 1]; g++) {
			if (j + 2 > n) return -1;
			const f = p[j + 1];
			j += 2 + Math.floor(((f & 0xc0 ? 0 : f & 0x0f) + 1) / 2);
		}
		len = j - i;
	}
	return len >= 0 && i + len <= n ? len : -1;
}

function point(b: Bits, withEta: boolean): AeroAdscPoint {
	const lat = angle(b.get(21), 21, 90);
	const lon = angle(b.get(21), 21, 90);
	const altFt = sext(b.get(16), 16) * 4;
	return { lat, lon, altFt, etaSec: withEta ? b.get(14) : -1 };
}

/** A position report (or an event report with the same layout); a later one wins only over an event report. */
function report(out: AeroAdscMessage, tag: number, b: Bits): void {
	if (out.hasPos && out.posTag === 7) return;
	out.hasPos = true;
	out.posTag = tag;
	const p = point(b, false);
	out.lat = p.lat;
	out.lon = p.lon;
	out.altFt = p.altFt;
	out.timeSec = b.get(15) * 0.125;
	const fom = b.get(7);
	out.redundancyOk = (fom & 1) !== 0;
	out.accuracy = (fom >> 1) & 7;
	out.tcasOk = ((fom >> 4) & 1) !== 0;
}

function group(out: AeroAdscMessage, tag: number, p: ArrayLike<number>, i: number, len: number): void {
	const b = new Bits(p, i);
	if (tag === 3) out.acks.push(p[i]);
	else if (tag === 4) out.nacks.push([p[i], len >= 2 ? p[i + 1] : -1]);
	else if (POSITION_TAGS.includes(tag)) report(out, tag, b);
	else if (tag === 12) {
		let id = '';
		for (let k = 0; k < 8; k++) {
			const c = b.get(6);
			id += String.fromCharCode(c & 0x20 ? c : c + 0x40); // A-Z are sent as 01 to 1A
		}
		out.flightId = id.trimEnd();
	} else if (tag === 13) out.route = [point(b, true), point(b, false)];
	else if (tag === 14 || tag === 15) {
		const valid = !b.get(1);
		const h = heading(b.get(12));
		const spd = b.get(13);
		const vsFpm = sext(b.get(12), 12) * 16;
		if (tag === 14) out.earth = { trackDeg: h, groundKt: spd / 2, valid, vsFpm };
		else out.air = { headingDeg: h, mach: spd / 2000, valid, vsFpm };
	} else if (tag === 16) {
		const windKt = b.get(9) / 2;
		const valid = !b.get(1);
		const d = angle(b.get(9), 9, 90);
		out.meteo = { windKt, valid, windDeg: d < 0 ? d + 360 : d, tempC: sext(b.get(12), 12) * 0.25 };
	} else if (tag === 17) out.icao = (p[i] << 16) | (p[i + 1] << 8) | p[i + 2];
}

/** Reads the downlink groups; false when a tag is unknown or a group is cut short (what was read before stays). */
export function aeroParseAdscGroups(p: ArrayLike<number>, n: number, out: AeroAdscMessage): boolean {
	for (let i = 0; i < n;) {
		const tag = p[i++];
		const len = groupLength(tag, p, i, n);
		if (len < 0) return false;
		out.tags.push(tag);
		group(out, tag, p, i, len);
		i += len;
	}
	return true;
}

/** The parameters of a contract request after its contract number; false when one is cut short. */
function requestParams(p: ArrayLike<number>, n: number, at: number, r: AeroAdscRequest): [ok: boolean, next: number] {
	let i = at;
	while (i < n && p[i] >= 10 && p[i] <= 21) {
		// any other value starts the next request of the message
		const sub = p[i++];
		const need = sub === 19 ? 4 : sub === 20 ? 0 : sub === 21 ? 2 : 1;
		if (i + need > n) return [false, i];
		const v0 = p[i];
		if (sub === 10) r.latDevNm = v0 / 8;
		else if (sub === 11) {
			const sf = v0 >> 6;
			r.intervalSec = (sf === 2 ? 8 : sf === 3 ? 64 : sf) * ((v0 & 0x3f) + 1);
		} else if (sub === 18) r.vsFpm = sext(v0, 8) * 64;
		else if (sub === 19) r.altRange = [sext((v0 << 8) | p[i + 1], 16) * 4, sext((p[i + 2] << 8) | p[i + 3], 16) * 4];
		else if (sub === 20) r.waypoint = true;
		else r.groups.push(sub);
		i += need;
	}
	return [true, i];
}

/** The uplink groups of a ground system: contract requests and cancellations; false when one is cut short or unknown. */
export function aeroParseAdscUplink(p: ArrayLike<number>, n: number, out: AeroAdscMessage): boolean {
	for (let i = 0; i < n;) {
		const tag = p[i++];
		out.tags.push(tag);
		const r: AeroAdscRequest = {
			kind: tag,
			contract: -1,
			intervalSec: -1,
			groups: [],
			latDevNm: -1,
			vsFpm: null,
			altRange: null,
			waypoint: false,
		};
		if (tag === 1) {
			out.requests.push(r);
			continue;
		}
		if (![2, 6, 7, 8, 9].includes(tag) || i >= n) return false;
		r.contract = p[i++];
		const [ok, next] = tag === 2 || tag === 6 ? [true, i] : requestParams(p, n, i, r);
		out.requests.push(r);
		if (!ok) return false;
		i = next;
	}
	return true;
}

/** The ground address of an ADS-C application in front of ".ADS." or ".DIS.": at the start or after '/' or a space. */
function findAdsc(text: string): [at: number, ground: string, disconnect: boolean] | null {
	for (const [imi, disconnect] of [
		['.ADS.', false],
		['.DIS.', true],
	] as const)
		for (let f = text.indexOf(imi); f >= 0; f = text.indexOf(imi, f + 1))
			for (const gl of [7, 4]) {
				const s = f - gl;
				if (upperOrDigit(text, s, gl) && (s === 0 || text[s - 1] === '/' || text[s - 1] === ' ')) return [f, text.slice(s, f), disconnect];
			}
	return null;
}

/**
 * Finds and decodes an ADS-C application in an ACARS message text (label B6, or H1 with the "#M1B/B6 " prefix, or A6
 * uplinks); null when there is none. `uplink` selects the group table.
 */
export function aeroDecodeAdsc(text: string, uplink: boolean): AeroAdscMessage | null {
	const found = findAdsc(text);
	if (!found) return null;
	const [at, groundAddr, disconnect] = found;
	const hex = at + 11; // "ADS" or "DIS", then '.' is the first of the 7 address characters
	if (text.length < hex + 4) return null;
	const out = emptyAdsc();
	Object.assign(out, { found: true, disconnect, uplink, groundAddr, airReg: text.slice(at + 4, hex).replace(/^\.+/, '') });
	const buf = [...text.slice(at + 1, hex)].map((c) => c.charCodeAt(0)); // IMI + address, as characters
	const head = buf.length;
	buf.push(...hexBytes(text, hex));
	if (buf.length < head + 2) return out;
	out.crcOk = aeroArincCrc(buf) === ARINC_CRC_GOOD;
	const bin = buf.slice(head, buf.length - 2);
	if (disconnect) {
		out.reason = bin.length ? bin[0] : -1;
		out.complete = bin.length >= 1;
	} else out.complete = uplink ? aeroParseAdscUplink(bin, bin.length, out) : aeroParseAdscGroups(bin, bin.length, out);
	return out;
}

const NACK_REASONS = [
	'',
	'duplicate group tag',
	'duplicate reporting interval tag',
	'event contract request with no data',
	'improper operational mode tag',
	'cancel of a contract that does not exist',
	'contract already exists',
	'undefined contract request tag',
	'undefined error',
	'not enough data in the request',
	'invalid altitude range',
	'vertical speed threshold is 0',
	'aircraft intent projection time is 0',
	'lateral deviation threshold is 0',
];
export const aeroAdscNackReason = (code: number): string => (code >= 1 && code <= 13 ? NACK_REASONS[code] : `reason code ${code}`);

const GROUP_NAMES: Record<number, string> = {
	12: 'flight id',
	13: 'predicted route',
	14: 'earth reference',
	15: 'air reference',
	16: 'meteo',
	17: 'airframe id',
	21: 'aircraft intent',
};

/** A contract request in words. */
export function describeRequest(r: AeroAdscRequest): string {
	if (r.kind === 1) return 'cancel all contracts and disconnect';
	if (r.kind === 2) return `cancel contract ${r.contract}`;
	if (r.kind === 6) return `cancel emergency mode of contract ${r.contract}`;
	const parts = [`${r.kind === 7 ? 'periodic' : r.kind === 9 ? 'emergency periodic' : 'event'} contract ${r.contract}`];
	if (r.intervalSec > 0) parts.push(`every ${r.intervalSec} s`);
	if (r.latDevNm >= 0) parts.push(`lateral deviation over ${r.latDevNm.toFixed(3)} nm`);
	if (r.vsFpm !== null) parts.push(`vertical speed beyond ${r.vsFpm} ft/min`);
	if (r.altRange) parts.push(`altitude outside ${r.altRange[1]} - ${r.altRange[0]} ft`);
	if (r.waypoint) parts.push('waypoint changes');
	for (const g of r.groups) parts.push(GROUP_NAMES[g] ?? '?');
	return parts.join(', ');
}

const ACCURACY = ['navigation lost', '< 30 nm', '< 15 nm', '< 8 nm', '< 4 nm', '< 1 nm', '< 0.25 nm', '< 0.05 nm'];
const KNOWN_TAGS = new Set([3, 4, 7, 9, 10, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
const pointText = (p: AeroAdscPoint) => `${p.lat.toFixed(4)} ${p.lon.toFixed(4)} ${p.altFt} ft`;

function positionLine(m: AeroAdscMessage): string {
	const mm = Math.floor(m.timeSec / 60);
	const ss = (m.timeSec - mm * 60).toFixed(3).padStart(6, '0');
	const flags = (m.redundancyOk ? '' : ', navigation redundancy lost') + (m.tcasOk ? '' : ', TCAS not available');
	return `${m.lat.toFixed(5)} ${m.lon.toFixed(5)}, ${m.altFt} ft, at ${String(mm).padStart(2, '0')}:${ss} past the hour, accuracy ${ACCURACY[m.accuracy & 7]}${flags}`;
}

function reportFields(m: AeroAdscMessage, f: AeroFields): void {
	if (m.hasPos) f.push([aeroAdscTagName(m.posTag), positionLine(m)]);
	if (m.flightId) f.push(['ADS-C flight id', m.flightId]);
	if (m.icao) f.push(['ADS-C airframe', `ICAO ${m.icao.toString(16).toUpperCase().padStart(6, '0')}`]);
	const e = m.earth,
		a = m.air,
		w = m.meteo;
	if (e)
		f.push([
			'Earth reference',
			`track ${e.trackDeg.toFixed(1)}°${e.valid ? '' : ' (invalid)'}, ground speed ${e.groundKt.toFixed(1)} kt, vertical ${e.vsFpm} ft/min`,
		]);
	if (a)
		f.push([
			'Air reference',
			`heading ${a.headingDeg.toFixed(1)}°${a.valid ? '' : ' (invalid)'}, Mach ${a.mach.toFixed(3)}, vertical ${a.vsFpm} ft/min`,
		]);
	if (m.route) f.push(['Predicted route', `next ${pointText(m.route[0])} in ${m.route[0].etaSec} s, then ${pointText(m.route[1])}`]);
	if (w)
		f.push([
			'Meteorological data',
			`wind ${w.windDeg.toFixed(0)}°${w.valid ? '' : ' (invalid)'} ${w.windKt.toFixed(1)} kt, temperature ${w.tempC.toFixed(2)} °C`,
		]);
}

/** The ADS-C application in labelled lines (OnAir's aeroDescribeAdsc). */
export function adscFields(m: AeroAdscMessage): AeroFields {
	const kind = m.disconnect ? 'disconnect' : m.uplink ? 'uplink' : 'report';
	const cut = m.complete || m.uplink ? '' : ', groups cut short or unknown';
	const f: AeroFields = [['ADS-C', `${kind} from ${m.airReg}, ground ${m.groundAddr}, CRC ${m.crcOk ? 'good' : 'FAILED'}${cut}`]];
	if (m.disconnect && m.reason >= 0) f.push(['ADS-C disconnect', `reason code ${m.reason}`]);
	reportFields(m, f);
	for (const r of m.requests) f.push(['ADS-C contract', describeRequest(r)]);
	for (const c of m.acks) f.push(['ADS-C contract', `contract ${c} acknowledged`]);
	for (const [c, why] of m.nacks) f.push(['ADS-C contract', `contract ${c} refused: ${aeroAdscNackReason(why)}`]);
	const other = m.uplink ? [] : m.tags.filter((t) => !KNOWN_TAGS.has(t)).map(aeroAdscTagName);
	if (other.length) f.push(['ADS-C also', other.join(', ')]);
	return f;
}
