// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/dmr/dmr_lrrp.cpp (uintvar, ufloatvar, decodePoint, parseDoc,
// dmrIpv4HeaderOk, parseDmrLrrp, parseDmrLrrpCompressed) and core/src/dmr/dmr_nmea.cpp (parseDmrNmea),
// https://github.com/adswill/OnAir; see third_party/onair.
// Changes: one file for both position formats; the parsers return the location or null instead of filling an out
// parameter; the LRRP encoders stay with the test generator.
//
// Motorola LRRP (Location Request/Response Protocol) in IPv4 / UDP, as OnAir confirmed it from a real capture
// (2026-10-23, 161.600 MHz): document id 0x0D (Triggered-Location-Report), document length, then tokens: 0x22
// request-id, 0x51 circle-2d (latitude int32 BE deg * 2^31 / 90, longitude int32 BE deg * 2^32 / 360, radius), 0x66
// point-2d, 0x6C speed-hor (m/s), 0x56 direction-hor (degrees / 2), 0x37 result (16 = no fix), 0x34 info-time.
// NMEA 0183 RMC / GGA sentences carried as plain text in short data (ETSI TS 102 361-3 clause 6 transport).
import type { DmrLocation } from './types';

const be16 = (p: Uint8Array, at: number) => (p[at] << 8) | p[at + 1];
const be32 = (p: Uint8Array, at: number) => ((p[at] << 24) | (p[at + 1] << 16) | (p[at + 2] << 8) | p[at + 3]) >>> 0;

/** A cursor over a byte range. */
class Reader {
	constructor(
		readonly p: Uint8Array,
		public at: number,
		public end: number,
	) {}
	/** Motorola MBXML varint: 7 bits per byte, the high bit marks a continuation (at most 5 bytes). */
	uintvar(): number | null {
		let out = 0;
		for (let i = 0; i < 5; i++) {
			if (this.at >= this.end) return null;
			const b = this.p[this.at++];
			out = out * 128 + (b & 0x7f);
			if (!(b & 0x80)) return out;
		}
		return null;
	}
	/** Unsigned float with a variable-length mantissa: integer part + fraction / 128^(bytes of the fraction). */
	ufloatvar(): number | null {
		const integer = this.uintvar();
		const f0 = this.at;
		const fraction = integer === null ? null : this.uintvar();
		return fraction === null || integer === null ? null : integer + fraction / 128 ** (this.at - f0);
	}
}

/** A position token (0x51 with a radius, 0x66 without): 4 bytes latitude, 4 bytes longitude. */
function decodePoint(r: Reader, out: DmrLocation, withRadius: boolean): boolean {
	if (r.at + 8 > r.end) return false;
	out.lat = ((be32(r.p, r.at) | 0) * 90) / 2147483648;
	const lon = (be32(r.p, r.at + 4) * 360) / 4294967296;
	out.lon = lon > 180 ? lon - 360 : lon;
	out.hasFix = true;
	r.at += 8;
	if (!withRadius) return true;
	const radius = r.ufloatvar();
	if (radius === null) return false;
	out.radiusM = radius;
	return true;
}

/** One token: true to go on, false at the end or at a token that could not be read; null for an unknown token. */
function readToken(r: Reader, out: DmrLocation, result: { has: boolean }): boolean | null {
	const tok = r.uintvar();
	if (tok === null) return false;
	switch (tok) {
		case 0x22: {
			// request-id: opaque, skipped
			const n = r.uintvar();
			if (n === null || r.at + n > r.end) return false;
			r.at += n;
			return true;
		}
		case 0x51:
		case 0x66:
			return decodePoint(r, out, tok === 0x51);
		case 0x6c: {
			const s = r.ufloatvar();
			if (s !== null) out.speedMs = s;
			return s !== null;
		}
		case 0x56:
			if (r.at >= r.end) return false;
			out.headingDeg = r.p[r.at++] * 2;
			return true;
		case 0x37: {
			const code = r.uintvar();
			if (code === null) return false;
			out.resultCode = code;
			result.has = true;
			return true;
		}
		case 0x34:
			// info-time: 40 bits (UTC)
			if (r.at + 5 > r.end) return false;
			r.at += 5;
			return true;
		default:
			return null;
	}
}

/** The LRRP document at `body`: id, length, then the tokens within that length. strict: the tokens must fill the document exactly, every one known. */
function parseDoc(p: Uint8Array, body: number, end: number, strict: boolean): DmrLocation | null {
	const r = new Reader(p, body, end);
	if (r.uintvar() === null) return null;
	const docLen = r.uintvar();
	if (docLen === null) return null;
	let docEnd = r.at + docLen;
	if (docEnd > end) {
		if (strict) return null;
		docEnd = end;
	}
	r.end = docEnd;
	const out: DmrLocation = { hasFix: false, resultCode: 0, lat: 0, lon: 0 };
	const result = { has: false };
	while (r.at < docEnd) {
		const ok = readToken(r, out, result);
		if (ok === null && strict) return null;
		if (!ok) break; // an unknown token or a damaged one: keep what was read
	}
	if (strict && r.at !== docEnd) return null;
	return out.hasFix || result.has ? out : null;
}

/** True when `data` starts with an IPv4 header whose own 16-bit checksum is right. */
export function dmrIpv4HeaderOk(data: Uint8Array): boolean {
	if (data.length < 20 || data[0] >> 4 !== 4) return false;
	const ihl = (data[0] & 15) * 4;
	if (ihl < 20 || ihl > data.length) return false;
	let sum = 0;
	for (let i = 0; i + 1 < ihl; i += 2) sum += be16(data, i);
	while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
	return sum === 0xffff;
}

