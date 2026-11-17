// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/include/dect2/dstar/dstar_proto.h (Header, Fix) and
// core/include/dect2/dstar/dstar_tel.h (DstarPosition, DstarCall), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the status keeps what BrowSDR's DSD panel shows of the current (or last) transmission with a short event list
// instead of OnAir's call log, message and position lists; the per-front-end state of OnAir's receiver is left out.
import type { DsdEvent } from '@/worker/decoders/dsd/types';

/** The radio header (JARL D-STAR specification): flags, the four callsigns and MY's suffix, space padding removed. */
export interface DstarHeader {
	flag: number[];
	/** Repeater 2 (the gateway), repeater 1 (the local repeater), your call, my call (8 characters each), suffix (4). */
	rpt2: string;
	rpt1: string;
	ur: string;
	my: string;
	sfx: string;
}

/** A position from the slow data: an NMEA sentence or a D-PRS (APRS) line. */
export interface DstarFix {
	lat: number;
	lon: number;
	altM: number;
	speedKmh: number;
	course: number;
	altValid: boolean;
	velValid: boolean;
	/** D-PRS: the APRS source and the text after the position. */
	call: string;
	comment: string;
	aprs: boolean;
}

/** The last position heard, with whose it is. */
export interface DstarPosition {
	/** MY of the transmission, or the D-PRS source. */
	call: string;
	lat: number;
	lon: number;
	altM?: number;
	speedKmh?: number;
	course?: number;
	/** From a D-PRS (APRS) line, else NMEA. */
	dprs: boolean;
	comment: string;
}

/** What BrowSDR's DSD panel shows of a D-STAR transmission: the one on air, or the last one. */
export interface DstarStatus {
	/** My call with its suffix, your call, repeaters 1 and 2 ('' until known). */
	my: string;
	sfx: string;
	ur: string;
	rpt1: string;
	rpt2: string;
	/** The three flag bytes and their meaning ("via repeater", "EMERGENCY" ...). */
	flag: number[];
	flags: string;
	/** The radio header passed its CRC; or the header came from the slow data resend. */
	headerOk: boolean;
	headerFromSlow: boolean;
	/** Found from the data sync in the middle of the call. */
	lateEntry: boolean;
	active: boolean;
	/** The end-of-transmission pattern ended it (else the signal was lost). */
	endSeen: boolean;
	/** The 20-character slow data message and which of its four blocks arrived (bits). */
	text: string;
	textBlocks: number;
	/** The last GPS line of the slow data, and the last position that parsed. */
	gps: string;
	position?: DstarPosition;
	/** Digital code squelch, -1 none. */
	squelch: number;
	voiceFrames: number;
	durSec: number;
	/** Channel bit errors: header (corrected by its FEC) and data syncs. */
	berPct: number;
	inverted: boolean;
	/** Newest first, at most 20: headers, messages, positions and ends. */
	events: DsdEvent[];
}

/** One D-STAR transmission as the receiver follows it (OnAir DstarCall). */
export interface DstarTx extends DstarStatus {
	syncOk: number;
	syncMiss: number;
}
