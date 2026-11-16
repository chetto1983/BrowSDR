// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/include/dect2/dab/dab_proto.h (Fig01Sub, Fig02Comp, Fig02Service,
// Fig1Label) and core/include/dect2/dab/dab_tel.h (DabSubchannel, DabService), https://github.com/adswill/OnAir; see
// third_party/onair. Changes: only the fields the BrowSDR receiver uses.

/** One FIG of a FIB: its type and the data field (header byte first) at fib[off .. off + len). */
export type FigVisitor = (type: number, off: number, len: number) => void;

/** FIG 0/1 sub-channel organisation, as sent. */
export interface FigSubchannel {
	id: number;
	start: number;
	eep: boolean;
	uepTable: boolean;
	option: number;
	level: number;
	size: number;
	uepIndex: number;
}

/** FIG 0/2 service component. tmid 0 stream audio (ascty), 1 stream data (dscty), 3 packet data (scid). */
export interface FigComponent {
	tmid: number;
	ascty: number;
	dscty: number;
	subId: number;
	scid: number;
	primary: boolean;
}

export interface FigService {
	sid: number;
	comps: FigComponent[];
}

/** FIG 1 label: the 16 label bytes start at d[off] (d = the FIG data field). */
export interface FigLabel {
	ext: number;
	charset: number;
	sid: number;
	scids: number;
	off: number;
}

/** A sub-channel of the ensemble with its size and bit rate from the protection tables. */
export interface Subchannel {
	id: number;
	start: number;
	size: number;
	eep: boolean;
	option: number;
	/** Protection level, 0-based (EEP 1..4, UEP 1..5). */
	level: number;
	uepIndex: number;
	bitrate: number;
}

export interface Service {
	sid: number;
	label: string;
	shortLabel: string;
	comps: FigComponent[];
}
