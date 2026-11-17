// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/avroad/avroad_air.cpp (s24, fanetParse: the header, the extended
// header with its destination and signature, tracking, name, message, service, ground tracking and the text of every
// type), https://github.com/adswill/OnAir; see third_party/onair. Format facts as credited there: the FANET protocol
// description (protocol.txt of Skytraxx's fanet-stm32, https://github.com/3s1d/fanet-stm32; format only, no code
// copied). Changes: written from that description beyond OnAir: the optional turn rate and QNE offset of tracking, the
// online-tracking bit of ground tracking, the state of charge of a service frame, thermals (OnAir: "thermal") and
// landmarks with their compressed coordinates (OnAir: "type 5, n bytes"); the name and message texts are kept apart.

import { AIRCRAFT, groundName, landmarkName, layerName, typeName } from './names';
import type { FanetFrame, FanetLandmark, FanetService, FanetThermal } from './types';

/** 24 bits, little endian, two's complement. */
function s24(p: Uint8Array, i: number): number {
	const v = p[i] | (p[i + 1] << 8) | (p[i + 2] << 16);
	return v & 0x800000 ? v - 0x1000000 : v;
}
const le16 = (p: Uint8Array, i: number): number => p[i] | (p[i + 1] << 8);
/** An absolute position: latitude / 93206 and longitude / 46603 in 24 bits each. */
const absolute = (p: Uint8Array, i: number): [number, number] => [s24(p, i) / 93206, s24(p, i + 3) / 46603];
/** Seven bits of value with a scale bit (bit 7): v x unit, times k when the bit is set. */
const scaled = (v: number, unit: number, k: number): number => (v & 0x7f) * unit * (v & 0x80 ? k : 1);
/** The same with the seven bits in two's complement. */
function scaledSigned(v: number, unit: number, k: number): number {
	const c = v & 0x40 ? (v & 0x7f) - 0x80 : v & 0x7f;
	return c * unit * (v & 0x80 ? k : 1);
}
/** Eleven bits of metres with a x4 scale bit (bit 11). */
const altitude = (t: number): number => (t & 0x7ff) * (t & 0x800 ? 4 : 1);
/** Landmark altitudes: (signed byte + 109) x 25 m. */
const altitude3d = (v: number): number => (((v << 24) >> 24) + 109) * 25;
/** Landmark radii: 50 m steps, x8 with bit 7. */
const radius = (v: number): number => scaled(v, 50, 8);
const heading = (v: number): number => (v * 360) / 256;
/** OnAir's text: printable ASCII kept, other bytes as '.'. */
const ascii = (p: Uint8Array): string => String.fromCharCode(...Array.from(p, (c) => (c >= 32 && c < 127 ? c : 0x2e)));
/** C's roundf: halves away from zero. */
const roundAway = (x: number): number => Math.sign(x) * Math.round(Math.abs(x));

/**
 * A compressed coordinate next to a reference (the previous point): bit 15 is the parity of the whole degree, bits 0 - 14
 * the fraction of a degree in two's complement (/ 32767); a parity that differs from the reference's rounded degree
 * means the point lies in the neighbouring degree on the side of the fraction.
 */
export function uncompressCoordinate(v: number, ref: number): number {
	const odd = (v & 0x8000) !== 0;
	const sub = (v & 0x4000 ? (v & 0x7fff) - 0x8000 : v & 0x7fff) / 32767;
	let deg = roundAway(ref);
	if (((deg & 1) !== 0) !== odd) deg += sub > ref - deg ? -1 : 1;
	return deg + sub;
}

function emptyFrame(): FanetFrame {
	return {
		type: 0,
		forward: false,
		manufacturer: 0,
		device: 0,
		unicast: false,
		hasSignature: false,
		destManufacturer: 0,
		destDevice: 0,
		hasPos: false,
		lat: 0,
		lon: 0,
		aircraftType: 0,
		altM: 0,
		speedKmh: 0,
		climbMs: 0,
		headingDeg: 0,
		online: false,
		text: '',
		valid: false,
	};
}

function setPosition(f: FanetFrame, q: Uint8Array, i: number): void {
	f.hasPos = true;
	[f.lat, f.lon] = absolute(q, i);
}

/** Type 1: position, aircraft type, altitude, speed, climb, heading; the turn rate and QNE offset when sent. */
function tracking(f: FanetFrame, q: Uint8Array): void {
	if (q.length < 11) {
		f.valid = false;
		return;
	}
	setPosition(f, q, 0);
	const t = le16(q, 6);
	f.online = t >> 15 !== 0;
	f.aircraftType = (t >> 12) & 7;
	f.altM = altitude(t);
	f.speedKmh = scaled(q[8], 0.5, 5);
	f.climbMs = scaledSigned(q[9], 0.1, 5);
	f.headingDeg = heading(q[10]);
	if (q.length > 11) f.turnRateDegS = scaledSigned(q[11], 0.25, 4);
	if (q.length > 12) f.qneOffsetM = scaledSigned(q[12], 1, 4);
	f.text = `${AIRCRAFT[f.aircraftType]}, ${f.altM} m, ${f.speedKmh.toFixed(1)} km/h, climb ${f.climbMs.toFixed(1)} m/s, heading ${f.headingDeg.toFixed(0)}`;
}

