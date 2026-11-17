// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Framing from OnAir; packet labels follow public ORBCOMM downlink captures.
import type { OrbcommKind, OrbcommPacket } from './types';

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

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
		.join(' ')
		.toUpperCase();
}

function fragment(bytes: Uint8Array, kind: OrbcommKind, label: string, fields: Array<[string, string]>): OrbcommPacket {
	// The high nibble is the number of packets; the low nibble is a zero-based packet index.
	const total = bytes[1] >> 4;
	const index = bytes[1] & 0x0f;
	const payload = hex(bytes.subarray(2, 10));
	if (total === 0 || index >= total) return { kind: 'other', text: `Packet ${hex(bytes.subarray(0, 1))} · ${hex(bytes)}`, fields };
	fields.push(['Fragment', `${index + 1}/${total}`], ['Payload (hex)', payload]);
	return { kind, text: `${label} ${index + 1}/${total} · ${payload}`, fields };
}

/** Interpret only checksum-valid packets. Binary payloads stay in hex until their format is verified. */
export function parseOrbcommPacket(bytes: Uint8Array): OrbcommPacket | null {
	if (!fletcherOk(bytes)) return null;
	const raw = hex(bytes);
	const fields: Array<[string, string]> = [['Raw', raw]];
	if (isSync(bytes)) {
		fields.push(['Satellite', String(bytes[3])], ['Frame', String(bytes[4])]);
		return { kind: 'sync', satellite: bytes[3], text: `Satellite ${bytes[3]} · frame ${bytes[4]}`, fields };
	}
	switch (bytes[0]) {
		case 0x1a:
			return fragment(bytes, 'message', 'Message fragment', fields);
		case 0x1b:
			return fragment(bytes, 'uplink', 'Uplink info', fields);
		case 0x1c:
			return fragment(bytes, 'downlink', 'Downlink info', fields);
		case 0x1d:
			return fragment(bytes, 'network', 'Network info', fields);
		case 0x1e:
			return { kind: 'fill', text: 'Fill', fields };
		case 0x1f:
			fields.push(['Satellite', String(bytes[1])], ['Payload (hex)', hex(bytes.subarray(2, 10))]);
			return { kind: 'ephemeris', text: `Ephemeris · satellite ${bytes[1]} · ${hex(bytes.subarray(2, 10))}`, fields };
		case 0x22:
			fields.push(['Satellite', String(bytes[1])], ['Payload (hex)', hex(bytes.subarray(2, 10))]);
			return { kind: 'elements', text: `Orbital elements · satellite ${bytes[1]} · ${hex(bytes.subarray(2, 10))}`, fields };
		default:
			return { kind: 'other', text: `Packet ${hex(bytes.subarray(0, 1))} · ${raw}`, fields };
	}
}
