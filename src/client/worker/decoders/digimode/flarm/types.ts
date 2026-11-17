// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/include/dect2/flarm/flarm_proto.h (V6, DecodeResult),
// core/include/dect2/avroad/avroad_proto.h (OgnPacket), core/include/dect2/adsl/adsl_proto.h (Traffic, Status, Parsed)
// and the records of core/src/flarm/flarm_rx.cpp and core/src/adsl/adsl_rx.cpp (Cand, Pending, Rec),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: the decoder's options, counters, packet queue and
// the record of an aircraft are BrowSDR's (OnAir keeps an aircraft table and telemetry); only the M-band of ADS-L.

import type { FlarmChannel } from './channel';

/** The decrypted FLARM V6 position packet. */
export interface FlarmV6 {
	/** 24-bit device ID. */
	addr: number;
	type: number;
	addrType: number;
	/** 10-bit signed, 0.1 m/s >> smult. */
	vsRaw: number;
	airborne: boolean;
	stealth: boolean;
	noTrack: boolean;
	gps: number;
	aircraftType: number;
	/** Low bits of the position (128e-7 degrees); a reference position completes them. */
	lat19: number;
	lon20: number;
	/** Metres above the WGS-84 ellipsoid, 13 bits. */
	alt: number;
	smult: number;
	/** Four velocity samples, 0.25 m/s << smult, north and east. */
	ns: number[];
	ew: number[];
}

export type FlarmDecodeResult = 'ok' | 'notV6' | 'badParity';

/** The first packet of an aircraft, kept until a second one agrees (of a flagged one only its flags and position bits). */
export interface FlarmPending {
	t: number;
	flagged: boolean;
	acType: number;
	lat19: number;
	lon20: number;
	p?: FlarmV6;
	level: number;
	channel: number;
}

/** An aircraft whose packets agreed: its type and last position bits tell the right key time of the next one. */
export interface FlarmKnown {
	acType: number;
	lat19: number;
	lon20: number;
	lastSeen: number;
}

/** An OGN tracker packet (avroad_proto.h OgnPacket). */
export interface OgnPacket {
	address: number;
	addrType: number;
	other: boolean;
	encrypted: boolean;
	emergency: boolean;
	relay: number;
	addrParityOk: boolean;
	lat: number;
	lon: number;
	altM: number;
	speedMs: number;
	headingDeg: number;
	climbMs: number;
	turnDegS: number;
	acftType: number;
	fixQuality: number;
	second: number;
	stealth: boolean;
}

/** A packet that passed its check, waiting for the end of the input block (report.ts FrameQueue). */
export interface QueuedFrame {
	/** Protocol and bytes: the same packet heard twice has the same key. */
	key: string;
	/** Time of its last chip, s. */
	t: number;
	/** dB over the channel's noise. */
	level: number;
	apply(): void;
}

/** ADS-L Traffic payload (adsl_proto.h Traffic). */
export interface AdslTraffic {
	amt: number;
	addr: number;
	relay: boolean;
	/** Quarter seconds, 0 - 59. */
	timeQ: number;
	/** 0 undefined, 1 ground, 2 airborne. */
	flightState: number;
	category: number;
	emergency: number;
	hasPos: boolean;
	lat: number;
	lon: number;
	hasAlt: boolean;
	/** Metres above the WGS-84 ellipsoid. */
	altM: number;
	hasSpeed: boolean;
	speedMs: number;
	hasClimb: boolean;
	climbMs: number;
	hasTrack: boolean;
	trackDeg: number;
	sil: number;
	design: number;
	nic: number;
	hAcc: number;
	vAcc: number;
	velAcc: number;
}

/** ADS-L Status payload (adsl_proto.h Status). */
export interface AdslStatus {
	amt: number;
	addr: number;
	maxVersion: number;
	mRx: number;
	ldrRx: number;
	hdrRx: number;
	mobile: number;
	econRx: number;
	econTx: number;
	xpdr: number;
	trafficClient: boolean;
	fisClient: boolean;
}

