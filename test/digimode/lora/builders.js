// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir core/src/mesh/mesh_pb.cpp (protobuf Writer),
// core/src/mesh/mesh_proto_meshtastic.cpp (meshtasticData, meshtasticRaw and the port builders),
// core/src/mesh/mesh_proto_meshcore.cpp (meshcoreNodeKeys, meshcoreAdvert, meshcoreGroupText, meshcoreAck),
// core/src/mesh/mesh_proto_aprs.cpp (loraAprsFrame) and core/src/mesh/mesh_proto_lorawan.cpp (lorawanBuild,
// lorawanJoinRequest), https://github.com/adswill/OnAir; see third_party/onair. Protocol facts as credited there:
// Meshtastic firmware and protobufs (Meshtastic contributors, GPL-3.0), MeshCore (MeshCore contributors, MIT),
// LoRa_APRS_iGate (Ricardo Guzman, GPL-3.0), LoRaWAN TS001. Changes: plain arrays of bytes; EUIs as bigint.

import { aesCtr, aesEcbEncrypt, hmacSha256, sha256 } from '@/worker/decoders/digimode/lora/crypto';
import { ed25519ExpandSeed, ed25519PublicFromPrivate, ed25519Sign } from '@/worker/decoders/digimode/lora/ed25519';
import { MESHCORE_PUBLIC_SECRET, MESHTASTIC_DEFAULT_PSK } from '@/worker/decoders/digimode/lora/presets';
import { channelHash, nodeId } from '@/worker/decoders/digimode/meshtastic/names';

const utf8 = (s) => Array.from(new TextEncoder().encode(s));
const le32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
/** C lround. */
const lround = (x) => Math.sign(x) * Math.round(Math.abs(x));

