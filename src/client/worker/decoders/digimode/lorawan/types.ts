// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir rust/onair_mesh/src/lorawan.rs (Lorawan) and lorawan_names.rs (MacDef,
// Network), https://github.com/adswill/OnAir; see third_party/onair. Facts: LoRaWAN L2 1.0.4 (TS001-1.0.4), LoRaWAN 1.1,
// LoRaWAN Backend Interfaces 1.0 (TS002). Changes: 64-bit EUIs as bigint.

/** A MAC command: id, name and payload length in each direction (-1: not sent that way). */
export interface MacDef {
	cid: number;
	up: string;
	upLen: number;
	down: string;
	downLen: number;
}

/** What the DevAddr says: type 0..7 (-1 all ones), the NwkID and the NetID of types 0 to 2. */
export interface LorawanNetwork {
	name: string;
	kind: number;
	nwkId: number;
	netId: number;
	haveIds: boolean;
}

/** The decoded LoRaWAN fields of a PHY payload (MeshDecodeResult::Lorawan and the packet fields). */
export interface Lorawan {
	/** The payload parsed. */
	ok: boolean;
	/** MHDR MType: 0 join request, 1 join accept, 2 / 3 unconfirmed up / down, 4 / 5 confirmed up / down, 6 rejoin, 7 proprietary. */
	mtype: number;
	major: number;
	uplink: boolean;
	confirmed: boolean;
	adr: boolean;
	adrAckReq: boolean;
	ack: boolean;
	fpending: boolean;
	classB: boolean;
	devAddr: number;
	network?: LorawanNetwork;
	foptsLen: number;
	fcnt: number;
	macNames: string[];
	macDetail: string;
	devStatusBattery: number;
	devStatusMargin: number;
	/** -1 no FPort (no FRMPayload). */
	fport: number;
	/** Encrypted FRMPayload bytes (never decrypted). */
	frmLen: number;
	/** The 4 bytes in the order sent (first byte in the high bits); not checked: it needs the device's key. */
	mic: number;
	joinEui: bigint;
	devEui: bigint;
	/** Rejoin: RJcount. */
	devNonce: number;
	rejoinType: number;
	rejoinNetId: number;
	vendor: string;
	typeName: string;
	from: string;
	to: string;
	detail: string;
	note: string;
}