export type AdslKind = 'bad' | 'reserved' | 'encrypted' | 'traffic' | 'status' | 'uplink' | 'other';

/** A network packet whose parity checked (adsl_proto.h Parsed). */
export interface AdslParsed {
	kind: AdslKind;
	version: number;
	keyIndex: number;
	type: number;
	signature: boolean;
	fec: boolean;
	relay: boolean;
	amt: number;
	addr: number;
	/** One for Traffic, up to ten for Traffic Uplink. */
	targets: AdslTraffic[];
	status?: AdslStatus;
}

/** A sync word found at one sampling phase: where the frame starts and how good the match was. */
export interface SyncCand {
	n: number;
	/** Sampling phase, 0 .. 7. */
	p: number;
	/** Chip index of the last sync chip. */
	k0: number;
	inv: boolean;
	err: number;
	score: number;
	/** ADS-L: bytes after the sync needed before the packet is decoded. */
	need: number;
}

/** What the channel hands to the protocol decoders: a sync whose chips are all in, or an OGN packet's bits. */
export interface ChipSink {
	flarmJob(channel: FlarmChannel, cand: SyncCand): void;
	adslJob(channel: FlarmChannel, cand: SyncCand): void;
	ognFrame(channel: number, bytes: Uint8Array, soft: Float32Array, sec: number, level: number): void;
}

/** What the protocol decoders need from the receiver. */
export interface ProtocolHost {
	readonly stats: FlarmStats;
	readonly options: FlarmOptions;
	/** The station, the reference of FLARM positions and of distances. */
	station(): LatLon | null;
	/** Unix seconds now: the computer's clock, or the time of the first sample plus the samples since (tests). */
	unixNow(tnow: number): number;
	report(key: string, report: AircraftReport, tnow: number): void;
	hide(key: string): void;
	queue(frame: QueuedFrame): void;
}

/** Receiver switches of OnAir's comparisons (FlarmReceiver::chaseOn, toneDetect). */
export interface FlarmOptions {
	/** Chase decoding of FLARM packets that fail the CRC. */
	chase: boolean;
	/** Chips from the tone energy at ±50 kHz (on) or from the FM discriminator (off). */
	toneDetect: boolean;
}

/** One protocol's counters. */
export interface FlarmCounts {
	ok: number;
	bad: number;
}

/** Counters of the receiver (OnAir's FlarmTelemetry, AdslTelemetry and the OGN facts). */
export interface FlarmStats {
	flarm: FlarmCounts & {
		perChannel: [number, number];
		newProtocol: number;
		newProtocolDevices: number;
		otherType: number;
		privacyFlagged: number;
		privacyPackets: number;
	};
	ogn: FlarmCounts & { repaired: number; encrypted: number; privacy: number };
	adsl: FlarmCounts & {
		traffic: number;
		status: number;
		uplink: number;
		encrypted: number;
		other: number;
		corrected: number;
		signed: number;
	};
}

export type AircraftProtocol = 'FLARM' | 'OGN' | 'ADS-L';

/** One aircraft as a record shows it. */
export interface AircraftReport {
	protocol: AircraftProtocol;
	/** Six hex digits. */
	id: string;
	idType: string;
	aircraft: string;
	lat?: number;
	lon?: number;
	altM?: number;
	climbMs?: number;
	speedKmh?: number;
	trackDeg?: number;
	channel: number;
	levelDb?: number;
	/** Protocol fields beyond the common ones. */
	extra: Array<[string, string]>;
	/** Not a position: a status or an encrypted packet. */
	note?: string;
	alert?: boolean;
}

/** A known aircraft: when it was last heard and reported. */
export interface AircraftEntry {
	lastSeen: number;
	lastReport: number;
	packets: number;
	report: AircraftReport;
}

export interface LatLon {
	lat: number;
	lon: number;
}
