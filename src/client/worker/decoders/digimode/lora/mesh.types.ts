// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/include/dect2/mesh/mesh_proto.h (MeshPacketInfo, MeshNodeUpdate,
// MeshTextMessage, MeshDecodeResult) and rust/onair_mesh/src/abi.rs (Node, Message defaults),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: optional fields in place of the -1 / empty
// "not in this packet" values; only what the Meshtastic and MeshCore layers fill.

export interface MeshPacketInfo {
	/** "TEXT_MESSAGE_APP", "POSITION_APP", ..., "ADVERT", "GRP_TXT", "TXT_MSG", ... */
	type: string;
	/** Meshtastic "!1a2b3c4d" / "^all"; MeshCore public-key prefix in hex. */
	from: string;
	to: string;
	packetId: number;
	hopLimit: number;
	hopStart: number;
	/** Channel name when known, else its hash in hex. */
	channel: string;
	decrypted: boolean;
	/** Why not decrypted, or a remark ("encrypted (direct)", "unknown channel 0x1f", "MAC mismatch"). */
	note: string;
	size: number;
	/** One short line about the content ("battery 87 %, 4.07 V", "repeater, 3 hops"). */
	detail: string;
	/** Meshtastic port number of the decoded Data (-1 none). */
	portnum: number;
	/** Meshtastic header channel byte, MeshCore group channel hash (-1 none). */
	channelHash: number;
	wantAck: boolean;
	viaMqtt: boolean;
	/** Meshtastic: last byte of a node number (0 = none, -1 not set). */
	nextHop: number;
	relayNode: number;
	/** MeshCore header fields (-1 not set). */
	routeType: number;
	payloadType: number;
	payloadVersion: number;
	pathHashCount: number;
	pathHashSize: number;
	/** MeshCore path hashes in hex, comma separated. */
	path: string;
}

/** What a packet says about a node (MeshNodeUpdate; the numbers are -1 when not in this packet). */
export interface MeshNode {
	nodeId: string;
	longName: string;
	shortName: string;
	hwModel: string;
	role: string;
	hasPosition: boolean;
	lat: number;
	lon: number;
	altM: number;
	positionTime: number;
	sats: number;
	batteryPct: number;
	voltage: number;
	channelUtilPct: number;
	airUtilTxPct: number;
	uptimeS: number;
	hasEnv: boolean;
	tempC: number;
	humidity: number;
	pressureHpa: number;
	/** MeshCore: full public key in hex; the advert signature check. */
	publicKey: string;
	signatureChecked: boolean;
	signatureOk: boolean;
}

export interface MeshMessage {
	channel: string;
	from: string;
	to: string;
	text: string;
	/** Hops taken (-1 unknown). */
	hops: number;
	packetId: number;
	replyId: number;
	/** MeshCore: the sender's time stamp. */
	senderTime: number;
}

export interface MeshDecodeResult {
	/** The packet was parsed (even if it could not be decrypted). */
	ok: boolean;
	packet: MeshPacketInfo;
	nodes: MeshNode[];
	messages: MeshMessage[];
}
