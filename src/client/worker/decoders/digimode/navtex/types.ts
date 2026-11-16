// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/include/dect2/marine/marine_tel.h (NavtexMessage),
// marine_navtex.h (Slot) and marine_dsp.h (Spectrum::Fsk), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the report-only members (repeats, receive times, text cut) are left out.

/** One NAVTEX message (ITU-R M.540): ZCZC B1 B2 B3 B4, text, NNNN. */
export interface NavtexMessage {
	/** B1: transmitter identity A..Z ('?' when the character was damaged). */
	station: string;
	/** B2: A navigational warning, B meteorological warning, C ice, D search and rescue, E forecast, ... */
	subject: string;
	/** B3 B4: 00 (urgent) .. 99, -1 when damaged. */
	number: number;
	subjectName: string;
	/** As received, e.g. "EA01" ('*' where a character could not be read). */
	header: string;
	/** Body, lines separated by '\n', '*' where a character could not be read. */
	text: string;
	/** Body characters and unreadable ones (header included in the errors). */
	chars: number;
	errors: number;
	/** Character error rate: errors / (chars + 4). */
	cer: number;
	/** NNNN was received. */
	complete: boolean;
}

/** One 7-bit place of the SITOR-B stream: the code word, its bits as received and how sure each was. */
export interface NavtexSlot {
	code: number;
	valid: boolean;
	bit: Uint8Array;
	conf: Float64Array;
	/** Bit count at the end of the word. */
	endBit: number;
}

/** The FSK pair found in the spectrum: centre (Hz from the tuned frequency), level over the noise and the tones. */
export interface FskInfo {
	found: boolean;
	centreHz: number;
	levelDb: number;
	snrDb: number;
	highHz: number;
	lowHz: number;
}
