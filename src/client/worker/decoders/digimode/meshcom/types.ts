// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir rust/onair_mesh/src/aprs.rs (MeshCom, MC_ACK .. MC_HEY) and
// core/include/dect2/mesh/mesh_proto.h (the MeshCom fields of MeshDecodeResult: aprsSource, aprsDest, aprsPath, aprsInfo,
// batteryPct), https://github.com/adswill/OnAir; see third_party/onair. Protocol facts as credited there: MeshCom
// firmware (icssw-org/MeshCom-Firmware, MIT): aprs_functions.cpp, lora_functions.cpp, ack_functions.h. Changes: strings
// in place of the fixed buffers; no printable copy of the payload (the record shows the bytes); the acknowledged id,
// the trailer and the flag byte are kept as numbers too.

/** What a MeshCom frame is (aprs.rs MC_*). */
export type MeshComKind = 'ack' | 'text' | 'position' | 'hey';

/** A decoded MeshCom frame (aprs.rs MeshCom); `ok` false: `note` says what is wrong. */
export interface MeshComFrame {
	ok: boolean;
	kind: MeshComKind;
	/** The frame carries an APRS-style header and information field (all but acks). */
	hasAprs: boolean;
	/** -1 when not sent. */
	hopLimit: number;
	/** "/B=" of a position, percent; -1 when absent. */
	batteryPct: number;
	packetId: number;
	note: string;
	/** "TEXT", "POSITION", "HEY", "ACK". */
	typeName: string;
	/** One line about the frame (complete for ACK, TEXT and HEY). */
	detail: string;
	/** "HW 4, MOD 3, country 0, FW 35, mesh": the trailer and the flags. */
	tail: string;
	/** The sender, the relays after it, the destination field, the call of the destination, type character + payload. */
	src: string;
	aprsPath: string;
	aprsDest: string;
	destCall: string;
	aprsInfo: string;
	/** Text messages: "MeshCom all", "MeshCom 262", "MeshCom <call>", and the cleaned text. */
	channel: string;
	text: string;
	/** Acks: the acknowledged message id. */
	ackedId?: number;
}

/** The parts of a frame between its header and its trailer. */
export interface MeshComSplit {
	srcPath: Uint8Array;
	dest: Uint8Array;
	payload: Uint8Array;
	/** Index of the hardware byte after the payload's NUL. */
	trailer: number;
}
