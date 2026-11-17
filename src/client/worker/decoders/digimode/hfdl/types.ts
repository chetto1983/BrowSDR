// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir rust/onair_hfdl/src/phy.rs (Rate), stations.rs (Station),
// parse.rs (Msg), core/include/dect2/hfdl/hfdl_tel.h (HfdlMessage, HfdlChannelInfo, the "why" counters of
// HfdlTelemetry) and core/src/hfdl/hfdl_rx.cpp (the per-channel state of HfdlReceiver::Impl::Chan),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: the detail text is a list of labelled lines; the
// ACARS fields are those of BrowSDR's ACARS block reader (vdl2/acars.ts); one channel's counters; the burst decoder's
// state is split into a found preamble, a decode job and its result, so the decoding can be done a step at a time.

import type { Vdl2Acars } from '@/worker/decoders/digimode/vdl2/types';

/** One of the eight rates, chosen by the M1 shift index. */
export interface HfdlRate {
	/** The index 0 .. 7. */
	m1: number;
	/** 300, 600, 1200 or 1800 bit/s. */
	bps: number;
	/** Bits per data symbol: 1 BPSK, 2 QPSK, 3 8PSK. */
	bitsPerSym: number;
	/** Every coded bit sent twice (300 bit/s). */
	quarter: boolean;
	/** Two slots (4.2 s interleaver). */
	twoSlots: boolean;
	/** Data blocks of 30 symbols. */
	blocks: number;
	/** Interleaver column shift. */
	colShift: number;
}

/** A ground station of the built-in table; frequencies in kHz, bit 0 of a squitter's mask first. */
export interface HfdlStation {
	id: number;
	name: string;
	lat: number;
	lon: number;
	khz: readonly number[];
}

/** One line of the decoded layers: what it is about, and the text. */
export type HfdlLine = [label: string, value: string];

/** One decoded SPDU (squitter) or LPDU (OnAir's Msg / HfdlMessage, the part the PDU sets). */
export interface HfdlMessage {
	squitter: boolean;
	uplink: boolean;
	utcSync: boolean;
	gsId: number;
	/** The aircraft id the ground station assigned (-1 none). */
	acId: number;
	/** Squitter: TDMA frame index (-1 none). */
	frameIndex: number;
	/** Squitter: the system table version it names (-1 none). */
	systable: number;
	/** Squitter: the sender's frequencies in use, kHz (a bit beyond the table as -1 - bit). */
	activeKhz: number[];
	/** 24-bit address when the PDU names it (logon), or the logon table knows it (0 none). */
	icao: number;
	/** "SPDU", "Logon request", "Unnumbered data", ... */
	kind: string;
	/** "Performance data", "Frequency data", "ACARS", "System table", ... ("" none). */
	hfnpdu: string;
	summary: string;
	detail: HfdlLine[];
	flight: string;
	hasPos: boolean;
	lat: number;
	lon: number;
	posKind: string;
	/** Seconds of the day the aircraft gave (performance / frequency data; -1 none). */
	utcSec: number;
	/** An LPDU whose check sequence failed. */
	bad: boolean;
	acars?: Vdl2Acars;
}

/** A preamble found in the channel: where it starts, its carrier offset, gain and rate. */
export interface HfdlPreamble {
	/** The search position the coarse search fired on (channel samples). */
	s0: number;
	/** Fractional sample of the first A1 symbol. */
	t0: number;
	/** Carrier offset, Hz. */
	cfoHz: number;
	/** Complex channel gain on A1 + A2. */
	hRe: number;
	hIm: number;
	m1: number;
}

/** The samples of one burst at half-symbol spacing, turned by its carrier offset; u[uoff + 2i] is symbol i. */
export interface HfdlBurstSamples {
	re: Float32Array;
	im: Float32Array;
	uoff: number;
	/** Burst symbols from A1 to the last probe. */
	nsym: number;
	/** Mean power of the known symbols, for the level. */
	pw: number;
}

/** What one equaliser mode gives: the descrambled data symbols and the error on the known symbols. */
export interface HfdlEqualised {
	re: Float32Array;
	im: Float32Array;
	/** Mean squared error on the preamble (index 0) and on the probe after each block. */
	probeErr: Float64Array;
	/** Mean squared error on all probes (the SNR). */
	sig2: number;
}

/** A burst being decoded: where the search found it (s), its preamble, and the decoding steps left. */
export interface HfdlJob {
	s: number;
	pre: HfdlPreamble;
	steps: Generator<void, HfdlBurst, void>;
}

/** A burst taken from the air: its messages and how it was received. */
export interface HfdlBurst {
	ok: boolean;
	messages: HfdlMessage[];
	/** Signal seconds at the start of the prekey. */
	timeSec: number;
	levelDb: number;
	snrDb: number;
	cfoHz: number;
	rate: HfdlRate;
	/** The equaliser mode that decoded it: 0 adaptive equaliser, 1 gain and phase tracker, 2 known symbols only. */
	mode: number;
	/** Why it failed: 0 none, 1 too few octets, 2 squitter check, 3 MPDU header check. */
	why: number;
}

/** The burst counters of the channel and the reasons bursts did not decode (OnAir's "why" counters). */
export interface HfdlCounters {
	/** Preambles found (A1 + A2 and M1 accepted). */
	bursts: number;
	good: number;
	bad: number;
	/** The coarse search fired, the fine check (A1 + A2 coherence, M1) said no preamble. */
	preambleRejected: number;
	short: number;
	spduFcs: number;
	mpduFcs: number;
	lpduFcs: number;
	unknownLpdu: number;
	/** Good bursts at 300, 600, 1200 and 1800 bit/s. */
	byRate: number[];
}

/** An aircraft as the decoder keeps it, to name it in later records and count it in the status. */
export interface HfdlAircraftEntry {
	key: number;
	icao: number;
	acId: number;
	gsId: number;
	reg: string;
	flight: string;
	lastHeardSec: number;
	loggedOn: boolean;
}
