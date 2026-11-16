// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir rust/onair_mesh/src/aprs.rs (lora_aprs: the "<" 0xFF 0x01 prefix, the
// trailing NUL / CR / LF, the TNC2 split and the call and path checks; printable) and core/src/mesh/mesh_proto_lora_rs.cpp
// (meshDecodeLoraAprs: the information field through the APRS parser, messages), https://github.com/adswill/OnAir; see
// third_party/onair. Facts as credited there: richonguzman/LoRa_APRS_iGate src/lora_utils.cpp (Ricardo Guzman, GPL-3.0).
// Changes: the information field is parsed by BrowSDR's APRS decoder (decoders/aprs/packets.ts) in place of OnAir's
// aprs::parse; the summary line follows BrowSDR's APRS packet log.

import { decodeInfo } from '@/worker/decoders/aprs/packets';
import type { AprsReport, AprsWeather } from '@/worker/decoders/aprs/types';
import { printable } from '@/worker/decoders/digimode/lora/decoder';

/** ASCII letters and digits and the dash. */
const callChar = (c: number): boolean => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x2d;
/** A station call as both firmwares accept it, loosely: 1..20 letters, digits and '-'. */
export const plausibleCall = (s: Uint8Array): boolean => s.length > 0 && s.length <= 20 && s.every(callChar);

const latin1 = (p: Uint8Array): string => String.fromCharCode(...p);

/** A LoRa APRS frame split into source, destination, path and information field, or the note of what is wrong. */
export function splitLoraAprs(p: Uint8Array): { src: string; dest: string; path: string; info: string } | string {
	if (p.length < 3 || p[0] !== 0x3c || p[1] !== 0xff || p[2] !== 0x01) return 'no LoRa APRS prefix';
	let end = p.length;
	while (end > 3 && (p[end - 1] === 0 || p[end - 1] === 0x0d || p[end - 1] === 0x0a)) end--;
	const s = p.subarray(3, end);
	const gt = s.indexOf(0x3e),
		colon = s.indexOf(0x3a);
	if (gt <= 0 || colon < gt + 2) return 'not a TNC2 packet';
	const src = s.subarray(0, gt),
		hdr = s.subarray(gt + 1, colon);
	const comma = hdr.indexOf(0x2c);
	const dest = comma < 0 ? hdr : hdr.subarray(0, comma),
		path = comma < 0 ? hdr.subarray(hdr.length) : hdr.subarray(comma + 1);
	if (!plausibleCall(src) || !plausibleCall(dest)) return 'bad call in the TNC2 header';
	if (!path.every((c) => callChar(c) || c === 0x2c || c === 0x2a)) return 'bad path in the TNC2 header';
	return { src: latin1(src), dest: latin1(dest), path: latin1(path), info: latin1(s.subarray(colon + 1)) };
}

export const KIND_LABELS: Record<AprsReport['kind'], string> = {
	position: 'Position',
	object: 'Object',
	item: 'Item',
	message: 'Message',
	status: 'Status',
	telemetry: 'Telemetry',
	weather: 'Weather',
	capabilities: 'Capabilities',
	query: 'Query',
	other: 'APRS?',
	ax25: 'AX.25',
};

const fixed = (v: number | undefined, digits: number, unit: string): string | undefined =>
	v === undefined ? undefined : `${v.toFixed(digits)}${unit}`;

export const coordinates = (lat: number, lon: number): string =>
	`${Math.abs(lat).toFixed(5)}°${lat < 0 ? 'S' : 'N'} ${Math.abs(lon).toFixed(5)}°${lon < 0 ? 'W' : 'E'}`;

function weatherText(w: AprsWeather): string {
	const wind =
		w.windSpeed === undefined
			? undefined
			: `wind ${w.windSpeed.toFixed(1)} m/s${w.windDirection === undefined ? '' : ` from ${w.windDirection}°`}`;
	return [fixed(w.temperature, 1, ' °C'), fixed(w.humidity, 0, '%'), fixed(w.pressure, 1, ' hPa'), wind].filter(Boolean).join(' · ');
}

/** One line about the report, as BrowSDR's APRS packet log writes it. */
export function aprsSummary(r: AprsReport, info: string): string {
	const m = r.message;
	if (m) {
		if (m.kind === 'ack') return `Acknowledges message ${m.id} to ${m.addressee}`;
		if (m.kind === 'reject') return `Rejects message ${m.id} to ${m.addressee}`;
		return `${m.kind === 'bulletin' ? `Bulletin ${m.addressee}` : `To ${m.addressee}`}: ${m.text}${m.id ? ` (#${m.id})` : ''}`;
	}
	return reportSummary(r) || printable(Uint8Array.from(info.slice(0, 80), (c) => c.charCodeAt(0)));
}

/** Status, telemetry, or the name, weather, position, motion and comment of a report. */
function reportSummary(r: AprsReport): string {
	if (r.kind === 'status') return r.status || '(empty status)';
	if (r.telemetry)
		return `Sequence ${r.telemetry.sequence}: ${r.telemetry.analog.join(', ')}${r.telemetry.digital ? ` · bits ${r.telemetry.digital}` : ''}`;
	const parts: string[] = [];
	if (r.name) parts.push(`${r.kind === 'object' ? 'Object' : 'Item'} ${r.name}${r.killed ? ' (removed)' : ''}`);
	if (r.weather) parts.push(weatherText(r.weather));
	if (r.latitude !== undefined && r.longitude !== undefined) parts.push(coordinates(r.latitude, r.longitude));
	const motion = [fixed(r.speed, 0, ' km/h'), r.course === undefined ? undefined : `${r.course}°`, fixed(r.altitude, 0, ' m')].filter(
		Boolean,
	);
	if (motion.length) parts.push(motion.join(' · '));
	if (r.comment) parts.push(r.comment);
	return parts.filter(Boolean).join(' · ');
}

/** The base call of a station (without the SSID). */
export const baseCall = (call: string): string => call.split('-')[0];

/** Parses the information field of a split frame with BrowSDR's APRS decoder. */
export const parseInfo = (dest: string, info: string): AprsReport => decodeInfo(info, baseCall(dest));
