// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/include/dect2/mesh/mesh_proto.h and rust/onair_mesh/src/abi.rs (the
// defaults of a packet, node update and message), rust/onair_mesh/src/meshtastic.rs (clean_text, clip) and the packet,
// node and message columns of core/src/mesh/mesh_report.cpp / mesh_rx.cpp, https://github.com/adswill/OnAir; see
// third_party/onair. Changes: text is decoded as UTF-8 for display; the columns become record fields.

import type { MeshMessage, MeshNode, MeshPacketInfo } from './mesh.types';

export const emptyPacket = (): MeshPacketInfo => ({
	type: '',
	from: '',
	to: '',
	packetId: 0,
	hopLimit: -1,
	hopStart: -1,
	channel: '',
	decrypted: false,
	note: '',
	size: 0,
	detail: '',
	portnum: -1,
	channelHash: -1,
	wantAck: false,
	viaMqtt: false,
	nextHop: -1,
	relayNode: -1,
	routeType: -1,
	payloadType: -1,
	payloadVersion: -1,
	pathHashCount: -1,
	pathHashSize: 0,
	path: '',
});

export const emptyNode = (): MeshNode => ({
	nodeId: '',
	longName: '',
	shortName: '',
	hwModel: '',
	role: '',
	hasPosition: false,
	lat: 0,
	lon: 0,
	altM: 0,
	positionTime: 0,
	sats: -1,
	batteryPct: -1,
	voltage: -1,
	channelUtilPct: -1,
	airUtilTxPct: -1,
	uptimeS: -1,
	hasEnv: false,
	tempC: 0,
	humidity: 0,
	pressureHpa: 0,
	publicKey: '',
	signatureChecked: false,
	signatureOk: false,
});

export const emptyMessage = (): MeshMessage => ({
	channel: '',
	from: '',
	to: '',
	text: '',
	hops: -1,
	packetId: 0,
	replyId: 0,
	senderTime: 0,
});

const utf8Decoder = new TextDecoder();
/** Bytes as UTF-8 text (broken sequences as U+FFFD). */
export const utf8 = (p: Uint8Array): string => utf8Decoder.decode(p);
export const bytesOf = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Control characters (except the newline) replaced by blanks; other bytes, UTF-8 included, kept. */
export function cleanText(p: Uint8Array): Uint8Array {
	return p.map((c) => (c < 0x20 && c !== 0x0a ? 0x20 : c));
}

/** Up to the first NUL, control characters replaced by blanks. */
export function cleanLine(p: Uint8Array): Uint8Array {
	const end = p.indexOf(0);
	return p.subarray(0, end < 0 ? p.length : end).map((c) => (c < 0x20 ? 0x20 : c));
}

/** `s` if at most `n` bytes, else its first `n` bytes and "...", cut before a UTF-8 character that would not fit whole. */
export function clip(s: Uint8Array, n: number): string {
	if (s.length <= n) return utf8(s);
	let k = n;
	while (k > 0 && (s[k] & 0xc0) === 0x80) k--;
	return `${utf8(s.subarray(0, k))}...`;
}

export const hex2 = (v: number): string => `0x${(v & 0xff).toString(16).padStart(2, '0')}`;
export const hex8 = (v: number): string => (v >>> 0).toString(16).padStart(8, '0');

/** The node update of a packet as record fields. */
export function nodeFields(u: MeshNode): Array<[string, string]> {
	const f: Array<[string, string]> = [];
	if (u.longName) f.push(['Long name', u.longName]);
	if (u.shortName) f.push(['Short name', u.shortName]);
	if (u.hwModel) f.push(['Hardware', u.hwModel]);
	if (u.role) f.push(['Role', u.role]);
	if (u.hasPosition) {
		f.push(['Position', `${u.lat.toFixed(5)}, ${u.lon.toFixed(5)}${u.altM ? `, ${Math.trunc(u.altM)} m` : ''}`]);
		if (u.sats >= 0) f.push(['Satellites', String(u.sats)]);
	}
	if (u.positionTime) f.push([u.signatureChecked ? 'Advert time' : 'Position time', new Date(u.positionTime * 1000).toISOString()]);
	if (u.batteryPct > 100) f.push(['Battery', 'external power']);
	else if (u.batteryPct >= 0) f.push(['Battery', `${Math.trunc(u.batteryPct)} %`]);
	if (u.voltage >= 0) f.push(['Voltage', `${u.voltage.toFixed(2)} V`]);
	if (u.channelUtilPct >= 0) f.push(['Channel utilization', `${u.channelUtilPct.toFixed(1)} %`]);
	if (u.airUtilTxPct >= 0) f.push(['Air time (TX)', `${u.airUtilTxPct.toFixed(1)} %`]);
	if (u.uptimeS >= 0) f.push(['Uptime', `${u.uptimeS} s`]);
	if (u.hasEnv) f.push(['Environment', `${u.tempC.toFixed(1)} °C, ${u.humidity.toFixed(0)} %, ${u.pressureHpa.toFixed(1)} hPa`]);
	if (u.publicKey) f.push(['Public key', u.publicKey]);
	if (u.signatureChecked) f.push(['Signature', u.signatureOk ? 'valid' : 'NOT valid']);
	return f;
}

/** A text message as record fields. */
export function messageFields(m: MeshMessage): Array<[string, string]> {
	const f: Array<[string, string]> = [['Text', m.text]];
	if (m.from) f.push(['Sender', m.from]);
	if (m.hops >= 0) f.push(['Hops taken', String(m.hops)]);
	if (m.replyId) f.push(['Reply to', hex8(m.replyId)]);
	if (m.senderTime) f.push(['Sent', new Date(m.senderTime * 1000).toISOString()]);
	return f;
}
