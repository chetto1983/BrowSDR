// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/include/dect2/dmr/dmr_proto.h (FullLc, Csbk, DataHeader, DataBlock,
// TalkerAlias), dmr_tel.h (DmrMessage, DmrLocation), dmr_vendor.h (CapPlusGrant, ConPlus, IpService), dmr_xpt.h (XptLsn,
// XptAdjacent, XptCall, XptState) and core/include/dect2/p25/trunk.h (Grant), https://github.com/adswill/OnAir; see
// third_party/onair.
// Changes: bits are Uint8Array (one bit per element), the call log, message list and location list of DmrTelemetry
// become the short DmrInfo summary BrowSDR shows in its DSD panel, and the per-slot receiver state of dmr_link.h
// (Track, Assembler) keeps only what the burst decoding needs.
import type { DmrLinkControl } from '@/worker/decoders/dsd/types';
import type { TalkerAlias } from './text';

/** Full link control (72 bits) of a voice call or of the embedded signalling. */
export interface FullLc {
	/** Protect flag. */
	pf: boolean;
	/** Full link control opcode (6 bits). */
	flco: number;
	/** Feature set id. */
	fid: number;
	/** Service options (group and unit to unit calls). */
	svc: number;
	dst: number;
	src: number;
	/** The nine octets as received. */
	raw: Uint8Array;
}

/** A control signalling block. */
export interface Csbk {
	/** Last block. */
	lb: boolean;
	/** Protect flag. */
	pf: boolean;
	opcode: number;
	fid: number;
	/** The eight argument octets. */
	data: Uint8Array;
}

/** A data header (first ten octets of a header block). */
export interface DataHeader {
	dpf: number;
	sap: number;
	group: boolean;
	resp: boolean;
	dst: number;
	src: number;
	/** Blocks to follow (BF), or appended blocks (AB) of the short data headers. */
	blocks: number;
	/** Pad octet count of a packet, pad bits of a short data message. */
	pad: number;
	fmf: boolean;
	fsn: number;
	ns: number;
	/** Defined data format (short data). */
	dd: number;
	sp: number;
	dp: number;
	resync: boolean;
	sarq: boolean;
	/** Status / precoded value. */
	status: number;
}

/** A parsed data block. */
export interface DataBlock {
	bytes: Uint8Array;
	/** Data block serial number (confirmed blocks). */
	dbsn: number;
	/** CRC-9 of a confirmed block (true for unconfirmed). */
	crcOk: boolean;
}

/** A position from LRRP, NMEA or the GPS info of the embedded link control. */
export interface DmrLocation {
	/** False: a NoFix / status report, no position. */
	hasFix: boolean;
	/** LRRP result code when there is no fix (16 = no fix). */
	resultCode: number;
	lat: number;
	lon: number;
	radiusM?: number;
	/** Metres per second. */
	speedMs?: number;
	headingDeg?: number;
}

/** Capacity Plus channel status: logical slot number 1 .. 16 and its 8-bit group. */
export interface CapPlusGrant {
	lsn: number;
	tg: number;
}

/** Connect Plus voice grant (0x03), data grant (0x06), slot termination (0x0C), neighbours (0x01). */
export interface ConPlus {
	opcode: number;
	src: number;
	dst: number;
	lcn: number;
	slot: number;
	neighbours: number[];
}

/** A Motorola service in an IPv4 / UDP datagram: ARS (port 4005) or text messages, TMS (port 4007). */
export interface IpService {
	port: number;
	ack: boolean;
	kind: string;
	/** The radio name (ARS) or the message (TMS). */
	text: string;
}

/** One Hytera XPT logical slot: 0 idle, 1 unknown, 2 private or data, 3 group (-1 not heard). */
export interface XptLsn {
	status: number;
	/** An 8 bit talkgroup, or the hash of a private target. */
	tg: number;
	lastSec: number;
}

export interface XptAdjacent {
	site: number;
	freeLcn: number;
	lastSec: number;
}

export interface XptCall {
	lcn: number;
	freeLcn: number;
	handshake: number;
	target: number;
	source: number;
	sec: number;
}

export interface XptState {
	seen: boolean;
	lastSec: number;
	freeLcn: number;
	lsn: XptLsn[];
	adjacent: XptAdjacent[];
	/** The newest first, at most 32. */
	calls: XptCall[];
}

/** A channel grant (Tier III, Capacity Plus, Connect Plus). */
export interface DmrGrant {
	group: boolean;
	/** Talkgroup or called unit, -1 not known. */
	tg: number;
	/** Calling unit, -1 not known. */
	src: number;
	/** Logical (physical) channel number. */
	channel: number;
	/** Time slot 0 or 1. */
	slot: number;
	emergency: boolean;
	data: boolean;
}

