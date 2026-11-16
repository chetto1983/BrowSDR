// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/include/dect2/marine/marine_tel.h (DscCall) and marine_dsc.h,
// https://github.com/adswill/OnAir; see third_party/onair.

/** One DSC call (ITU-R M.493). Codes are the symbol numbers of the recommendation; -1 = not in the call or unreadable. */
export interface DscCall {
	format: number;
	formatName: string;
	category: number;
	categoryName: string;
	from: string;
	/** MMSI of the called station, the area, or "all ships". */
	to: string;
	distress: boolean;
	nature: number;
	natureName: string;
	position: { lat: number; lon: number; text: string } | null;
	time: string | null;
	telecommand1: number;
	telecommand2: number;
	telecommandText: string;
	freqRx: string;
	freqTx: string;
	/** Station in distress, for acknowledgements and relays. */
	distressMmsi: string;
	/** 117 acknowledgement requested, 122 acknowledgement, 127 other. */
	eos: number;
	eccOk: boolean;
	erasures: number;
	/** Symbols taken from the second copy or rebuilt with the check character. */
	repaired: number;
	kind: string;
	text: string;
}

/** One received symbol: its number (-1 unreadable) and how sure the weakest of its bits was. */
export interface DscSymbol {
	s: number;
	conf: number;
}

/** The readings of one information symbol: the DX copy first, then a different RX copy. */
export interface DscCandidates {
	v: number[];
	conf: number;
}

/** The parts of a call that say what kind of call it is. */
export type DscKindInput = Pick<DscCall, 'format' | 'formatName' | 'category' | 'telecommand1' | 'eos' | 'position'>;
