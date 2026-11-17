// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/include/dect2/avroad/avroad_proto.h (FanetFrame) and the FANET
// settings of core/src/avroad/avroad_air.cpp (FanetDec::apply: SF7, 250 or 500 kHz, sync word 0xF1),
// https://github.com/adswill/OnAir; see third_party/onair. Format facts as credited there: the FANET protocol
// description (protocol.txt of Skytraxx's fanet-stm32, https://github.com/3s1d/fanet-stm32; format only, no code
// copied). Changes: optional fields for what BrowSDR reads beyond OnAir from the protocol description (turn rate and
// QNE offset of tracking, the online-tracking bit of ground tracking, the state of charge of a service frame, thermals
// and landmarks); the region bands (OnAir: 868.2 MHz at 250 kHz and 920.8 MHz at 500 kHz) and the decoder's counters.

/** A received FANET frame (OnAir's FanetFrame). Positions in degrees; `valid` when the payload fits its type. */
export interface FanetFrame {
	/** 0..63. */
	type: number;
	forward: boolean;
	manufacturer: number;
	/** 16-bit device number of the manufacturer. */
	device: number;
	unicast: boolean;
	hasSignature: boolean;
	destManufacturer: number;
	destDevice: number;
	hasPos: boolean;
	lat: number;
	lon: number;
	/** Tracking: 0 other, 1 paraglider ... 7 UAV. */
	aircraftType: number;
	altM: number;
	speedKmh: number;
	climbMs: number;
	headingDeg: number;
	/** Tracking and ground tracking: the sender allows online tracking. */
	online: boolean;
	/** A name, a message, or a description of the rest. */
	text: string;
	valid: boolean;
	/** Name and message frames: the text alone (OnAir's printable ASCII, other bytes as '.'). */
	name?: string;
	message?: string;
	/** Tracking: the optional turn rate (°/s, clockwise positive) and QNE offset (QNE - GPS altitude, m). */
	turnRateDegS?: number;
	qneOffsetM?: number;
	/** Ground tracking: the state (0 other, 1 walking ... 14 distress call). */
	groundType?: number;
	service?: FanetService;
	thermal?: FanetThermal;
	landmark?: FanetLandmark;
}

/** A service frame (type 4): an internet gateway or a weather station. */
export interface FanetService {
	gateway: boolean;
	remoteConfig: boolean;
	tempC?: number;
	/** Direction the wind blows from, degrees. */
	windDeg?: number;
	windKmh?: number;
	gustKmh?: number;
	humidityPct?: number;
	pressureHpa?: number;
	chargePct?: number;
}

/** A thermal (type 9): where it is, its top, the climb of the air and the wind there. */
export interface FanetThermal {
	/** 0..7 (0 % .. 100 %). */
	quality: number;
	altM: number;
	climbMs: number;
	windKmh: number;
	windDeg: number;
}

/** A landmark (type 5): a text, line, area, circle or 3D shape for the pilots' maps. */
export interface FanetLandmark {
	/** 0 text ... 9 3D cylinder. */
	subtype: number;
	/** 0 info, 1 warning, 2 keep out, 3 touch down, 4 no airspace warn zone, 15 don't care. */
	layer: number;
	ttlMin: number;
	/** Only shown with the wind from these sectors (bit 0 N ... bit 7 NW); undefined: always. */
	windSectors?: number;
	/** [latitude, longitude] of each point. */
	points: Array<[number, number]>;
	text?: string;
	/** Circles and cylinders: the radius of the first. */
	radiusM?: number;
	/** 3D shapes: the altitudes (m). */
	altBottomM?: number;
	altTopM?: number;
}

/** A FANET band: its LoRa bandwidth and the VFO channel the decoder receives (two samples per chip). */
export interface FanetBand {
	bwHz: number;
	rate: number;
}

/** What the receiver counted: good frames, CRC failures, frames that are not FANET, positions not shown. */
export interface FanetStats {
	frames: number;
	crcBad: number;
	invalid: number;
	/** Position frames with online tracking off (counted, never shown). */
	privacyFrames: number;
}

/** A record of the decoder before the radio fields are added. */
export interface FanetRecord {
	text: string;
	fields: Array<[string, string]>;
	alert?: boolean;
}
