// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/include/dect2/aero/aero_phy.h (AeroFrameFormat, AeroDecodedFrame),
// aero_demod.h (AeroFrameEvent), aero_su.h (AeroSu, AeroAcars, AeroLogon, AeroSysInfo), aero_acars.h (AeroAcarsBlock),
// aero_adsc.h (AeroAdscPoint, AeroAdscRequest, AeroAdscMessage), aero_cpdlc.h (AeroCpdlcMessage), aero_pos.h
// (AeroPosition) and core/include/dect2/inmsat/inmsat_satid.h (SatDef), https://github.com/adswill/OnAir; see
// third_party/onair. Changes: byte buffers are Uint8Arrays; the CPDLC message keeps its body as hex (the ASN.1 body
// is not decoded here); the telemetry report, the aircraft table and the contract book are left out.

import type { DigimodeRecord } from '@/worker/decoders/digimode/types';

/** The frame of one P channel (aero_phy.h, after JAERO aerol.cpp setSettings). */
export interface AeroFrameFormat {
	bitRate: number;
	/** Channel bits of the unique word (32, or 64 when it is sent on both OQPSK arms). */
	uwBits: number;
	headerBits: number;
	/** Bits after the header that are not data (10500: 178). */
	skipBits: number;
	/** 1152 or 4992. */
	codedBits: number;
	/** Interleaver columns (rows are always 64). */
	cols: number;
	/** Interleaver blocks per frame. */
	blocks: number;
}

/** Soft data bits of one frame decoded to information bytes. */
export interface AeroDecodedFrame {
	header: number;
	bytes: Uint8Array;
	/** 12-byte SUs whose CRC holds / fails. */
	susOk: number;
	susBad: number;
	/** Decided bits re-encoded against the hard channel bits: the error rate before decoding. */
	channelBer: number;
}

/** A frame as the demodulator hands it on. */
export interface AeroFrameEvent extends AeroDecodedFrame {
	bitRate: number;
	/** Bit errors in the unique word, -1 when the frame was taken on timing alone. */
	uwErrors: number;
	/** Per channel bit. */
	ebn0Db: number;
	/** Carrier relative to the demodulator's input centre. */
	freqHz: number;
}

/** A signal unit: 10 bytes of message and the CRC. */
export interface AeroSu {
	type: number;
	typeName: string;
	bytes: Uint8Array;
	crcOk: boolean;
	/** ICAO 24-bit address when the SU carries one, else 0. */
	aesId: number;
	gesId: number;
}

/** An ACARS message reassembled from the user data SUs. */
export interface AeroAcars {
	aesId: number;
	gesId: number;
	/** Ground to aircraft (the block id is not a digit). */
	uplink: boolean;
	mode: string;
	registration: string;
	label: string;
	labelText: string;
	blockId: string;
	msgNo: string;
	flight: string;
	text: string;
	/** Block checks and parity held (true for non-ACARS user data, whose SU checks held). */
	crcOk: boolean;
	/** BrowSDR's reading of fixed-format text (OOOI times, media advisory), else "". */
	decoded: string;
	/** H1 sublabel and message function identifier, "" when none. */
	sublabel: string;
	mfi: string;
	/** User data that is not an ACARS block (shown as hex). */
	binary: boolean;
}

export interface AeroLogon {
	aesId: number;
	gesId: number;
	/** false: log-off. */
	logon: boolean;
}

/** System information of the P channel system table SUs (JAERO's reading). */
export interface AeroSysInfo {
	/** 0 none, 1 GES channels (0x05), 2 satellite id (0x0C), 3 P/R channel control (0x40). */
	kind: number;
	gesId: number;
	seq: number;
	/** Kind 1: which group of three channels this SU carries. */
	lsu: number;
	satId: number;
	/** Kind 2, east positive, -180..180. */
	lonDeg: number;
	/** Kind 3: bit/s, 0 when the code is not known. */
	bitRate: number;
	/** Kind 1: three channels in the order of `names`; kind 2: Psmc1, Psmc2; kind 3: [0] = P channel. */
	freqMHz: [number, number, number];
	spotBeam: boolean;
	names: string;
}

/** One ACARS block of the user data of an ISU (aero_acars.h). */
export interface AeroAcarsBlock {
	mode: string;
	/** As sent: 7 characters, padded with '.' in front. */
	registration: string;
	tak: number;
	/** Two characters; a DEL as second character shows as 'd'. */
	label: string;
	blockId: number;
	text: string;
	hasText: boolean;
	/** Ended with ETB: the message continues in the next block. */
	moreToCome: boolean;
	parityOk: boolean;
	crcOk: boolean;
	/** BrowSDR's ACARS reading of the block: downlink message number and flight, sublabel, MFI, fixed-format text. */
	msgNo: string;
	flight: string;
	sublabel: string;
	mfi: string;
	decoded: string;
}

