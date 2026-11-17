// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/include/dect2/fusion/fusion_proto.h (Fich, VoiceUnit, FrameContent)
// and fusion_gps.h (YsfGps), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: bits and bytes are typed arrays; a V/D mode 2 voice unit also carries the majority-vote disagreements, and
// the receiver state for the DSD stream is described here.

/** Frame information channel (Yaesu Amateur Radio Digital Specs, section 3). */
export interface YsfFich {
	/** Frame type: 0 header, 1 communication, 2 terminator, 3 test. */
	fi: number;
	/** Callsign information (2: callsigns 1, 2 and 3). */
	cs: number;
	/** Call mode: 0 group / CQ, 3 individual. */
	cm: number;
	/** Block number and total. */
	bn: number;
	bt: number;
	/** Frame number and total. */
	fn: number;
	ft: number;
	/** Message routing: 0 direct, 1 downlink (uplink idle), 2 downlink (uplink busy). */
	mr: number;
	/** 0 local, 1 via internet. */
	voip: number;
	/** Data type: 0 V/D mode 1, 1 data FR, 2 V/D mode 2, 3 voice FR. */
	dt: number;
	/** 0 squelch code enabled, 1 disabled. */
	sqlOff: number;
	/** Squelch code (DG-ID): 0 none, 1..126, 127 break-out. */
	sqlCode: number;
}

/** A voice sub-frame as it was sent. */
export interface YsfVoiceUnit {
	/** 1 V/D mode 1 channel frame (72 bits), 2 V/D mode 2 (49 bits, error-corrected), 3 voice FR channel frame (144 bits). */
	kind: number;
	/** 9, 7 (49 bits, MSB first, 7 bits of padding) or 18 bytes. */
	bytes: Uint8Array;
	/** V/D mode 2: repeated voice bits whose three copies disagreed. */
	errors?: number;
}

export interface YsfFrameContent {
	fich: YsfFich;
	fichOk: boolean;
	fichFixes: number;
	/** DCH units in the order they are sent (20 or 10 bytes each). */
	units: Uint8Array[];
	/** Decode only: the unit's CRC passed. */
	unitOk: boolean[];
	voice: YsfVoiceUnit[];
}

export interface YsfGps {
	ok: boolean;
	lat: number;
	lon: number;
	radio: string;
}

/** A frame read from the stream: levels fitted and sliced, as OnAir's FusionReceiver::tryFrame does. */
export interface YsfFrameRead {
	content: YsfFrameContent;
	/** Symbol SNR in dB from the fit residual. */
	snrDb: number;
	/** The spectrum is mirrored (negative level gain). */
	inverted: boolean;
}
