// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/include/dect2/dpmr/dpmr_proto.h (Header, Cch, End),
// and core/include/dect2/dpmr/dpmr_tel.h (DpmrCall), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: ids are numbers (-1: not known yet); the receiver's events for BrowSDR's DSD decoder are described here.
import type { DpmrStatus, SyncType } from '@/worker/decoders/dsd/types';

/** Header information (HI0 / HI1). */
export interface DpmrHeader {
	/** 0 call, 1 connection request, 2 unconnect, 3 acknowledge, 4 system request, 5 status. */
	type: number;
	/** 24-bit ids. */
	called: number;
	own: number;
	/** 0 voice, 1 voice + slow data, 2 data type 1, 3 data type 2, 4 packet data, 5 voice + data. */
	commMode: number;
	/** 0 individual, 1 group, 2 all call. */
	callType: number;
	emergency: boolean;
	/** Status message: the status code; data: the block count. */
	extra: number;
}

/** Control channel of a payload frame. */
export interface DpmrCch {
	/** 0 to 3 in the superframe. */
	frame: number;
	/** 12 bits: called high, called low, own high, own low. */
	idPart: number;
	commMode: number;
	version: number;
	callType: number;
	emergency: boolean;
	/** 18 bits. */
	slowData: number;
}

export interface DpmrEnd {
	type: number;
	own: number;
}

/** One transmission: a voice call, a status message, a short message or packet data. */
export interface DpmrCallState {
	/** 0 voice, 1 status, 2 short message, 3 packet data. */
	kind: number;
	active: boolean;
	src: number;
	dst: number;
	callType: number;
	commMode: number;
	cc: number;
	emergency: boolean;
	lateEntry: boolean;
	endSeen: boolean;
	text: string;
}

/** What the dPMR receiver reports to the DSD decoder. */
export interface DpmrEvents {
	/** A block passed its CRC (or a transmission ended): the status to show, and the sync of that frame. */
	update(status: DpmrStatus, sync: SyncType): void;
	/** A voice call starts: the codec state is reset. */
	callStart(): void;
	/** 72 bits of an AMBE+2 voice frame, descrambled, in the order sent. */
	voice(bits: Uint8Array): void;
}

/** A sync pattern minus its mean, and the root of its sum of squares (for Pearson correlations). */
export interface DpmrCentred {
	sc: Float32Array;
	norm: number;
}

/** Receiver state: looking for a sync, reading a header, a payload frame or an end frame, or the next payload sync. */
export type DpmrMode = 'search' | 'header' | 'sync' | 'frame' | 'end';
