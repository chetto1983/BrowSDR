// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/include/dect2/mpt1327/mpt1327_proto.h (Address, Message) and
// core/include/dect2/mpt1327/mpt1327_rx.h (SyncMode, Event, Stats), https://github.com/adswill/OnAir; see
// third_party/onair. Changes: a codeword is a bigint (codeword bit 1 in bit 63); the sync mode is a string; an event
// carries the system identity known when it came.

/** PFIX / IDENT of a unit; -1 when the message has no prefix or no ident. */
export interface MptAddress {
	pfix: number;
	ident: number;
}

/** An address codeword of the control channel. */
export interface MptMessage {
	/** Mnemonic: GTC, ALH, ACK, AHY, BCAST, ... */
	type: string;
	/** The function and parameters in words. */
	detail: string;
	/** PFIX / IDENT1. */
	called: MptAddress;
	/** IDENT2 (without a prefix of its own, except in HEAD). */
	caller: MptAddress;
	/** The channel number the message carries (GTC: the traffic channel), -1 none. */
	channel: number;
	/** System identity (BCAST, MARK), -1 none. */
	sys: number;
	cw: bigint;
}

/**
 * How codewords are framed. standard: only the SYNC word (or its complement) starts one. tolerant: wherever the last
 * 64 bits have good check bits, then on the 64-bit grid (networks whose sync word differs, as in France). auto:
 * standard, and tolerant as well when no exact sync word was seen in the first 8 s.
 */
export type MptSyncMode = 'standard' | 'tolerant' | 'auto';

export interface MptEvent {
	/** Seconds of audio since the start. */
	t: number;
	msg: MptMessage;
	/** The system identity known when the message came, -1 none yet. */
	sys: number;
}

export interface MptStats {
	/** Codewords with good check bits. */
	good: number;
	/** Single-bit errors repaired (counted in good as well). */
	corrected: number;
	/** Codewords after a SYNC whose check bits fail. */
	bad: number;
	/** Control channel system codewords. */
	ccsc: number;
	/** Address codewords decoded. */
	messages: number;
	/** System identity of the last good CCSC, -1 unknown. */
	sys: number;
	/** The sync word check is off (tolerant, or auto after its fallback). */
	tolerant: boolean;
	/** A good codeword within the last 3 s. */
	locked: boolean;
	t: number;
}
