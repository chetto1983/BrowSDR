// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/include/dect2/tones/tones_proto.h (SeqSet, DcsHit) and tones_tel.h
// (ToneEvent), https://github.com/adswill/OnAir; see third_party/onair. Changes: an event carries what the record shows
// (system, label, measured CTCSS frequency) and is handed to a sink when it begins and when it ends.

/** A five-tone sequential plan: digits 0 .. 9 and the repeat tone "E". */
export interface SeqSet {
	id: string;
	name: string;
	digit: readonly number[];
	rep: number;
	/** The usual tone length, ms (a hint: lengths are vendor specific). */
	toneMs: number;
}

/** A DCS word read in one of its 23 rotations and either polarity. */
export interface DcsHit {
	/** As written (23 for 023). */
	code: number;
	/** Sent with inverted polarity (the "I" codes). */
	inverted: boolean;
	standard: boolean;
	/** The same waveform also reads as this code (-1: none) ... */
	aliasCode: number;
	/** ... with this polarity. */
	aliasInverted: boolean;
}

/** OnAir's ToneKind. */
export type ToneKind = 'ctcss' | 'dcs' | 'dtmf' | 'seq' | 'selcal' | 'twoTone';

/** One detection: a sub-audible tone or code that came and went, a key press string, a call. */
export interface ToneEvent {
	kind: ToneKind;
	/** Record prefix: "CTCSS", "DCS", "DTMF", "ZVEI1", "SELCAL", "Two-tone". */
	system: string;
	/** OnAir's text: "100.0 Hz", "D023N", "1234#", "12345", "AB-CD", "1000.0 + 1500.0 Hz". */
	text: string;
	/** What the record line shows after the system: "100.0 Hz", "023 (inverted)", ... */
	label: string;
	/** Standard, tone length, the other readings. */
	detail: string;
	/** Signal seconds when it began. */
	timeSec: number;
	durSec: number;
	/** 0 dB = 5 kHz deviation. */
	levelDb: number;
	/** Still present. */
	active: boolean;
	/** CTCSS: the measured tone frequency. */
	measuredHz?: number;
}

/** Where the detectors hand their events. */
export interface ToneEventSink {
	/** An event that lasts (a sub-audible tone or code, DTMF keys, a two-tone page) has begun. */
	begin(event: ToneEvent): void;
	/** An event is complete (active is false). */
	end(event: ToneEvent): void;
}

/** A sequential tone heard: index into the tone pool and its length. */
export interface SeqSegment {
	pool: number;
	dwellMs: number;
}
