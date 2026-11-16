// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/dab/dab_fec.cpp and core/include/dect2/dab/dab.h (puncturing
// geometry), https://github.com/adswill/OnAir; see third_party/onair.

/** `count` blocks of 128 mother-code bits punctured with PI_`pi`. */
export interface PunctureBlock {
	count: number;
	pi: number;
}

/** An EEP sub-channel: n units, bit rate in kbit/s, information bits of a logical frame. */
export interface EepGeometry {
	n: number;
	bitrate: number;
	infoBits: number;
}

/** A UEP sub-channel (EN 300 401 table 6): size in CUs, bit rate, protection level 1..5, information bits. */
export interface UepGeometry {
	size: number;
	bitrate: number;
	level: number;
	infoBits: number;
}

/** A row of EN 300 401 table 6: size, bitrate, level, L1..L4, PI1..PI4. */
export type UepRow = readonly [number, number, number, readonly number[], readonly number[]];

/** The depuncturing of one sub-channel profile: kept[k] is the mother-code position of received bit k. */
export interface SubchannelProfile {
	kept: Int32Array;
	/** Information bits of a logical frame. */
	infoBits: number;
	/** Bits of the sub-channel in a CIF (size * 64). */
	bits: number;
}
