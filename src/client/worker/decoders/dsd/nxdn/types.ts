// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/include/dect2/nxdn/nxdn_proto.h (Lich, Msg) and
// core/include/dect2/nxdn/nxdn_tel.h (NxdnCall, NxdnSite), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the status keeps what BrowSDR's DSD panel shows of the current (or last) transmission and the site, with a
// short event list, instead of OnAir's call log and event list; key-based decryption is left out.
import type { DsdEvent } from '@/worker/decoders/dsd/types';

/** Link information: RF channel type (0 RCCH, 1 RTCH, 2 RDCH, 3 composite), functional channel type, option, direction (1 outbound). */
export interface NxdnLich {
	rfct: number;
	fct: number;
	opt: number;
	dir: number;
}

/** A layer 3 message; fields not used by the type keep their defaults (call type 1). */
export interface NxdnMsg {
	type: number;
	/** 0 broadcast, 1 group (conference), 4 individual, 6 interconnect. */
	callType: number;
	option: number;
	/** Radio unit id; talkgroup or unit. */
	src: number;
	dst: number;
	/** 0 none, 1 scrambler, 2 DES, 3 AES. */
	cipher: number;
	keyId: number;
	status: number;
	/** Short data: block number, block count (header) and 8 characters per block. */
	block: number;
	blocks: number;
	text: string;
	/** SITE_INFO / SRV_INFO: the 24-bit location id. */
	location: number;
	service: number;
	channel: number;
}

/** The numeric fields of a message. */
export type NxdnMsgNumber = Exclude<keyof NxdnMsg, 'text'>;

/** The site from SITE_INFO / SRV_INFO on a control channel (CAC). */
export interface NxdnSite {
	location: number;
	system: number;
	site: number;
	service: number;
	channel: number;
	ran: number;
}

/** What BrowSDR's DSD panel shows of NXDN: the transmission on air or the last one, and the site. */
export interface NxdnStatus {
	/** control: only a control channel's site has been heard. */
	kind: 'voice' | 'status' | 'data' | 'control';
	active: boolean;
	/** Radio unit id and talkgroup or unit; -1 not known yet. */
	src: number;
	dst: number;
	callType: string;
	/** 0 none, 1 scrambler, 2 DES, 3 AES: reported, never decrypted (the voice of such a call does not reach the codec). */
	cipher: number;
	keyId: number;
	/** Radio access number (from the SACCH or CAC), -1 not known. */
	ran: number;
	/** 2400 (NXDN48) or 4800 (NXDN96). */
	baud: number;
	/** Found from the SACCH superframe (the header was missed). */
	lateEntry: boolean;
	/** TX_REL ended it (else the signal was lost). */
	endSeen: boolean;
	voiceFrames: number;
	durSec: number;
	/** Status: "status N"; short data: the text. */
	text: string;
	/** The frame type of the last frame, e.g. "RTCH, SACCH superframe, voice + voice, outbound". */
	frame: string;
	site?: NxdnSite;
	/** Channels with a good CRC, and with a bad one. */
	blocksOk: number;
	blocksBad: number;
	inverted: boolean;
	/** Newest first, at most 20: calls, releases, status, short data, site. */
	events: DsdEvent[];
}

/** One NXDN transmission as the receiver follows it (OnAir NxdnCall), with its start in signal samples. */
export interface NxdnTx extends Omit<NxdnStatus, 'frame' | 'site' | 'blocksOk' | 'blocksBad' | 'inverted' | 'events'> {
	start: number;
	chain: number;
}

/** A frame's 182 symbols after the frame sync, descrambled and in level units (+-1, +-3), and where they came from. */
export interface NxdnFrame {
	sym: Float32Array;
	/** 2400 or 4800. */
	baud: number;
	/** The frame's sync was not found (carried over by the flywheel). */
	fly: boolean;
	/** The frame sits on a grid of frame syncs (not the first frame found after a search). */
	onGrid: boolean;
	inverted: boolean;
}

/** What the channels of one frame carried: a CRC that passed (strong: FACCH1 or CAC), messages (from the SACCH superframe or not) and voice. */
export interface NxdnDecoded {
	any: boolean;
	strong: boolean;
	sacchOk: boolean;
	msgs: Array<[NxdnMsg, boolean]>;
	voice: Uint8Array[];
}