/** OnAir's description of a service frame. */
function serviceText(s: FanetService): string {
	let t = 'service';
	if (s.gateway) t += ', internet gateway';
	if (s.tempC !== undefined) t += `, ${s.tempC.toFixed(1)} C`;
	if (s.windDeg !== undefined) t += `, wind ${s.windDeg.toFixed(0)} deg ${s.windKmh?.toFixed(1)} km/h gust ${s.gustKmh?.toFixed(1)}`;
	if (s.humidityPct !== undefined) t += `, humidity ${s.humidityPct.toFixed(0)}%`;
	if (s.pressureHpa !== undefined) t += `, ${s.pressureHpa.toFixed(1)} hPa`;
	if (s.chargePct !== undefined) t += `, charge ${s.chargePct.toFixed(0)}%`;
	return t;
}

/** Type 4: header bits for the gateway and each value (6 down to 1), an extended header byte, a position, the values. */
function service(f: FanetFrame, q: Uint8Array): void {
	const m = q.length;
	if (m < 1) {
		f.valid = false;
		return;
	}
	const h = q[0];
	let o = h & 1 ? 2 : 1;
	const s: FanetService = { gateway: (h & 0x80) !== 0, remoteConfig: (h & 0x04) !== 0 };
	if (m >= o + 6 && h & 0x7e) {
		setPosition(f, q, o);
		o += 6;
	}
	if (h & 0x40 && m > o) s.tempC = ((q[o++] << 24) >> 24) * 0.5;
	if (h & 0x20 && m >= o + 3) {
		s.windDeg = heading(q[o]);
		s.windKmh = scaled(q[o + 1], 0.2, 5);
		s.gustKmh = scaled(q[o + 2], 0.2, 5);
		o += 3;
	}
	if (h & 0x10 && m > o) s.humidityPct = q[o++] * 0.4;
	if (h & 0x08 && m >= o + 2) {
		s.pressureHpa = le16(q, o) * 0.1 + 430;
		o += 2;
	}
	if (h & 0x02 && m > o) s.chargePct = ((q[o] & 0x0f) * 100) / 15;
	f.service = s;
	f.text = serviceText(s);
}

/** Type 7: position, the state and the online-tracking bit. */
function ground(f: FanetFrame, q: Uint8Array): void {
	if (q.length < 7) {
		f.valid = false;
		return;
	}
	setPosition(f, q, 0);
	f.groundType = q[6] >> 4;
	f.online = (q[6] & 1) !== 0;
	f.text = `on the ground: ${groundName(f.groundType)}`;
}

/** Type 9: position, quality and altitude, the climb of the air, the wind there. */
function thermal(f: FanetFrame, q: Uint8Array): void {
	f.text = 'thermal';
	if (q.length < 11) return;
	setPosition(f, q, 0);
	const t = le16(q, 6);
	const th: FanetThermal = {
		quality: (t >> 12) & 7,
		altM: altitude(t),
		climbMs: scaledSigned(q[8], 0.1, 5),
		windKmh: scaled(q[9], 0.5, 5),
		windDeg: heading(q[10]),
	};
	f.thermal = th;
	f.text = `thermal, ${th.altM} m, climb ${th.climbMs.toFixed(1)} m/s, quality ${Math.round((th.quality * 100) / 7)}%, wind ${th.windKmh.toFixed(1)} km/h from ${th.windDeg.toFixed(0)} deg`;
}

/**
 * The points of a landmark from byte o: the first absolute (6 bytes), the others compressed against the one before (4
 * bytes), each followed by `after` bytes (`firstAfter` for the first). Returns where each point's extra bytes start.
 */
function landmarkPoints(lm: FanetLandmark, q: Uint8Array, o: number, after: number, firstAfter: number): number[] {
	const extras: number[] = [];
	let ref: [number, number] | undefined;
	while (o < q.length) {
		const size = ref ? 4 + after : 6 + firstAfter;
		if (q.length - o < size) break;
		const pt: [number, number] = ref
			? [uncompressCoordinate(le16(q, o), ref[0]), uncompressCoordinate(le16(q, o + 2), ref[1])]
			: absolute(q, o);
		extras.push(o + (ref ? 4 : 6));
		lm.points.push(pt);
		ref = pt;
		o += size;
	}
	return extras;
}