/** The Tier III system identity of a C_ALOHA (TS 102 361-4 system code). */
export interface DmrSystemCode {
	model: string;
	/** Network and site as the radios display them (counted from 1). */
	net: number;
	site: number;
	/** Partition: 'A', 'B', 'AB' or 'reserved'. */
	par: string;
	/** The 14 bit code. */
	code: number;
}

/** A data message being assembled from its header and blocks. */
export interface DmrAssembler {
	active: boolean;
	hdr: DataHeader;
	/** Data type of the blocks (0 until the first block). */
	dt: number;
	bytes: number[];
	got: number;
	confirmed: boolean;
	crcAllOk: boolean;
	/** A proprietary header after the first one: its ten octets, counted as a block. */
	prop: Uint8Array | null;
}

/** A completed data message: its format and text, whether its CRC held, and the position it carries ('LRRP' / 'NMEA'). */
export interface DmrMessageResult {
	format: string;
	text: string;
	crcOk: boolean;
	location: DmrLocation | null;
	source: string;
}

/** The voice call on a slot. */
export interface DmrSlotCall {
	kind: 'group' | 'private' | 'all call';
	src: number;
	dst: number;
	idsKnown: boolean;
	emergency: boolean;
	privacy: boolean;
	lateEntry: boolean;
	alias: string;
}

/** What the link keeps per time slot (OnAir's Track, less the timing). */
export interface DmrSlotState {
	/** Colour code of the slot from checked data bursts (-1 not known). */
	cc: number;
	/** Voice burst position (0..5, A..F) of the last voice burst, -1 none. */
	vpos: number;
	misses: number;
	/** Embedded LC fragments received in order (LCSS 1, 3, 3, 2). */
	lcHave: number;
	lcFrag: Uint8Array[];
	/** The last embedded LC (IDs + service options), to confirm risky changes. */
	embPendKey: string;
	ta: TalkerAlias;
	msg: DmrAssembler;
	inCall: boolean;
	call: DmrSlotCall;
	alias: string;
	lastCsbkKey: string;
	lastCsbkSec: number;
	/** The call a terminator ended, to recognise the repeats of hang time. */
	lastTermKey: string;
	lastTermSec: number;
}

/** A call identity learned from the embedded LC (late entry), for the call line of the panel. */
export type DmrLateCall = DmrLinkControl & { slot: number; at: number };

/** What DMR decoding reports beside the call header, for the DSD panel. */
export interface DmrInfo {
	/** Talker alias of the current or last call. */
	alias?: { text: string; slot: number; src: number };
	/** The last position: LRRP, NMEA or the GPS info of the embedded LC. */
	position?: DmrPosition;
	/** The last text message (short data, Motorola TMS, Hytera text). */
	message?: { text: string; format: string; src: number; dst: number; group: boolean; slot: number; crcOk: boolean; at: number };
	/** Trunking system and site: Tier III, Capacity Plus, Connect Plus or Hytera XPT. */
	system?: { kind: string; text: string; at: number };
	/** The last channel grant or control block, in words. */
	control?: { text: string; slot: number; at: number };
	/** Short LC of the CACH (activity of both slots). */
	activity?: string;
	/** Recent calls, messages, positions and grants, newest first (at most DMR_EVENT_LIMIT). */
	events: DmrEvent[];
}

export interface DmrPosition {
	lat: number;
	lon: number;
	/** 'LRRP', 'NMEA' or 'GPS LC'. */
	source: string;
	src: number;
	slot: number;
	speedKmh?: number;
	headingDeg?: number;
	radiusM?: number;
	at: number;
}

export interface DmrEvent {
	kind: 'call' | 'alias' | 'message' | 'position' | 'grant' | 'control' | 'data';
	slot: number;
	text: string;
	at: number;
}

/** One frame of the DSD stream as the DMR frame handler (dsd-dmr.ts) reads it. */
export interface DmrFrame {
	dibits: Uint8Array;
	/** Symbol values beside the dibits (Hz), for the soft decisions. */
	symbols: Float32Array;
	mask: number;
	/** Absolute dibit count just after the sync word. */
	afterSync: number;
	voice: boolean;
	/** A base station sync: the bursts have a CACH in front. */
	bs: boolean;
	/** Slot from the sync word or the CACH (0 or 1). */
	slot: number;
	mbelibReady: boolean;
	audio: (samples: Float32Array) => void;
}
