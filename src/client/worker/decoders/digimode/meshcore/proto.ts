// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir rust/onair_mesh/src/meshcore.rs (header byte, transport codes, path length
// byte, path, the key-free payloads ADVERT, ACK, TRACE, CONTROL, ANON_REQ, the headers of the encrypted types, the plain
// text of a decrypted GRP_TXT / GRP_DATA), core/src/mesh/mesh_proto_rs.cpp (MeshProto::decodeMeshCore: the advert
// signature check, the group channel loop), core/src/mesh/mesh_proto_meshcore.cpp (meshcoreMacThenDecrypt) and
// core/src/mesh/mesh_proto.cpp (meshcoreMakeChannel, the Public channel), https://github.com/adswill/OnAir; see
// third_party/onair. Protocol facts: meshcore-dev/MeshCore src/Packet.cpp, src/Mesh.cpp, src/Utils.cpp,
// src/helpers/BaseChatMesh.cpp, src/helpers/AdvertDataHelpers.cpp, docs/packet_format.md (MeshCore contributors, MIT).
// Changes: only the Public channel (no user channels or hashtag keys); numbers formatted with toFixed.

import { aesEcbDecrypt, hexEncode, hmacSha256, sha256 } from '@/worker/decoders/digimode/lora/crypto';
import { ed25519Verify } from '@/worker/decoders/digimode/lora/ed25519';
import { cleanLine, emptyMessage, emptyNode, emptyPacket, hex2, hex8, utf8 } from '@/worker/decoders/digimode/lora/mesh';
import type { MeshDecodeResult, MeshPacketInfo } from '@/worker/decoders/digimode/lora/mesh.types';
import { MESHCORE_PUBLIC_SECRET } from '@/worker/decoders/digimode/lora/presets';
import type { McChannel, McGroupOut, McOut, McParsed } from './types';

const TYPE_NAMES = new Map<number, string>([
	[0, 'REQ'],
	[1, 'RESPONSE'],
	[2, 'TXT_MSG'],
	[3, 'ACK'],
	[4, 'ADVERT'],
	[5, 'GRP_TXT'],
	[6, 'GRP_DATA'],
	[7, 'ANON_REQ'],
	[8, 'PATH'],
	[9, 'TRACE'],
	[10, 'MULTIPART'],
	[11, 'CONTROL'],
	[15, 'RAW_CUSTOM'],
]);
/** The node role named by the low four bits of the advert flags. */
const ROLES = ['Unknown', 'Chat', 'Repeater', 'Room server', 'Sensor'];
export const ROUTE_NAMES = ['flood with transport codes', 'flood', 'direct', 'direct with transport codes'];

const le32 = (p: Uint8Array, i = 0): number => (p[i] | (p[i + 1] << 8) | (p[i + 2] << 16) | (p[i + 3] << 24)) >>> 0;
const hexOf = (p: Uint8Array): string => hexEncode(p);

/** BaseChatMesh::addChannel: the hash is the first byte of SHA-256 over the key length; a 16 byte secret is zero padded. */
export function meshcoreChannel(name: string, secret: Uint8Array): McChannel {
	const s = new Uint8Array(32);
	s.set(secret.subarray(0, 32));
	return { name, secret: s, keyLen: secret.length, hash: sha256(secret)[0] };
}

const PUBLIC = meshcoreChannel('Public', MESHCORE_PUBLIC_SECRET);

/** Checks and splits the packet (Packet.cpp readFrom); a string is the note for a packet that cannot be MeshCore. */
export function parseHeader(p: Uint8Array): McParsed | string {
	const n = p.length;
	if (n < 3) return 'too short for a MeshCore packet';
	const route = p[0] & 3,
		kind = (p[0] >> 2) & 15,
		ver = p[0] >> 6;
	let i = 1;
	if (route === 0 || route === 3) {
		if (n < 6) return 'truncated transport codes';
		i += 4;
	}
	const pl = p[i++];
	const hsz = (pl >> 6) + 1,
		hcnt = pl & 63;
	if (hsz === 4 || hcnt * hsz > 64) return 'bad path length byte';
	if (i + hcnt * hsz >= n) return 'no payload';
	const pathOff = i;
	i += hcnt * hsz;
	const m = n - i;
	if (m > 184) return 'payload longer than 184 bytes';
	const hashes: string[] = [];
	for (let k = 0; k < hcnt; k++) hashes.push(hexOf(p.subarray(pathOff + k * hsz, pathOff + (k + 1) * hsz)));
	const flood = route === 0 || route === 1;
	const via = hcnt ? `, ${hcnt} ${hcnt === 1 ? 'hop' : 'hops'}` : flood ? ', direct from sender' : '';
	return {
		route,
		kind,
		ver,
		hcnt,
		hsz,
		pathOff,
		payOff: i,
		m,
		typeName: TYPE_NAMES.get(kind) ?? `TYPE_${kind}`,
		path: hashes.join(','),
		via,
	};
}

