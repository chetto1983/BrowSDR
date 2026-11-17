// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from OnAir core/include/dect2/orbcomm/orbcomm.h; packet formatting adapted for BrowSDR.
import type { OrbcommPacket } from './types';
/** Public ORBCOMM subscriber downlink framing: 4800 bit/s SDPSK, 50 twelve-byte packets per second. */
export const ORBCOMM_BAUD = 4800;
export const PACKET_BYTES = 12;
export const FRAME_PACKETS = 50;
export const SYNC = [0x65, 0xa8, 0xf9] as const;

export function fletcherOk(bytes: Uint8Array): boolean {
	if (bytes.length !== PACKET_BYTES) return false;
	let first = 0;
	let second = 0;
	for (const byte of bytes) {
		first = (first + byte) & 255;
		second = (second + first) & 255;
	}
	return first === 0 && second === 0;
}

export function isSync(bytes: Uint8Array): boolean {
	return bytes.length === PACKET_BYTES && bytes[0] === SYNC[0] && bytes[1] === SYNC[1] && bytes[2] === SYNC[2] && fletcherOk(bytes);
}

function u16(bytes: Uint8Array, offset: number): number {
	return bytes[offset] | (bytes[offset + 1] << 8);
}

function ephemeris(bytes: Uint8Array): { lat: number; lon: number; altitudeKm: number; seconds: number } {
	const get = (start: number, width: number): number => {
		let bits = 0;
		for (let i = 0; i < width; i++) bits |= ((bytes[1 + ((start + i) >> 3)] >> ((start + i) & 7)) & 1) << i;
		return bits;
	};
	const signedKm = (start: number): number => {
		const bits = get(start, 20);
		return (bits & 0x80000 ? bits - 0x100000 : bits) / 64;
	};
	const x = signedKm(0);
	const y = signedKm(20);
	const z = signedKm(40);
	const a = 6378.137;
	const flattening = 1 / 298.257223563;
	const eccentricitySquared = flattening * (2 - flattening);
	const horizontal = Math.hypot(x, y);
	let latitude = Math.atan2(z, horizontal * (1 - eccentricitySquared));
	let altitudeKm = 0;
	for (let i = 0; i < 6; i++) {
		const sin = Math.sin(latitude);
		const radius = a / Math.sqrt(1 - eccentricitySquared * sin * sin);
		altitudeKm = horizontal / Math.cos(latitude) - radius;
		latitude = Math.atan2(z, horizontal * (1 - (eccentricitySquared * radius) / (radius + altitudeKm)));
	}
	return { lat: (latitude * 180) / Math.PI, lon: (Math.atan2(y, x) * 180) / Math.PI, altitudeKm, seconds: get(60, 12) };
}

/** Interpret only checksum-valid packets. Unknown payloads stay as hex; private user data is not guessed. */
export function parseOrbcommPacket(bytes: Uint8Array): OrbcommPacket | null {
	if (!fletcherOk(bytes)) return null;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
		.join(' ')
		.toUpperCase();
	const fields: Array<[string, string]> = [['Raw', hex]];
	if (isSync(bytes)) {
		fields.push(['Satellite', String(bytes[3])], ['Frame', String(bytes[4])]);
		return { kind: 'sync', satellite: bytes[3], text: `Satellite ${bytes[3]} · frame ${bytes[4]}`, fields };
	}
	switch (bytes[0]) {
		case 0x1a: {
			const text = String.fromCharCode(...bytes.subarray(3, 10)).replace(/[^\x20-\x7e]/g, '.');
			const message = { id: bytes[1], part: bytes[2] & 0x7f, last: !!(bytes[2] & 0x80), text };
			fields.push(['Message ID', String(message.id)], ['Part', `${message.part}${message.last ? ' (last)' : ''}`]);
			return { kind: 'message', text: `Message ${message.id} part ${message.part}: ${text}`, fields, message };
		}
		case 0x1b:
		case 0x1c: {
			const uplink = bytes[0] === 0x1b;
			const channels = Array.from({ length: Math.min(bytes[1], 4) }, (_, i) =>
				((uplink ? 148 : 137) + u16(bytes, 2 + 2 * i) * 0.0025).toFixed(4),
			);
			fields.push(['Channels', channels.map((frequency) => `${frequency} MHz`).join(', ')]);
			return {
				kind: uplink ? 'uplink' : 'downlink',
				text: `${uplink ? 'Uplink' : 'Downlink'} channels: ${channels.join(', ')} MHz`,
				fields,
			};
		}
		case 0x1d:
			fields.push(['Gateway', String(bytes[1])], ['Status', bytes[2].toString(16).padStart(2, '0').toUpperCase()]);
			return {
				kind: 'network',
				text: `Network gateway ${bytes[1]} · status ${bytes[2].toString(16).padStart(2, '0').toUpperCase()}`,
				fields,
			};
		case 0x1e:
			return { kind: 'fill', text: 'Fill', fields };
		case 0x1f: {
			const position = ephemeris(bytes);
			fields.push(
				['Latitude', position.lat.toFixed(3)],
				['Longitude', position.lon.toFixed(3)],
				['Altitude', `${position.altitudeKm.toFixed(1)} km`],
				['Seconds of hour', String(position.seconds)],
			);
			return {
				kind: 'ephemeris',
				position,
				text: `Position ${position.lat.toFixed(2)}, ${position.lon.toFixed(2)} · ${position.altitudeKm.toFixed(0)} km`,
				fields,
			};
		}
		case 0x22:
			fields.push(
				['Satellite', String(bytes[1])],
				['Inclination', `${(u16(bytes, 2) / 100).toFixed(2)}°`],
				['RAAN', `${(u16(bytes, 4) / 100).toFixed(2)}°`],
				['Argument of latitude', `${(u16(bytes, 6) / 100).toFixed(2)}°`],
				['Period', `${(u16(bytes, 8) / 100).toFixed(2)} min`],
			);
			return {
				kind: 'elements',
				text: `Orbital elements · satellite ${bytes[1]} · inclination ${(u16(bytes, 2) / 100).toFixed(2)}°`,
				fields,
			};
		default:
			return { kind: 'other', text: `Packet ${bytes[0].toString(16).padStart(2, '0').toUpperCase()} · ${hex}`, fields };
	}
}