/** The elements of a landmark after its header: a text, points, radii and altitudes as its subtype has them. */
function landmarkElements(lm: FanetLandmark, q: Uint8Array, o: number): void {
	const s = lm.subtype;
	if (s === 0) {
		if (q.length - o < 6) return;
		lm.points.push(absolute(q, o));
		const t = q.subarray(o + 6);
		const end = t.indexOf(0);
		lm.text = ascii(end < 0 ? t : t.subarray(0, end));
		return;
	}
	if (s > 9) return;
	if (s === 8) {
		if (q.length - o < 2) return;
		lm.altBottomM = altitude3d(q[o]);
		lm.altTopM = altitude3d(q[o + 1]);
		o += 2;
	}
	const after = s >= 5 && s !== 8 ? 1 : 0; // a radius (circles, cylinders) or an altitude (3D line) per point
	const extras = landmarkPoints(lm, q, o, after, s === 9 ? 3 : after);
	if (!extras.length) return;
	if (s === 5 || s === 6 || s === 9) lm.radiusM = radius(q[extras[0]]);
	if (s === 9) {
		lm.altBottomM = altitude3d(q[extras[0] + 1]);
		lm.altTopM = altitude3d(q[extras[0] + 2]);
	}
	if (s === 7) {
		const a = extras.map((k) => altitude3d(q[k]));
		lm.altBottomM = Math.min(...a);
		lm.altTopM = Math.max(...a);
	}
}

function landmarkText(lm: FanetLandmark): string {
	const parts = [`landmark: ${landmarkName(lm.subtype)} (${layerName(lm.layer)})`];
	if (lm.text !== undefined) parts.push(`"${lm.text}"`);
	else if (lm.points.length) parts.push(`${lm.points.length} point${lm.points.length > 1 ? 's' : ''}`);
	if (lm.radiusM !== undefined) parts.push(`radius ${lm.radiusM} m`);
	if (lm.altBottomM !== undefined) parts.push(`${lm.altBottomM} - ${lm.altTopM} m`);
	parts.push(`for ${lm.ttlMin} min`);
	return parts.join(', ');
}

/** Type 5: time to live and subtype, layer and the wind sectors, then the elements. */
function landmark(f: FanetFrame, q: Uint8Array): void {
	if (q.length < 2 || (q[1] & 0x10 && q.length < 3)) {
		f.valid = false;
		return;
	}
	const lm: FanetLandmark = {
		subtype: q[0] & 0x0f,
		layer: q[1] & 0x0f,
		ttlMin: (((q[0] >> 4) & 7) + 1) * (q[0] & 0x80 ? 6 : 1) * 10,
		points: [],
	};
	if (q[1] & 0x10) lm.windSectors = q[2];
	landmarkElements(lm, q, q[1] & 0x10 ? 3 : 2);
	if (lm.points.length) {
		f.hasPos = true;
		[f.lat, f.lon] = lm.points[0];
	}
	f.landmark = lm;
	f.text = landmarkText(lm);
}

/** The payload of each type (OnAir's switch). */
function payload(f: FanetFrame, q: Uint8Array): void {
	switch (f.type) {
		case 0:
			f.text = 'acknowledge';
			return;
		case 1:
			return tracking(f, q);
		case 2:
			f.name = ascii(q);
			f.text = `name: ${f.name}`;
			return;
		case 3:
			f.message = q.length ? ascii(q.subarray(1)) : '';
			f.text = q.length ? `message: ${f.message}` : 'message';
			return;
		case 4:
			return service(f, q);
		case 5:
			return landmark(f, q);
		case 7:
			return ground(f, q);
		case 9:
			return thermal(f, q);
		default:
			f.text = `type ${f.type}${[6, 8, 10].includes(f.type) ? ` (${typeName(f.type)})` : ''}, ${q.length} bytes`;
	}
}

/** A FANET MAC frame: header, source, extended header (destination, signature), then the payload of its type. */
export function fanetParse(p: Uint8Array): FanetFrame {
	const f = emptyFrame();
	const n = p.length;
	if (n < 4) return f;
	const ext = (p[0] & 0x80) !== 0;
	f.forward = (p[0] & 0x40) !== 0;
	f.type = p[0] & 0x3f;
	f.manufacturer = p[1];
	f.device = p[2] | (p[3] << 8);
	let i = 4;
	if (ext) {
		if (n < 5) return f;
		const e = p[4];
		i = 5;
		f.unicast = (e & 0x20) !== 0;
		f.hasSignature = (e & 0x10) !== 0;
		if (f.unicast) {
			if (n < i + 3) return f;
			f.destManufacturer = p[i];
			f.destDevice = p[i + 1] | (p[i + 2] << 8);
			i += 3;
		}
		if (f.hasSignature) {
			if (n < i + 4) return f;
			i += 4;
		}
	}
	f.valid = true;
	payload(f, p.subarray(i));
	return f;
}