/** Protocol Buffers writer (mesh_pb.h Writer). */
export class PbWriter {
	b = [];
	raw(v) {
		let x = BigInt.asUintN(64, BigInt(v));
		while (x >= 0x80n) {
			this.b.push(Number(x & 0x7fn) | 0x80);
			x >>= 7n;
		}
		this.b.push(Number(x));
	}
	tag(field, wire) {
		this.raw(field * 8 + wire);
	}
	varint(field, v) {
		this.tag(field, 0);
		this.raw(v);
	}
	int32(field, v) {
		this.varint(field, v); // a negative int32 is a 10 byte varint
	}
	boolean(field, v) {
		this.varint(field, v ? 1 : 0);
	}
	fixed32(field, v) {
		this.tag(field, 5);
		this.b.push(...le32(v >>> 0));
	}
	sfixed32(field, v) {
		this.fixed32(field, v >>> 0);
	}
	floating(field, f) {
		const dv = new DataView(new ArrayBuffer(4));
		dv.setFloat32(0, f, true);
		this.tag(field, 5);
		this.b.push(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
	}
	bytes(field, p) {
		this.tag(field, 2);
		this.raw(p.length);
		this.b.push(...p);
	}
	string(field, s) {
		this.bytes(field, utf8(s));
	}
	packedFixed32(field, v) {
		if (!v.length) return;
		this.tag(field, 2);
		this.raw(v.length * 4);
		for (const x of v) this.b.push(...le32(x >>> 0));
	}
	packedVarint(field, v) {
		if (!v.length) return;
		const t = new PbWriter();
		for (const x of v) t.raw(x);
		this.bytes(field, t.b);
	}
}

/** The Data protobuf. */
export function meshtasticData(
	portnum,
	payload,
	{ wantResponse = false, dest = 0, source = 0, requestId = 0, replyId = 0, emoji = 0 } = {},
) {
	const w = new PbWriter();
	w.varint(1, portnum);
	if (payload.length) w.bytes(2, payload);
	if (wantResponse) w.boolean(3, true);
	if (dest) w.fixed32(4, dest);
	if (source) w.fixed32(5, source);
	if (requestId) w.fixed32(6, requestId);
	if (replyId) w.fixed32(7, replyId);
	if (emoji) w.fixed32(8, emoji);
	w.varint(9, 0); // bitfield (the firmware sends it)
	return w.b;
}

/** Header + AES-CTR(key, nonce) of the Data protobuf; key empty: not encrypted. */
export function meshtasticRaw(from, to, packetId, hopLimit, hopStart, wantAck, channelName, key, dataProto) {
	const out = [...le32(to), ...le32(from), ...le32(packetId)];
	out.push((hopLimit & 7) | (wantAck ? 8 : 0) | ((hopStart & 7) << 5), channelHash(channelName, key), 0, from & 0xff);
	const body = Uint8Array.from(dataProto);
	if (key.length) {
		const nonce = new Uint8Array(16);
		nonce.set(le32(packetId), 0);
		nonce.set(le32(from), 8);
		aesCtr(key, nonce, body);
	}
	return Uint8Array.from([...out, ...body]);
}

const BROADCAST = 0xffffffff;
const onDefault = (from, to, id, hl, hs, wantAck, data) =>
	meshtasticRaw(from.num, to, id, hl, hs, wantAck, 'LongFast', MESHTASTIC_DEFAULT_PSK, data);

export const meshtasticText = (from, to, id, hl, hs, text, replyId = 0, wantAck = false) =>
	onDefault(from, to, id, hl, hs, wantAck, meshtasticData(1, utf8(text), { replyId }));

export function meshtasticNodeInfo(from, id, hl, hs) {
	const u = new PbWriter();
	u.string(1, nodeId(from.num));
	u.string(2, from.longName);
	u.string(3, from.shortName);
	u.varint(5, from.hwModel);
	if (from.role) u.varint(7, from.role);
	return onDefault(from, BROADCAST, id, hl, hs, false, meshtasticData(4, u.b));
}

export function meshtasticPosition(from, id, hl, hs, unixTime, precisionBits = 32) {
	const w = new PbWriter();
	w.sfixed32(1, lround(from.lat * 1e7));
	w.sfixed32(2, lround(from.lon * 1e7));
	w.int32(3, lround(from.altM));
	if (unixTime) w.fixed32(4, unixTime);
	w.varint(5, 2); // LOC_INTERNAL
	w.varint(19, 8); // sats_in_view
	w.varint(23, precisionBits);
	return onDefault(from, BROADCAST, id, hl, hs, false, meshtasticData(3, w.b));
}

export function meshtasticTelemetry(from, id, hl, hs, battery, voltage, chUtil, airTx, uptime) {
	const dm = new PbWriter();
	dm.varint(1, lround(battery));
	dm.floating(2, voltage);
	dm.floating(3, chUtil);
	dm.floating(4, airTx);
	dm.varint(5, uptime);
	const t = new PbWriter();
	t.bytes(2, dm.b);
	return onDefault(from, BROADCAST, id, hl, hs, false, meshtasticData(67, t.b));
}

export function meshtasticEnvTelemetry(from, id, hl, hs, tempC, humidity, hpa) {
	const em = new PbWriter();
	em.floating(1, tempC);
	em.floating(2, humidity);
	em.floating(3, hpa);
	const t = new PbWriter();
	t.bytes(3, em.b);
	return onDefault(from, BROADCAST, id, hl, hs, false, meshtasticData(67, t.b));
}

export function meshtasticRoutingAck(from, to, id, hl, hs, requestId, err = 0) {
	const w = new PbWriter();
	if (err) w.varint(3, err);
	return onDefault(from, to, id, hl, hs, false, meshtasticData(5, w.b, { requestId }));
}

export function meshtasticTraceroute(from, to, id, hl, hs, reply, requestId, route, snrTowards, routeBack, snrBack) {
	const w = new PbWriter();
	w.packedFixed32(1, route);
	w.packedVarint(2, snrTowards);
	w.packedFixed32(3, routeBack);
	w.packedVarint(4, snrBack);
	return onDefault(from, to, id, hl, hs, false, meshtasticData(70, w.b, { wantResponse: !reply, requestId: reply ? requestId : 0 }));
}

export function meshtasticNeighborInfo(from, id, hl, hs, interval, neighbors) {
	const w = new PbWriter();
	w.varint(1, from.num);
	w.varint(2, from.num);
	w.varint(3, interval);
	for (const x of neighbors) {
		const m = new PbWriter();
		m.varint(1, x.node);
		m.floating(2, x.snr);
		m.varint(4, interval);
		w.bytes(4, m.b);
	}
	return onDefault(from, BROADCAST, id, hl, hs, false, meshtasticData(71, w.b));
}

/** The test key pair of a MeshCore node: seed = SHA-256("mctest" + seed byte). */
export function meshcoreNodeKeys(n) {
	const seed = sha256(Uint8Array.from([...utf8('mctest'), n.seed]));
	return { seed, pub: ed25519PublicFromPrivate(ed25519ExpandSeed(seed)) };
}

/** A signed ADVERT (AdvertDataBuilder::encodeTo, Mesh::createAdvert), flood, no path. */
export function meshcoreAdvert(nd, unixTime) {
	const { seed, pub } = meshcoreNodeKeys(nd);
	const app = [(nd.repeater ? 2 : 1) | 0x10 | (nd.name ? 0x80 : 0), ...le32(Math.trunc(nd.lat * 1e6)), ...le32(Math.trunc(nd.lon * 1e6))];
	app.push(...utf8(nd.name).slice(0, 32 - app.length));
	const sig = ed25519Sign(seed, Uint8Array.from([...pub, ...le32(unixTime), ...app]));
	return Uint8Array.from([(4 << 2) | 1, 0, ...pub, ...le32(unixTime), ...sig, ...app]);
}

/** GRP_TXT on a channel: time, flags, "name: text", AES-128-ECB, 2 byte HMAC, channel hash. */
export function meshcoreGroupText(secret16, from, unixTime, text, path = []) {
	const maxPlain = Math.floor((184 - 3) / 16) * 16;
	const plain = [...le32(unixTime), 0, ...utf8(`${from.name}: ${text}`)].slice(0, maxPlain);
	const key32 = new Uint8Array(32);
	key32.set(secret16);
	const ct = aesEcbEncrypt(key32.subarray(0, 16), Uint8Array.from(plain));
	const mac = hmacSha256(key32, ct);
	const h = sha256(secret16);
	return Uint8Array.from([(5 << 2) | 1, path.length & 63, ...path.slice(0, 63), h[0], mac[0], mac[1], ...ct]);
}

export const meshcorePublicText = (from, unixTime, text, path) => meshcoreGroupText(MESHCORE_PUBLIC_SECRET, from, unixTime, text, path);

export const meshcoreAck = (crc, path = []) => Uint8Array.from([(3 << 2) | 1, path.length & 63, ...path.slice(0, 63), ...le32(crc)]);

/** LoRa APRS: "<" 0xFF 0x01 + the TNC2 text. */
export const loraAprsFrame = (tnc2) => Uint8Array.from([0x3c, 0xff, 0x01, ...utf8(tnc2)]);

const putMic = (mic) => [(mic >>> 24) & 0xff, (mic >>> 16) & 0xff, (mic >>> 8) & 0xff, mic & 0xff];

/** A LoRaWAN data or proprietary frame (any MIC: it is not checked). */
export function lorawanBuild({
	mtype = 2,
	devAddr = 0,
	adr = false,
	adrAckReq = false,
	ack = false,
	fpending = false,
	fcnt = 0,
	fopts = [],
	fport = -1,
	frm = [],
	mic = 0,
}) {
	const v = [(mtype & 7) << 5];
	if (mtype === 7) return Uint8Array.from([...v, ...frm, ...putMic(mic)]);
	const up = mtype === 2 || mtype === 4;
	const fl = Math.min(15, fopts.length);
	v.push(...le32(devAddr), (adr ? 0x80 : 0) | (up && adrAckReq ? 0x40 : 0) | (ack ? 0x20 : 0) | (!up && fpending ? 0x10 : 0) | fl);
	v.push(fcnt & 0xff, (fcnt >> 8) & 0xff, ...fopts.slice(0, fl));
	if (fport >= 0) v.push(fport, ...frm);
	return Uint8Array.from([...v, ...putMic(mic)]);
}

export function lorawanJoinRequest(joinEui, devEui, devNonce, mic) {
	const v = [0x00];
	for (let i = 0n; i < 8n; i++) v.push(Number((joinEui >> (8n * i)) & 0xffn));
	for (let i = 0n; i < 8n; i++) v.push(Number((devEui >> (8n * i)) & 0xffn));
	v.push(devNonce & 0xff, devNonce >> 8, ...putMic(mic));
	return Uint8Array.from(v);
}
