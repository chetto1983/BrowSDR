// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/include/dect2/wmbus/wmbus_proto.h (Phy, Coding, PhySpec, Record, Frame),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: only the 868 MHz modes S1, T1 and C1 (no R2, N or Wize
// fields); the frame keeps OnAir's parseFrame result (ok) and the encryption method for the report; no decryption fields.

/** Physical modes received here (EN 13757-4): S1 on 868.3 MHz, T1 and C1 (frame formats A and B) on 868.95 MHz. */
export type WmbusPhy = 'S1' | 'T1' | 'C1A' | 'C1B';

export type WmbusCoding = 'manchester' | 'threeOfSix' | 'nrz';

/** Chip level of a mode: rate, nominal deviation, coding and the 16-chip sync word. */
export interface WmbusPhySpec {
	phy: WmbusPhy;
	chipRate: number;
	devHz: number;
	coding: WmbusCoding;
	sync: number;
}

/** One DIF / VIF data record of an unencrypted application layer (EN 13757-3). */
export interface WmbusRecord {
	/** Up to 41 bits: 1 in the DIF, 4 in each of up to 10 DIFE. */
	storage: number;
	dif: number;
	tariff: number;
	subunit: number;
	/** 0 instantaneous, 1 maximum, 2 minimum, 3 error state. */
	func: number;
	/** "Volume", "Energy", ... */
	quantity: string;
	/** With its unit: "1234.5 m3". */
	value: string;
	/** "storage 1, max" and the like. */
	note: string;
	number: number;
	numeric: boolean;
}

/** The records of an application payload; `complete` is false when it ends in the middle of a record. */
export interface WmbusRecords {
	complete: boolean;
	records: WmbusRecord[];
	manufacturerData: boolean;
}

/** Quantity, unit and decimal exponent of a primary VIF. */
export interface WmbusVif {
	name: string;
	unit: string;
	exp: number;
}

export interface WmbusFrame {
	/** OnAir's parseFrame result: every CRC passed and the link layer is complete. */
	ok: boolean;
	crcOk: boolean;
	formatB: boolean;
	L: number;
	C: number;
	ci: number;
	version: number;
	type: number;
	mfrCode: number;
	/** Three letters. */
	mfr: string;
	/** 8 digits. */
	id: string;
	typeName: string;
	cName: string;
	ciName: string;
	shortHeader: boolean;
	longHeader: boolean;
	acc: number;
	status: number;
	config: number;
	/** The payload is encrypted: shown as such, never decoded. */
	encrypted: boolean;
	/** How it is encrypted ("mode 5", "ELL AES-128-CTR"), empty when it is not. */
	encryption: string;
	statusText: string;
	/** L C M A CI ... without the CRCs. */
	data: Uint8Array;
	/** After the CI and the header (the application data). */
	payload: Uint8Array;
	records: WmbusRecord[];
	hasManufacturerData: boolean;
	error: string;
}

/** The bytes of one telegram as the chip demodulator assembled them (with the CRCs), and the signal they came on. */
export interface WmbusTelegram {
	phy: WmbusPhy;
	formatB: boolean;
	bytes: Uint8Array;
	/** Channel power at the sync word, dBFS. */
	levelDb: number;
	/** Carrier offset measured on the preamble, Hz. */
	cfoHz: number;
}
