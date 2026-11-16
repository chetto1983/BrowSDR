// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/include/dect2/marine/marine_fax.h (FaxStatus),
// core/src/marine/marine_fax.cpp (decoder data shapes) and core/include/dect2/marine/marine_wefax_stations.h
// (WefaxStation, WefaxBroadcast, WefaxNext), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: imageSeq is left out (the picture keeps its own change marks); WefaxNext names its fields in full.

/** 0 waiting for the start tone, 1 phasing, 2 receiving, 3 stopped. */
export type FaxState = 0 | 1 | 2 | 3;

export interface FaxStatus {
	state: FaxState;
	ioc: number;
	lpm: number;
	lines: number;
	/** Correction in use, ppm. */
	slantPpm: number;
	/** Last tone measured (start/stop detection, tuning aid). */
	toneHz: number;
	/** Tones: tone power over total audio power; phasing: 400 Hz swing over the noise of the black level. */
	snrDb: number;
	/** Black level measured in the phasing (1500 when nothing measured yet): the mistuning aid. */
	blackHz: number;
	/** Phasing lines used to lock the line start. */
	phasingLines: number;
	/** Image width in pixels (0 until an image starts). */
	width: number;
}

/** A white phasing pulse: centre and width, in audio samples. */
export interface FaxPulse {
	c: number;
	w: number;
}

/** A line rate the free-running search found: correlation one line later and the period, samples. */
export interface FaxCandidate {
	lpm: number;
	r: number;
	P: number;
}

/** One window of the tone detector: 1 the 300 Hz start tone, 2 the 675 Hz one, 3 the 450 Hz stop tone, 0 none. */
export interface FaxToneReading {
	kind: 0 | 1 | 2 | 3;
	/** Strongest frequency, Hz. */
	fTone: number;
	/** Its share of the audio power. */
	r: number;
}

/** A start (1: 300 Hz, IOC 576; 2: 675 Hz, IOC 288) or stop (3: 450 Hz) tone that has lasted long enough. */
export interface FaxToneEvent {
	kind: 1 | 2 | 3;
	/** First sample of the analysis window where the tone began. */
	onset: number;
	/** Mean measured frequency minus the nominal one, Hz. */
	offsetHz: number;
}

/** Why a picture ended: stop tone, a new start tone, the line limit, or the receiver was reset. */
export type FaxEnd = 'stop' | 'start' | 'limit' | 'reset';

/** An HF radiofax station. */
export interface WefaxStation {
	/** Short key, e.g. "DDK". */
	id: string;
	name: string;
	callsign: string;
	country: string;
	/** Europe, North America, Asia, Oceania, South America, Africa. */
	region: string;
	/** The assigned (carrier) frequencies, kHz; the USB dial is 1.9 kHz below. */
	carrierKhz: readonly number[];
}

/** A scheduled chart. */
export interface WefaxBroadcast {
	/** WefaxStation id. */
	station: string;
	/** Start, minutes after 00:00 UTC. */
	utcMin: number;
	lpm: number;
	ioc: number;
	product: string;
	/** The time or the product is known only roughly. */
	approximate: boolean;
}

/** A coming broadcast with its station and start time (Unix seconds). */
export interface WefaxNext {
	broadcast: WefaxBroadcast;
	station: WefaxStation;
	startUtc: number;
}