/** An ISU being assembled. */
export interface AeroIsu {
	aes: number;
	ges: number;
	qno: number;
	refno: number;
	/** SSUs still to come. */
	remaining: number;
	lastOctets: number;
	data: number[];
	t: number;
}

/** An ACARS message whose last block ended with ETB. */
export interface AeroFragment {
	msg: AeroAcars;
	tak: number;
	lastBi: number;
	t: number;
}

export interface AeroAdscPoint {
	lat: number;
	lon: number;
	altFt: number;
	etaSec: number;
}

/** One uplink group of a ground system: a contract request or cancellation. */
export interface AeroAdscRequest {
	/** 1 cancel all and disconnect, 2 cancel a contract, 6 cancel emergency mode, 7 periodic, 8 event, 9 emergency periodic. */
	kind: number;
	contract: number;
	intervalSec: number;
	/** Groups asked for: 12 flight id, 13 predicted route, 14 earth, 15 air, 16 meteo, 17 airframe id, 21 intent. */
	groups: number[];
	latDevNm: number;
	vsFpm: number | null;
	altRange: [ceilingFt: number, floorFt: number] | null;
	waypoint: boolean;
}

/** An ARINC 622 ADS-C application in an ACARS text (aero_adsc.h AeroAdscMessage). */
export interface AeroAdscMessage {
	found: boolean;
	/** IMI "DIS" (a reason code only). */
	disconnect: boolean;
	uplink: boolean;
	crcOk: boolean;
	/** Every group was read to the end of the binary part. */
	complete: boolean;
	groundAddr: string;
	airReg: string;
	tags: number[];
	hasPos: boolean;
	posTag: number;
	lat: number;
	lon: number;
	/** Seconds past the hour. */
	timeSec: number;
	altFt: number;
	/** Figure of merit: position accuracy code 0..7. */
	accuracy: number;
	redundancyOk: boolean;
	tcasOk: boolean;
	flightId: string;
	icao: number;
	route: [AeroAdscPoint, AeroAdscPoint] | null;
	earth: { trackDeg: number; groundKt: number; valid: boolean; vsFpm: number } | null;
	air: { headingDeg: number; mach: number; valid: boolean; vsFpm: number } | null;
	meteo: { windKt: number; windDeg: number; valid: boolean; tempC: number } | null;
	reason: number;
	requests: AeroAdscRequest[];
	acks: number[];
	nacks: Array<[contract: number, reason: number]>;
}

/** An ARINC 622 FANS-1/A CPDLC application in an ACARS text (aero_cpdlc.h). */
export interface AeroCpdlcMessage {
	/** "AT1", "CR1", "CC1" or "DR1". */
	imi: string;
	groundAddr: string;
	reg: string;
	crcOk: boolean;
	/** The ASN.1 PER body without the CRC, as hex. */
	bodyHex: string;
}

/** A position from an Aero message (aero_pos.h). */
export interface AeroPosition {
	/** 1 ADS-C, 2 text report. */
	source: number;
	kind: string;
	lat: number;
	lon: number;
	altFt: number | null;
	/** Track over the ground (ADS-C earth reference) or true heading (air reference). */
	trackDeg: number | null;
	speedKt: number | null;
	/** ADS-C time stamp, seconds past the hour. */
	secPastHour: number;
	/** Text reports: HHMMSS of the report, UTC. */
	secOfDay: number;
	flightId: string;
	icao: number;
	emergency: boolean;
}

/** A carrier of the band search: centre, width and peak over the noise floor. */
export interface AeroRegion {
	freq: number;
	width: number;
	peakDb: number;
}

/** A geostationary satellite that carries Aero P channels (inmsat_satid.h SatDef). */
export interface AeroSatellite {
	name: string;
	/** East positive. */
	lonDeg: number;
	/** MHz, the 600 / 1200 bit/s P channels and the 10500 bit/s ones (0 = no published list). */
	p600: [number, number];
	p10500: [number, number];
}

/** Labelled lines of a record. */
export type AeroFields = Array<[label: string, value: string]>;

/** Where a message was heard: the carrier against the VFO, its bit rate and Eb/N0. */
export interface AeroHeard {
	channel: number;
	offsetHz: number;
	bitRate: number;
	ebn0Db: number;
}

/** What the receiver hands on. */
export interface AeroReceiverEvents {
	/** Every decoded frame (for the tests). */
	frame?(event: AeroFrameEvent, heard: AeroHeard): void;
	acars(m: AeroAcars, heard: AeroHeard): void;
	logon(l: AeroLogon, heard: AeroHeard): void;
	/** A system table fact (satellite id, P/R channel control) heard for the first time. */
	system(info: AeroSysInfo, heard: AeroHeard): void;
	/** A carrier found its rate. */
	channel(heard: AeroHeard): void;
}

/** A record as the decoder hands it to the log. */
export type AeroRecord = Omit<DigimodeRecord, 'id' | 'time' | 'mode'>;