/** ADVERT: public key, time, signature, app data (flags, position, two optional words, name). */
function advert(pay: Uint8Array, via: string, sigOk: boolean, o: McOut): void {
	if (pay.length < 32 + 4 + 64 + 1) {
		o.note = 'incomplete advert';
		return;
	}
	const app = pay.subarray(100, 100 + Math.min(pay.length - 100, 32)); // Mesh.cpp clamps to MAX_ADVERT_DATA_SIZE
	const al = app.length;
	o.from = hexOf(pay.subarray(0, 6));
	o.decrypted = true; // adverts are not encrypted
	const flags = app[0];
	let k = 1,
		bad = false;
	const u = emptyNode();
	u.role = ROLES[flags & 15] ?? 'Unknown';
	u.publicKey = hexOf(pay.subarray(0, 32));
	u.signatureChecked = true;
	u.signatureOk = sigOk;
	u.positionTime = le32(pay, 32);
	if (flags & 0x10) {
		if (k + 8 > al) bad = true;
		else {
			const la = le32(app, k) | 0,
				lo = le32(app, k + 4) | 0;
			k += 8;
			if (la !== 0 || lo !== 0) {
				u.hasPosition = true;
				u.lat = la / 1e6;
				u.lon = lo / 1e6;
			}
		}
	}
	for (const bit of [0x20, 0x40])
		if (!bad && flags & bit) {
			if (k + 2 > al) bad = true;
			else k += 2;
		}
	if (!bad && flags & 0x80) u.longName = utf8(cleanLine(app.subarray(k)));
	if (bad) {
		o.note = 'incomplete advert data';
		return;
	}
	const pos = u.hasPosition ? `, ${u.lat.toFixed(5)}, ${u.lon.toFixed(5)}` : '';
	o.detail = `${u.longName || '(no name)'}, ${u.role}${pos}${sigOk ? ', signature ok' : ', signature NOT valid'}${via}`;
	o.node = u;
	if (!sigOk) o.note = 'signature not valid';
}

/** TRACE: tag, the nodes, and the SNRs in quarter dB that the path holds. */
function trace(h: McParsed, path: Uint8Array, pay: Uint8Array, o: McOut): void {
	const m = pay.length;
	if (m < 9) {
		o.note = 'incomplete trace';
		return;
	}
	o.decrypted = true;
	const hops = Math.floor((m - 9) / (1 << (pay[8] & 3)));
	let s = `trace ${hex8(le32(pay))}, ${hops} ${hops === 1 ? 'node' : 'nodes'}`;
	if (h.hcnt) s += `, SNR ${Array.from(path.subarray(0, h.hcnt), (b) => (((b << 24) >> 24) / 4).toFixed(2)).join(' ')} dB`;
	o.detail = s;
	o.clearPath = true;
}

/** Decodes everything that needs no key; sigOk is the Ed25519 check of an advert. */
export function decodeKeyFree(h: McParsed, path: Uint8Array, pay: Uint8Array, sigOk: boolean): McOut {
	const o: McOut = { needCrypto: false, decrypted: false, clearPath: false, from: '', to: '', note: '', detail: '' };
	const m = pay.length;
	if (h.kind === 4) advert(pay, h.via, sigOk, o);
	else if (h.kind === 5 || h.kind === 6) {
		if (m < 4) o.note = 'incomplete group packet';
		else o.needCrypto = true;
	} else if (h.kind <= 2 || h.kind === 8) {
		if (m < 4) o.note = 'incomplete packet';
		else {
			o.to = hexOf(pay.subarray(0, 1));
			o.from = hexOf(pay.subarray(1, 2));
			o.needCrypto = true;
		}
	} else if (h.kind === 7) {
		if (m < 1 + 32 + 2) o.note = 'incomplete packet';
		else {
			o.to = hexOf(pay.subarray(0, 1));
			o.from = hexOf(pay.subarray(1, 7));
			o.note = 'encrypted (direct)';
			o.detail = `to ${o.to} from ${o.from}${h.via}`;
		}
	} else if (h.kind === 3) {
		if (m < 4) o.note = 'incomplete ack';
		else {
			o.decrypted = true;
			o.detail = `ack ${hex8(le32(pay))}${h.via}`;
		}
	} else if (h.kind === 9) trace(h, path, pay, o);
	else if (h.kind === 11) {
		o.decrypted = true;
		o.detail = `control, first byte ${hex2(pay[0])}`;
	} else o.detail = `${m} bytes`;
	return o;
}

