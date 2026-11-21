// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/include/dect2/lorasat/lorasat_presets.h (Preset, Confidence) and
// core/include/dect2/lorasat/lorasat_tel.h (LoraSatSettings, LsFrame), https://github.com/adswill/OnAir; see
// third_party/onair. Changes: the settings are the catalog entry's band and, when known, a TinyGS modem configuration
// (its keys as the TinyGS firmware reads them, GPL-3.0, https://github.com/G4lile0/tinyGS) in place of OnAir's settings
// dialog; a Doppler hint and the tracked satellite from the Satellites tool; SatNOGS DB transmitters as presets.

import type { LoraBank } from '@/worker/decoders/digimode/lora/bank';

/** How sure a preset is (OnAir lorasat::Confidence); nothing here was checked against a real signal. */
export type LoraSatConfidence = 'uncertain' | 'plausible' | 'documented';

/** A LoRa satellite preset of OnAir (lorasat::Preset). */
export interface LoraSatPreset {
	name: string;
	/** Nominal downlink (or, for uplink entries, the uplink) frequency. */
	mhz: number;
	/** 0: unknown, searched. */
	sf: number;
	/** 41.7 kHz is 125 / 3 kHz. */
	bwHz: number;
	/** 5..8 for 4/5..4/8, 0 unknown (an explicit header carries it anyway). */
	cr: number;
	/** -1: unknown. */
	sync: number;
	/** Ground devices transmit to the satellite: you hear the devices, not the satellite. */
	uplinkOnly: boolean;
	confidence: LoraSatConfidence;
	/** Start of the satellite's name in the element files ('' none). */
	tleName: string;
	note: string;
}

/** A LoRa transmitter of SatNOGS DB for a satellite in TinyGS's list (CC BY-SA 4.0, see satnogs.ts). */
export interface SatnogsLoraTransmitter {
	norad: number;
	/** The satellite's name(s) in TinyGS's element file. */
	names: string[];
	/** SatNOGS's description of the transmitter. */
	description: string;
	freqMHz: number;
	/** SatNOGS's "baud" field, which holds the LoRa bandwidth for LoRa transmitters; 0 when not set. */
	bwHz: number;
	/** SatNOGS marks it alive and active. */
	alive: boolean;
	/** SatNOGS marks it unconfirmed. */
	unconfirmed: boolean;
	/** Last change in SatNOGS DB, YYYY-MM-DD. */
	updated: string;
}

/** A catalog entry's channel: the LoRa bandwidth it searches and the channel rate (twice the bandwidth). */
export interface LoraSatBand {
	id: string;
	bwHz: number;
	rate: number;
	/** Channel filter width: the bandwidth and twice the Doppler allowance. */
	filterHz: number;
}

/** The LoRa settings of a TinyGS modem configuration, as the firmware reads them (ModemInfo of Status.h). */
export interface LoraSatConfig {
	/** "sat" and "NORAD" of the configuration. */
	sat: string;
	norad: number;
	freqMHz: number;
	bwHz: number;
	/** 5..12 */
	sf: number;
	/** 5..8 for 4/5..4/8 */
	cr: number;
	/** 0..255 ("sw" is decimal in TinyGS: 18 is 0x12). */
	sync: number;
	preamble: number;
	crc: boolean;
	/** "fldro": 0 off, 1 on, 2 automatic (RadioLib: symbols of 16 ms or more). */
	ldro: 'off' | 'on' | 'auto';
	/** "iIQ": inverted IQ. */
	inverted: boolean;
	/** "len": 0 explicit header, else implicit header frames of this length. */
	implicitLen: number;
}

/** What a TinyGS FSK configuration says (BrowSDR does not decode TinyGS FSK packets). */
export interface TinygsFsk {
	mode: string;
	sat: string;
	norad: number;
	freqMHz: number;
	/** kbit/s */
	bitrate: number;
	/** kHz */
	deviation: number;
	/** kHz */
	bw: number;
	/** Sync word bytes. */
	syncWord: number[];
	/** 0 none, 1 AX.25. */
	framing: number;
	/** 255: OOK. */
	ook: number;
	len: number;
	encoding: number;
}

/** A pasted TinyGS modem configuration: LoRa settings, an FSK description, or why the firmware would refuse it. */
export type TinygsModem = { kind: 'lora'; config: LoraSatConfig } | { kind: 'fsk'; fsk: TinygsFsk } | { kind: 'error'; message: string };

/** The Doppler the orbit predicts for the satellite on the VFO: offset from the VFO frequency and its rate. */
export interface LoraSatHint {
	offsetHz: number;
	rateHzS: number;
}

/** The satellite the Satellites tool tracks on this VFO. */
export interface LoraSatSatellite {
	name: string;
	norad: number;
}

/** The LoRa satellite decoder's part of the VFO parameters. */
export interface LoraSatParams {
	/** A TinyGS modem configuration to run exactly (else the blind search). */
	config?: LoraSatConfig;
	hint?: LoraSatHint;
	satellite?: LoraSatSatellite;
}

/** One frame as the decoder reports it (OnAir LsFrame). */
export interface LoraSatFrame {
	sf: number;
	bwHz: number;
	cr: number;
	sync: number;
	inverted: boolean;
	implicit: boolean;
	ldro: boolean;
	hasCrc: boolean;
	crcOk: boolean;
	corrected: number;
	snrDb: number;
	levelDb: number;
	/** Doppler (carrier offset from the VFO) at the first data symbol, Hz, and its drift through the frame, Hz/s. */
	dopplerHz: number;
	rateHzS: number;
	/** VFO frequency plus the offset, MHz (0 when not known). */
	freqMHz: number;
	payload: Uint8Array;
	satellite?: LoraSatSatellite;
	hint?: LoraSatHint;
}

/** One bank of the decoder: normal IQ, or inverted IQ fed the conjugate of the channel. */
export interface LoraSatLane {
	bank: LoraBank;
	inverted: boolean;
}
