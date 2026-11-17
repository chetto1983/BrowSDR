// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/include/dect2/hfdig/hfdig_rtty.h (RttyAutoHyp, HfdigRttyTelemetry)
// and core/include/dect2/autoparam/autoparam.h (FskPair, FskBaud), https://github.com/adswill/OnAir; see
// third_party/onair. Changes: the telemetry keeps only what the status line and the records show; the settings and
// the receiver's options are BrowSDR's.

/** One guess of the signal's parameters (rttyAutoAnalyse): tones, shift, speed and polarity, and how the text came out. */
export interface RttyAutoHyp {
	/** The lower tone, Hz. */
	lowHz: number;
	shiftHz: number;
	baud: number;
	shiftIdx: number;
	baudIdx: number;
	/** The mark is the upper tone. */
	reverse: boolean;
	/** Good characters less 2.5 per framing error. */
	score: number;
	chars: number;
	errors: number;
}

/** Two spectral lines a known shift apart. */
export interface FskPair {
	lowHz: number;
	shiftHz: number;
	shiftIdx: number;
	/** The weaker line against the floor. */
	score: number;
}

/** The symbol rate of an FSK pair: indices into the caller's table (-1 none). */
export interface FskBaud {
	best: number;
	second: number;
	/** 0 .. 1: margin of the best over the second. */
	confidence: number;
}

/** Speed, shift and polarity of the decoder (indices into RTTY_BAUDS and RTTY_SHIFTS). */
export interface RttySettings {
	baudIdx: number;
	shiftIdx: number;
	/** The mark is the upper tone. */
	reverse: boolean;
	/** A space returns the figures shift to letters. */
	unshift?: boolean;
}

export interface RttyOptions {
	/** Where the decoder starts; Auto moves it when the signal says otherwise. */
	start: RttySettings;
	/** Speed, shift and polarity follow the signal (OnAir's receiver: on). */
	auto?: boolean;
	/** Time spent on the Auto analysis per block of audio, ms (tests: Infinity, so it runs at once). */
	sliceMs?: number;
}

/** What the decoder shows (HfdigRttyTelemetry). */
export interface RttyStatus {
	/** 0 searching, 1 locked to a pair of tones, 2 receiving characters. */
	state: number;
	markHz: number;
	spaceHz: number;
	baud: number;
	shiftHz: number;
	reverse: boolean;
	/** 0 .. 1. */
	quality: number;
	chars: number;
	framingErrors: number;
}