/** One IPv4 / UDP / LRRP packet: the position or the NoFix status, or null for everything else. */
export function parseDmrLrrp(data: Uint8Array): DmrLocation | null {
	if (data.length < 28 || data[0] >> 4 !== 4) return null; // IPv4 (20 bytes) + UDP (8 bytes)
	const ihl = (data[0] & 15) * 4;
	if (ihl < 20 || ihl + 8 > data.length || data[9] !== 17) return null; // UDP
	const total = be16(data, 2);
	if (total < ihl + 8 || total > data.length) return null;
	const udpLen = be16(data, ihl + 4);
	if (udpLen < 8 || ihl + udpLen > total) return null;
	return parseDoc(data, ihl + 8, ihl + udpLen, false);
}

/**
 * An LRRP document behind a compressed IP/UDP header (OnAir #335: Motorola radios send the position in a packet whose
 * proprietary header carries the compressed header and the first octets of the document). `data` is the proprietary
 * header's octets after the DPF/SAP and MFID octets, followed by the packet's data. The document must end exactly at
 * the end of `data` and hold only known tokens.
 */
export function parseDmrLrrpCompressed(data: Uint8Array): DmrLocation | null {
	for (let off = 0; off <= 8 && off + 4 <= data.length; off++) {
		if (data[off] & 0x80 || data[off + 1] & 0x80) continue; // one-byte document id and length
		if (off + 2 + data[off + 1] !== data.length) continue;
		const loc = parseDoc(data, off, data.length, true);
		if (loc) return loc;
	}
	return null;
}

// ── NMEA 0183 ────────────────────────────────────────────────────────

/** Parses a whole field: it must not be empty, must be finite, and nothing but spaces may follow the number. */
function num(s: string): number | null {
	const t = s.replace(/[ \t]+$/, '');
	if (!/^[ \t]*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null;
	const v = Number(t);
	return Number.isFinite(v) ? v : null;
}

/** ddmm.mmmm (latitude) or dddmm.mmmm (longitude) -> signed degrees; validates the field and its range. */
function coord(v: string, isLat: boolean, hemi: string): number | null {
	const raw = num(v);
	if (raw === null || raw < 0) return null;
	const deg = Math.trunc(raw / 100);
	const min = raw - deg * 100;
	if (min < 0 || min >= 60 || deg > (isLat ? 90 : 180)) return null;
	if (isLat ? hemi !== 'N' && hemi !== 'S' : hemi !== 'E' && hemi !== 'W') return null;
	const d = deg + min / 60;
	return hemi === 'S' || hemi === 'W' ? -d : d;
}

/** Latitude and hemisphere / longitude and hemisphere, starting at f[i]; a 0/0 position is rejected. */
function position(f: string[], i: number): [number, number] | null {
	if (f.length < i + 4) return null;
	const lat = coord(f[i], true, f[i + 1]);
	const lon = coord(f[i + 2], false, f[i + 3]);
	return lat === null || lon === null || (lat === 0 && lon === 0) ? null : [lat, lon];
}

function checksumOk(body: string, cs: string | null): boolean {
	if (cs === null) return true; // no checksum marker: nothing to verify
	if (!/^[0-9A-Fa-f]{2}$/.test(cs)) return false;
	let calc = 0;
	for (let i = 0; i < body.length; i++) calc ^= body.charCodeAt(i) & 0xff;
	return calc === parseInt(cs, 16);
}

/** One RMC or GGA sentence (fields split at the commas). */
function sentence(f: string[], rmc: boolean): DmrLocation | null {
	if (rmc) {
		if (f.length < 9 || f[2] !== 'A') return null; // A = valid, V = void
		const pos = position(f, 3);
		if (!pos) return null;
		const loc: DmrLocation = { hasFix: true, resultCode: 0, lat: pos[0], lon: pos[1] };
		const speed = num(f[7]);
		const course = num(f[8]);
		if (speed !== null) loc.speedMs = speed * 0.514444; // knots -> m/s
		if (course !== null) loc.headingDeg = course;
		return loc;
	}
	const quality = f.length >= 7 ? num(f[6]) : null;
	if (quality === null || quality < 1 || quality !== Math.floor(quality)) return null; // GGA quality 0 = no fix
	const pos = position(f, 2);
	return pos && { hasFix: true, resultCode: 0, lat: pos[0], lon: pos[1] };
}

/** The first valid RMC or GGA sentence in `text`. */
export function parseDmrNmea(text: string): DmrLocation | null {
	if (text.length < 6) return null;
	for (let start = text.indexOf('$'); start >= 0; start = text.indexOf('$', start + 1)) {
		if (start + 6 > text.length) break;
		const tag = text.slice(start + 3, start + 6); // "$GNRMC" / "$GPGGA" / "$GLRMC" ...
		if (tag !== 'RMC' && tag !== 'GGA') continue;
		let end = text.slice(start).search(/[*\r\n]/);
		end = end < 0 ? text.length : start + end;
		const cs = text[end] === '*' ? text.slice(end + 1, end + 3) : null;
		if (!checksumOk(text.slice(start + 1, end), cs)) continue;
		const loc = sentence(text.slice(start, end).split(','), tag === 'RMC');
		if (loc) return loc;
	}
	return null;
}