/** Interprets the decrypted bytes of a group packet (BaseChatMesh.cpp: time, flags byte, "name: text"). */
export function groupPlain(kind: number, hcnt: number, via: string, d: Uint8Array): McGroupOut {
	const g: McGroupOut = { typeName: kind === 6 ? 'GRP_DATA' : 'GRP_TXT', note: '', detail: '' };
	if (kind !== 5) {
		if (d.length < 3) g.note = 'short group data';
		else g.detail = `data type 0x${(d[0] | (d[1] << 8)).toString(16).padStart(4, '0')}, ${d[2]} bytes${via}`;
		return g;
	}
	if (d.length < 5) {
		g.note = 'short group text';
		return g;
	}
	const tt = d[4] >> 2;
	if (tt !== 0) {
		g.note = `unsupported text type ${tt}`;
		return g;
	}
	const line = utf8(cleanLine(d.subarray(5)));
	const t = emptyMessage();
	t.senderTime = le32(d);
	t.hops = hcnt;
	const sep = line.indexOf(': ');
	if (sep >= 0) {
		t.from = line.slice(0, sep);
		t.text = line.slice(sep + 2);
	} else t.text = line;
	g.detail = `${t.from ? `${t.from}: ` : ''}${t.text}${via}`;
	g.message = t;
	return g;
}

/** Utils::MACThenDecrypt: the 2 byte MAC (HMAC-SHA256 with the 32 byte secret over the ciphertext), then AES-128-ECB. */
export function macThenDecrypt(c: McChannel, src: Uint8Array): Uint8Array | undefined {
	if (src.length <= 2) return;
	const enc = src.subarray(2);
	if (enc.length % 16 !== 0) return;
	const mac = hmacSha256(c.secret, enc);
	if (mac[0] !== src[0] || mac[1] !== src[1]) return;
	return aesEcbDecrypt(c.secret.subarray(0, 16), enc);
}

/** GRP_TXT / GRP_DATA (and the end-to-end types tried as group text): the channel whose hash and MAC fit decrypts it. */
function groupPayload(kind: number, h: McParsed, pay: Uint8Array, pi: MeshPacketInfo, r: MeshDecodeResult): boolean {
	if (pay.length < 4) return false;
	pi.channelHash = pay[0];
	pi.channel = hex2(pay[0]);
	let any = false;
	for (const c of [PUBLIC]) {
		if (c.hash !== pay[0]) continue;
		any = true;
		const d = macThenDecrypt(c, pay.subarray(1));
		if (!d) continue;
		const g = groupPlain(kind, h.hcnt, h.via, d);
		Object.assign(pi, { decrypted: true, channel: c.name, type: g.typeName, note: g.note, detail: g.detail });
		if (g.message) {
			g.message.channel = c.name;
			pi.from = g.message.from;
			pi.to = c.name;
			r.messages.push(g.message);
		}
		return true;
	}
	pi.note = any ? 'MAC mismatch (wrong key or damaged)' : `unknown channel ${hex2(pay[0])}`;
	return false;
}

/** Decodes a MeshCore LoRa payload: key-free parts, advert signatures and the Public channel. */
export function decodeMeshCore(p: Uint8Array): MeshDecodeResult {
	const r: MeshDecodeResult = { ok: false, packet: emptyPacket(), nodes: [], messages: [] };
	const pi = r.packet;
	pi.size = p.length;
	const h = parseHeader(p);
	if (typeof h === 'string') {
		pi.note = h;
		return r;
	}
	Object.assign(pi, {
		routeType: h.route,
		payloadType: h.kind,
		payloadVersion: h.ver,
		pathHashCount: h.hcnt,
		pathHashSize: h.hsz,
		path: h.path,
		type: h.typeName,
	});
	r.ok = true;
	const pay = p.subarray(h.payOff, h.payOff + h.m);
	let sigOk = false;
	if (h.kind === 4 && h.m >= 32 + 4 + 64 + 1) {
		// the signature covers public key, time and the app data (at most 32 bytes)
		const al = Math.min(h.m - 100, 32);
		const msg = new Uint8Array(36 + al);
		msg.set(pay.subarray(0, 36));
		msg.set(pay.subarray(100, 100 + al), 36);
		sigOk = ed25519Verify(pay.subarray(36, 100), msg, pay.subarray(0, 32));
	}
	const o = decodeKeyFree(h, p.subarray(h.pathOff, h.pathOff + h.hcnt * h.hsz), pay, sigOk);
	if (o.from) pi.from = o.from;
	if (o.to) pi.to = o.to;
	pi.decrypted = o.decrypted;
	if (o.note) pi.note = o.note;
	if (o.detail) pi.detail = o.detail;
	if (o.clearPath) pi.path = '';
	if (o.node) r.nodes.push({ ...o.node, nodeId: pi.from });
	if (o.needCrypto) {
		if (h.kind === 5 || h.kind === 6) groupPayload(h.kind, h, pay, pi, r);
		else if (!groupPayload(5, h, pay, pi, r)) {
			// end-to-end encrypted: dest hash + src hash + MAC + data
			pi.note = 'encrypted (direct)';
			pi.detail = `to ${pi.to} from ${pi.from}${h.via}`;
		}
	}
	return r;
}
