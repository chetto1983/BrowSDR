// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/hfdig/hfdig_ftx_int.h (Spec, OsdStats) and
// core/include/dect2/hfdig/hfdig_ftx.h (FtxDecode), core/src/hfdig/hfdig_ftx.cpp (Layout, Job, XMem, the candidate and
// fit records of SlotDecoder), https://github.com/adswill/OnAir; see third_party/onair. Changes: only the FT8, FT4 and
// WSPR modes; the fields of the whole-span, spotting, Auto and early-decode features are left out.

/** 0 FT8, 1 FT4, 3 WSPR (OnAir's mode numbers; 2 FT2 and the WSJT-X family behind it are not ported). */
export type FtxMode = 0 | 1 | 3;

/** The timing of a mode. */
export interface FtxSpec {
	name: string;
	/** Slot, s. */
	period: number;
	/** Nominal start of the transmission in the slot, s. */
	t0: number;
	/** Symbol length, s. */
	symSec: number;
	/** Tone spacing, Hz. */
	spacing: number;
	/** Symbols sent (FT4: with the two ramp symbols). */
	nn: number;
	tones: number;
	/** GFSK bandwidth-time product (0 = plain FSK). */
	bt: number;
}

/** One decoded message of a slot. */
export interface FtxDecode {
	/** The start of the slot, UTC seconds since 1970. */
	slotUtc: number;
	mode: FtxMode;
	/** In 2500 Hz, as WSJT-X. */
	snrDb: number;
	/** The start against the nominal one (0.5 s into the slot, WSPR 1 s), s. */
	dt: number;
	/** Audio frequency of the lowest tone (mirrored: of tone 0, the highest). */
	hz: number;
	msg: string;
	/** Heard upside down (a lower sideband transmission). */
	mirrored: boolean;
	cq: boolean;
	/** The calling station and its locator when the message has them. */
	call: string;
	grid: string;
	/** WSPR: the power sent, dBm (-1 otherwise). */
	dbm: number;
	/** 0 first pass, 1 .. after subtracting the stronger signals. */
	pass: number;
	/** 0 from this slot alone, 1 with the soft bits of earlier slots added, 2 with the calls of a conversation taken as known. */
	how: number;
}

export interface OsdStats {
	hardErrors: number;
	/** The nearest codeword's distance, as a fraction of the total |llr|. */
	dist: number;
	/** How much farther the next one is, as a fraction of the total |llr|. */
	margin: number;
}

/** Where the symbols of a mode are and what the slot decoder searches. */
export interface FtxLayout {
	/** Samples per symbol at the mode's rate. */
	nsps: number;
	/** Decimation of the candidate's narrow baseband. */
	ndown: number;
	/** Tones. */
	nt: number;
	/** Symbols in the transmission (with ramps). */
	nsym: number;
	/** Bits per data symbol. */
	bits: number;
	rate: number;
	/** Tone spacing, Hz. */
	sp: number;
	/** (transmission symbol, tone) of the sync symbols. */
	sync: Array<[number, number]>;
	/** Transmission symbols carrying data, in order. */
	data: number[];
	/** Transmission symbol of tone index 0. */
	toneOff: number;
	dtMax: number;
	maxCand: number;
	passes: number;
}

/** One slot to decode. */
export interface FtxJob {
	mode: FtxMode;
	slotUtc: number;
	/** Time of x[0] against the start of the slot, s. */
	x0: number;
	x: Float32Array;
	dtMin: number;
	dtMax: number;
}

/** A sync peak: start frame, bin of tone 0 and score. */
export interface FtxCand {
	frame: number;
	bin: number;
	score: number;
}

/** The fit of a candidate: its narrow baseband, start and frequency (kept for the deep stage's frequency retries). */
export interface FtxFit {
	valid: boolean;
	yr: Float64Array;
	yi: Float64Array;
	kc: number;
	bestT: number;
	base: number;
	dfr: number;
	tfrac: number;
}

/** Soft bits of a candidate that did not decode, kept for the next slots. */
export interface FtxStored {
	mir: boolean;
	slotUtc: number;
	hz: number;
	dt: number;
	/** The three metrics' soft bits (plain, two- and three-symbol coherent). */
	l: [Float32Array, Float32Array, Float32Array];
}

/** "A B ...": A called B (or answered). */
export interface FtxPair {
	a: string;
	b: string;
	slotUtc: number;
}

/** "CQ X ..." heard. */
export interface FtxCaller {
	call: string;
	slotUtc: number;
}

/** An a-priori hypothesis: the bits [0, lo) and [74, 77) taken as known; pair: lo = 58 (both calls). */
export interface FtxApHyp {
	bits: Uint8Array;
	lo: number;
	pair: boolean;
}

/** What a candidate's tones gave: the per-symbol tone amplitudes, complex correlations and the symbols lost (none here). */
export interface FtxSymbols {
	amp: Float64Array;
	zr: Float64Array;
	zi: Float64Array;
	f0fine: number;
	startSec: number;
	bestT: number;
	tfrac: number;
}

/** A slot window: its edges and the start offsets searched, against the slot start, s. */
export interface FtxWindow {
	a: number;
	b: number;
	dtMin: number;
	dtMax: number;
}

/** The slot that comes next and how far the audio has got into it. */
export interface FtxProgress {
	slotUtc: number;
	/** Seconds of the slot heard so far (may be negative before it starts). */
	into: number;
}

/** What a candidate is for the deep stage: its sync score, upside down or not, its fitted frequency and DT. */
export interface FtxDeepCandidate {
	score: number;
	mir: boolean;
	hz: number;
	dt: number;
}

/** A decoded candidate: the decode, its tones and where it is (tone 0 in Hz, start in samples of the slot), for the subtraction. */
export interface FtxFound {
	d: FtxDecode;
	tones: number[];
	f0: number;
	start: number;
}

/** Options of a decoder (the tests inject a clock). */
export interface FtxOptions {
	/** The wall clock, ms since 1970 (Date.now by default). */
	now?: () => number;
	/** Also look for upside-down signals (a lower sideband transmission); OnAir's default is on, BrowSDR's off. */
	mirrored?: boolean;
	/** Decoding time per block of audio, ms (by default 40 % of the block's duration, 4 .. 40 ms); Infinity decodes a slot at once. */
	sliceMs?: number;
}

/** A slot being decoded a step at a time. */
export interface FtxActive {
	job: FtxJob;
	steps: Generator<void, FtxDecode[], void>;
	/** Time spent so far, ms. */
	ms: number;
}

/** What the decoder shows of the last slot decoded. */
export interface FtxSlotReport {
	slotUtc: number;
	decodes: number;
	/** Time the slot took to decode, ms. */
	ms: number;
}
