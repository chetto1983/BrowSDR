// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir rust/onair_mesh/src/meshcore.rs (Parsed, Out, GroupOut) and
// core/src/mesh/mesh_proto_internal.h (MeshCoreChannel), https://github.com/adswill/OnAir; see third_party/onair. Protocol
// facts: meshcore-dev/MeshCore src/Packet.h (MeshCore contributors, MIT). Changes: optional records in place of flags.

import type { MeshMessage, MeshNode } from '@/worker/decoders/digimode/lora/mesh.types';

/** A header that passed the length checks: offsets of the path and the payload in the packet. */
export interface McParsed {
	/** Route type 0..3 (flood / direct, with or without transport codes), payload type 0..15, payload version 0..3. */
	route: number;
	kind: number;
	ver: number;
	/** Number of path hashes and the bytes per hash (1, 2 or 3). */
	hcnt: number;
	hsz: number;
	pathOff: number;
	payOff: number;
	/** Payload length. */
	m: number;
	/** TYPE_<n> when unnamed. */
	typeName: string;
	/** The path hashes in hex separated by commas. */
	path: string;
	/** ", 3 hops", ", direct from sender" or empty. */
	via: string;
}

/** What decoding the key-free part of a packet says. */
export interface McOut {
	/** A group or end-to-end encrypted type that still needs the key loop. */
	needCrypto: boolean;
	decrypted: boolean;
	/** Clear the path text (TRACE: the path holds SNRs). */
	clearPath: boolean;
	from: string;
	to: string;
	note: string;
	detail: string;
	node?: MeshNode;
}

/** What a decrypted GRP_TXT / GRP_DATA says. */
export interface McGroupOut {
	typeName: string;
	/** Empty when fully decoded, else why not. */
	note: string;
	detail: string;
	message?: MeshMessage;
}

export interface McChannel {
	name: string;
	/** A 16 byte secret zero padded to 32, as in MeshCore (the HMAC key is the whole 32 bytes). */
	secret: Uint8Array;
	keyLen: number;
	/** First byte of the SHA-256 of the secret (keyLen bytes). */
	hash: number;
}
