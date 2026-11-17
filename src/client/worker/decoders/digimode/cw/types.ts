// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/include/dect2/cw/cw_decoder.h (DecTok, FistStats),
// core/src/cw/cw_decoder.cpp (Ev, the prior of a lost lock), core/src/cw/cw_lm.cpp (Model) and
// core/include/dect2/cw/cw_tel.h (CwSignal), https://github.com/adswill/OnAir; see third_party/onair. Changes: the
// histograms of FistStats and the report-only members of CwSignal (text, calls, times) are left out; the events of the
// skimmer are BrowSDR's.

/** One committed character: "A", "5", "<AR>", " " (word space), "*" (not in the table). */
export interface DecTok {
	text: string;
	/** 0 .. 100. */
	conf: number;
	/** The best other reading ('' none worth showing). */
	alt: string;
}

/** A key-down (on) or key-up of `ms` milliseconds. */
export interface CwEv {
	on: boolean;
	ms: number;
}

/** The classes of a sender (ln ms, offsets from the dot), kept when a lock is lost. */
export interface FistClasses {
	L: number;
	ldr: number;
	gi: number;
	gc: number;
	gw: number;
	sd: number;
	sD: number;
	si: number;
	sc: number;
	sw: number;
}

/** The sender learned by the adaptive decoder. */
export interface FistStats {
	locked: boolean;
	wpm: number;
	dotMs: number;
	/** Dash / dot. */
	dashRatio: number;
	intraGapDots: number;
	charGapDots: number;
	wordGapDots: number;
	/** 0 .. 1: how steady the keying is (1 = a machine). */
	quality: number;
	/** Mean squared z of the marks: ~1 when the model fits. */
	fit: number;
}

/** What the status line and the records show of a CW signal. */
export interface CwSignalInfo {
	/** From the dial, Hz. */
	hz: number;
	/** 0 until the speed is known. */
	wpm: number;
	/** Mark level over the noise in the signal's 100 Hz filter, dB. */
	snrDb: number;
	/** The speed is known: text is coming. */
	locked: boolean;
	/** The gaps are longer than the characters' speed asks. */
	farnsworth: boolean;
}

/** What a signal of the skimmer reports. */
export interface CwEvents<C = unknown> {
	/** Committed characters. */
	onText(chan: C, toks: DecTok[]): void;
	/** The signal was dropped (silent too long, or merged into another). */
	onRemoved(chan: C): void;
}

/** The character trigram and the word list of amateur traffic. */
export interface CwLanguageModel {
	/** ln P(c | c2 c1) at [(c2 * N + c1) * N + c]. */
	logp: Float32Array;
	/** The word list, each once. */
	words: Set<string>;
}
