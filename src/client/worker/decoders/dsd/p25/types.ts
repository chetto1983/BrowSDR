// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/include/dect2/p25/p25_proto.h (Tsbk, Lc, Crypto, Iden),
// core/include/dect2/p25/p25_cc.h (CcItem, PduData) and core/include/dect2/p25/p25_tel.h (P25Call, P25Site, P25IdenRow),
// https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the status keeps what BrowSDR's DSD panel shows (the call on air or the last one, the site with its
// neighbours, the last grant and a short event list) instead of OnAir's call log, talkgroup table, patch and affiliation
// lists and the TSBK record of its trunking follower (not ported: BrowSDR does not retune).
import type { DsdEvent } from '@/worker/decoders/dsd/types';

/** One trunking signalling block: last block, protected, opcode, manufacturer, 64 bits of arguments. */
export interface P25Tsbk {
	last: boolean;
	prot: boolean;
	opcode: number;
	mfid: number;
	args: bigint;
}

/** A link control word (LDU1 and TDULC). */
export interface P25Lc {
	lco: number;
	mfid: number;
	prot: boolean;
	/** Service options: 0x80 emergency, 0x40 encrypted. */
	svcOpts: number;
	/** Talkgroup, source and destination unit; -1 when the word has none. */
	tg: number;
	src: number;
	dst: number;
}

/** Encryption sync (LDU2) and header (HDU) fields. */
export interface P25Crypto {
	/** Message indicator, hex. */
	mi: string;
	algId: number;
	keyId: number;
	/** The header only. */
	mfid: number;
	tg: number;
}

/** A control channel message beyond the voice grants and the status broadcasts (OnAir CcItem). */
export interface P25CcItem {
	kind:
		| 'patch-add'
		| 'patch-del'
		| 'patch-grant'
		| 'affiliation'
		| 'registration'
		| 'deregistration'
		| 'deny'
		| 'queue'
		| 'ack'
		| 'data-grant'
		| 'status'
		| 'other';
	supergroup: number;
	members: number[];
	unit: number;
	tg: number;
	channel: number;
	accepted: boolean;
	reason: number;
	text: string;
}

/** An unconfirmed data packet: payload (padding and CRC-32 removed), service access point, logical link id and a summary. */
export interface P25PduData {
	payload: Uint8Array;
	sap: number;
	llid: number;
	outbound: boolean;
	summary: string;
}

/** A channel identifier (IDEN_UP, IDEN_UP_VU, IDEN_UP_TDMA): channel numbers to frequencies. */
export interface P25Iden {
	vu: boolean;
	/** The channel number counts time slots, slots per carrier (0: not placed). */
	tdma: boolean;
	slots: number;
	baseHz: number;
	spacingHz: number;
	txOffsetHz: number;
	bwHz: number;
}

/** The system a control channel belongs to (NET_STS_BCST, RFSS_STS_BCST), or an adjacent site (ADJ_STS_BCST). */
export interface P25Site {
	wacn: number;
	sysId: number;
	rfss: number;
	site: number;
	nac: number;
	/** Its control channel and the frequency (0: identifier not heard). */
	channel: number;
	freqHz: number;
}

/** A voice channel grant heard on a control channel. */
export interface P25Grant {
	src: number;
	/** Talkgroup (group) or unit. */
	dst: number;
	group: boolean;
	channel: number;
	freqHz: number;
	emergency: boolean;
	encrypted: boolean;
}

/** A voice call heard on this channel. */
export interface P25Call {
	active: boolean;
	src: number;
	dst: number;
	group: boolean;
	emergency: boolean;
	/** Reported only: nothing is decrypted, the voice of such a call never reaches the codec. */
	encrypted: boolean;
	algId: number;
	keyId: number;
	/** Joined without the header; ended with a terminator (else the signal was lost). */
	lateEntry: boolean;
	endSeen: boolean;
	voiceFrames: number;
	durSec: number;
}

/** What BrowSDR's DSD panel shows of P25 Phase 1. */
export interface P25Status {
	nac: number;
	/** The last data unit. */
	duid: string;
	call?: P25Call;
	/** TSBKs are heard: a control channel. */
	control: boolean;
	site?: P25Site;
	/** Adjacent sites, at most 8. */
	adjacent: P25Site[];
	/** The channel identifiers heard, by identifier (0..15). */
	idens: Array<P25Iden | null>;
	grant?: P25Grant;
	/** NIDs, TSBKs, link controls, encryption syncs and headers that decoded, and that did not. */
	blocksOk: number;
	blocksBad: number;
	inverted: boolean;
	/** Newest first, at most 20. */
	events: DsdEvent[];
}

/** What a control channel has told so far: the site, its neighbours, the channel identifiers, the last grant (and the grants of the last 4 s, not repeated). */
export interface P25ControlState {
	site?: P25Site;
	adjacent: P25Site[];
	idens: Array<P25Iden | null>;
	grant?: P25Grant;
	grants: Array<{ key: string; at: number }>;
	control: boolean;
}
