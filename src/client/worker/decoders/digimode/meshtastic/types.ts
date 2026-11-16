// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir rust/onair_mesh/src/pb.rs (Field) and rust/onair_mesh/src/meshtastic.rs
// (Header, Data, Ctx, Decoded), https://github.com/adswill/OnAir; see third_party/onair. Protocol facts: Meshtastic
// firmware RadioInterface.h and meshtastic/protobufs (Meshtastic contributors, GPL-3.0). Changes: none in substance.

import type { MeshMessage, MeshNode } from '@/worker/decoders/digimode/lora/mesh.types';

/** One protobuf field: number, wire type, value (wire 0, 1, 5; low 32 bits exactly in lo) or the bytes (wire 2). */
export interface PbField {
	num: number;
	wire: number;
	value: number;
	lo: number;
	data: Uint8Array;
}

/** The 16 byte header in front of the payload (RadioInterface.h PacketHeader). */
export interface MtHeader {
	to: number;
	from: number;
	id: number;
	/** Bits 0..2 hop limit, 3 want-ack, 4 via MQTT, 5..7 hop start. */
	flags: number;
	channel: number;
	nextHop: number;
	relay: number;
}

/** The Data protobuf of a packet (mesh.proto Data). */
export interface MtData {
	portnum: number;
	payload: Uint8Array;
	wantResponse: boolean;
	dest: number;
	source: number;
	requestId: number;
	replyId: number;
}

/** Context of the packet around the Data: sender, destination and the hop / id fields of the header. */
export interface MtCtx {
	from: number;
	to: number;
	hopStart: number;
	hopLimit: number;
	packetId: number;
}

/** What the packet is known for after decoding a port: the detail line and a node update or a text message. */
export interface MtDecoded {
	detail: string;
	node?: MeshNode;
	message?: MeshMessage;
}
