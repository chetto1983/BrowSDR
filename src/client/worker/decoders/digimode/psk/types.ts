// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/include/dect2/psk/psk_tel.h (kPskModes, pskModeName, pskBaud,
// pskQpsk), https://github.com/adswill/OnAir; see third_party/onair. Changes: the modulations are records; fldigi's
// 8PSK125 and 8PSK250 (mode numbers 7 and 8) are not ported.

/** A PSK modulation (OnAir's mode number, name, symbol rate). */
export interface PskMode {
	id: number;
	name: string;
	baud: number;
	/** QPSK with the K = 5 convolutional code; else BPSK. */
	qpsk: boolean;
}

/** What a signal of the receiver reports (its text is kept by the caller). */
export interface PskEvents<C = unknown> {
	/** A character: code 0 .. 127, or -2 for a code not in the table. */
	onChar(chan: C, ch: number): void;
	/** The DCD dropped: the line ends. */
	onDcdLost(chan: C): void;
	/** The signal was dropped (silent too long, or merged into another). */
	onRemoved(chan: C): void;
}

/** What the status line and the records show of a signal. */
export interface PskSignalInfo {
	/** Audio frequency, Hz above the dial (where the AFC has it now). */
	hz: number;
	/** How far the AFC moved it from where it was found, Hz. */
	afcHz: number;
	/** In the signal's bandwidth, dB. */
	snrDb: number;
	/** 0 .. 1: how clean the phase decisions are. */
	quality: number;
	dcd: boolean;
}
