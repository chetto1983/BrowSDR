// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/mesh/mesh_proto_rs.cpp (MeshProto::decodeMeshtastic: header, the
// channels whose hash matches first then every other known key, AES-CTR, plausibility of the decrypted Data, the notes of
// an undecrypted packet), core/src/mesh/mesh_proto.cpp (the default channels: every modem preset name with the default
// key) and rust/onair_mesh/src/meshtastic.rs (parse_header, parse_data), https://github.com/adswill/OnAir; see
// third_party/onair. Protocol facts: Meshtastic firmware RadioInterface.h, CryptoEngine.cpp (nonce: packet id as 64 bit
// little endian, sender, 4 byte counter), Channels.cpp (Meshtastic contributors, GPL-3.0). Changes: only the default key
// (no user channels: private channels stay encrypted); no locking.

import { aesCtr } from '@/worker/decoders/digimode/lora/crypto';
import { emptyPacket, hex2 } from '@/worker/decoders/digimode/lora/mesh';
import type { MeshDecodeResult } from '@/worker/decoders/digimode/lora/mesh.types';
import { MESHTASTIC_DEFAULT_PSK } from '@/worker/decoders/digimode/lora/presets';
import { channelHash, nodeId, nodeStr, portName } from './names';
import { PbReader } from './pb';
import { decodePort } from './ports';
import type { MtData, MtHeader } from './types';

/** The default channel uses the key of PSK index 1 and the modem preset's name, so each preset name carries the default key. */
export const MESHTASTIC_CHANNELS = [
	'LongFast',
	'LongSlow',
	'LongTurbo',
	'LongMod',
	'LongModerate',
	'MediumFast',
	'MediumSlow',
	'ShortFast',
	'ShortSlow',
	'ShortTurbo',
	'EdgeFastLow',
].map((name) => ({ name, key: MESHTASTIC_DEFAULT_PSK, hash: channelHash(name, MESHTASTIC_DEFAULT_PSK) }));

const le32 = (p: Uint8Array, i: number): number => (p[i] | (p[i + 1] << 8) | (p[i + 2] << 16) | (p[i + 3] << 24)) >>> 0;

/** The 16 byte header; undefined when shorter. */
export function parseHeader(p: Uint8Array): MtHeader | undefined {
	if (p.length < 16) return;
	return { to: le32(p, 0), from: le32(p, 4), id: le32(p, 8), flags: p[12], channel: p[13], nextHop: p[14], relay: p[15] };
}

/**
 * The firmware accepts any Data that parses and has a portnum; to avoid taking random bytes from a wrong key for a message
 * the portnum must also come first (nanopb writes fields in order; never zero for real traffic, at most 511). Fields above 10
 * are not part of Data.
 */
export function parseData(p: Uint8Array): MtData | undefined {
	const r = new PbReader(p);
	const d: MtData = { portnum: 0, payload: new Uint8Array(0), wantResponse: false, dest: 0, source: 0, requestId: 0, replyId: 0 };
	let first = true;
	for (let f = r.next(); f; f = r.next()) {
		if (f.num > 10) return;
		if (first) {
			if (f.num !== 1 || f.wire !== 0 || f.value === 0 || f.value > 511) return;
			first = false;
		}
		if (f.num === 1 && f.wire === 0) d.portnum = f.value;
		else if (f.num === 2 && f.wire === 2) d.payload = f.data;
		else if (f.num === 3) d.wantResponse = f.value !== 0;
		else if (f.num === 4) d.dest = f.lo;
		else if (f.num === 5) d.source = f.lo;
		else if (f.num === 6) d.requestId = f.lo;
		else if (f.num === 7) d.replyId = f.lo;
	}
	return r.ok && !first ? d : undefined;
}

/** The AES-CTR nonce: packet id (64 bit little endian), sender (32 bit), counter. */
export function meshtasticNonce(id: number, from: number): Uint8Array {
	const nonce = new Uint8Array(16);
	for (let i = 0; i < 4; i++) {
		nonce[i] = (id >>> (8 * i)) & 0xff;
		nonce[8 + i] = (from >>> (8 * i)) & 0xff;
	}
	return nonce;
}

/** Decodes a Meshtastic LoRa payload with the default channel key. */
export function decodeMeshtastic(p: Uint8Array): MeshDecodeResult {
	const r: MeshDecodeResult = { ok: false, packet: emptyPacket(), nodes: [], messages: [] };
	const pi = r.packet;
	pi.size = p.length;
	const h = parseHeader(p);
	if (!h) {
		pi.note = 'too short for a Meshtastic header';
		return r;
	}
	Object.assign(pi, {
		from: nodeStr(h.from),
		to: nodeStr(h.to),
		packetId: h.id,
		hopLimit: h.flags & 7,
		hopStart: h.flags >> 5,
		wantAck: (h.flags & 8) !== 0,
		viaMqtt: (h.flags & 0x10) !== 0,
		channelHash: h.channel,
		nextHop: h.nextHop,
		relayNode: h.relay,
		channel: hex2(h.channel),
	});
	r.ok = true;
	const body = p.subarray(16);
	if (!body.length) {
		pi.type = 'EMPTY';
		pi.note = 'no payload';
		return r;
	}
	// channels whose hash matches first, then every other known key (the hash is only a hint)
	let hashMatched = false;
	const nonce = meshtasticNonce(h.id, h.from);
	for (let pass = 0; pass < 2; pass++)
		for (const c of MESHTASTIC_CHANNELS) {
			const match = c.hash === h.channel;
			if ((pass === 0) !== match) continue;
			if (match) hashMatched = true;
			const plain = body.slice();
			aesCtr(c.key, nonce, plain);
			const d = parseData(plain);
			if (!d) continue;
			const dec = decodePort(d, { from: h.from, to: h.to, hopStart: h.flags >> 5, hopLimit: h.flags & 7, packetId: h.id });
			pi.decrypted = true;
			pi.portnum = d.portnum;
			pi.type = portName(d.portnum);
			if (match) pi.channel = c.name;
			else pi.note = `decrypted with the key of channel ${c.name} (header hash differs)`;
			pi.detail = dec.detail;
			if (dec.message) r.messages.push({ ...dec.message, channel: pi.channel });
			if (dec.node) r.nodes.push({ ...dec.node, nodeId: nodeId(h.from) });
			return r;
		}
	pi.type = 'ENCRYPTED';
	if (h.channel === 0 && h.to !== 0xffffffff && !hashMatched) pi.note = 'encrypted (direct)';
	else if (hashMatched) pi.note = 'wrong key or damaged payload';
	else pi.note = `unknown channel ${hex2(h.channel)}`;
	return r;
}
