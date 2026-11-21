// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/lorasat/lorasat_rx.cpp (loraSatTuning; the channel filter of
// rebuild(): the bandwidth and twice the Doppler allowance) and core/include/dect2/lorasat/lorasat_presets.h
// (bandwidthHz), https://github.com/adswill/OnAir; see third_party/onair. Changes: one Digital Modes entry per LoRa
// bandwidth (OnAir: one mode with a bandwidth setting), each a channel of twice the bandwidth around the VFO with a
// fixed Doppler allowance; their presets from presets.ts.

import type { DigimodeInfo } from '@/worker/decoders/digimode/types';
import { digimodePresets, SATNOGS_LORA_NOTE } from './presets';
import type { LoraSatBand } from './types';

const SOURCE =
	'core/src/lorasat/lorasat_rx.cpp, lorasat_presets.cpp, core/src/mesh/mesh_lora_demod.cpp (cfoTrack), core/src/lorawan/lora_bank.cpp';

/** The channels: twice the bandwidth, the filter the bandwidth and twice the Doppler allowance. */
export const LORA_SAT_BANDS: readonly LoraSatBand[] = [
	{ id: 'lora-sat', bwHz: 125000, rate: 250000, filterHz: 200000 },
	{ id: 'lora-sat-250', bwHz: 250000, rate: 500000, filterHz: 330000 },
	{ id: 'lora-sat-500', bwHz: 500000, rate: 1000000, filterHz: 620000 },
	{ id: 'lora-sat-62', bwHz: 62500, rate: 125000, filterHz: 104000 },
	{ id: 'lora-sat-41', bwHz: 125000 / 3, rate: 250000 / 3, filterHz: 70000 },
];

export const loraSatBand = (id: string | undefined): LoraSatBand | undefined => LORA_SAT_BANDS.find((band) => band.id === id);
export const isLoraSat = (id: string | undefined): boolean => !!loraSatBand(id);

/** The entry whose channel carries a LoRa bandwidth: the narrowest one at least as wide (7.8 to 31.25 kHz: 41.7 kHz's). */
export function loraSatBandFor(bwHz: number): LoraSatBand {
	const wide = LORA_SAT_BANDS.filter((band) => band.bwHz >= bwHz - 1).sort((a, b) => a.bwHz - b.bwHz);
	return wide[0] ?? LORA_SAT_BANDS[2];
}

/** The Doppler shift either way that the channel passes, Hz. */
export const dopplerAllowanceHz = (band: LoraSatBand): number => (band.filterHz - band.bwHz) / 2;

const khz = (hz: number) => `${+(hz / 1000).toFixed(1)} kHz`;

function describe(band: LoraSatBand): string {
	const allowance = khz(dopplerAllowanceHz(band));
	if (band.id === 'lora-sat')
		return `LoRa frames from satellites, as TinyGS ground stations receive them, here in 125 kHz: SF7 to SF12 at once, any sync word (the one found is shown), normal and inverted IQ, the coding rate and CRC from each frame's header, the low data rate optimisation by SF and bandwidth as the radios set it. The carrier is followed through every frame for the Doppler shift (up to ±${allowance}) and its rate. Each frame with its Doppler offset and rate, SF, bandwidth, coding rate, sync word, SNR and level, and the payload in hex (and as text when it is text). Paste a TinyGS station's modem configuration below to run its exact settings (implicit header, preamble, inverted IQ). Tools → Satellites → Decode on VFO tunes a TinyGS satellite's frequency, names it in the records and sends the decoder the Doppler its orbit predicts; the VFO is not retuned during the pass. 250, 500, 62.5 and 41.7 kHz are entries of their own. ${SATNOGS_LORA_NOTE}`;
	return `LoRa satellite frames in ${khz(band.bwHz)}: the same search, Doppler following and records as the 125 kHz entry (Doppler up to ±${allowance}).${band.bwHz < 60000 ? ' A pasted configuration of 7.8 to 31.25 kHz also runs here (its preamble search then hears more noise).' : ''} ${SATNOGS_LORA_NOTE}`;
}

/** The Digital Modes entries of the LoRa satellite decoder. */
export const LORA_SAT_DIGIMODES: readonly DigimodeInfo[] = LORA_SAT_BANDS.map((band) => ({
	id: band.id,
	label: band.id === 'lora-sat' ? 'LoRa satellites (TinyGS, 125 kHz)' : `LoRa satellites (${khz(band.bwHz)})`,
	family: 'Satellite',
	description: describe(band),
	rate: band.rate,
	bandwidth: band.filterHz,
	presets: digimodePresets(band.bwHz),
	source: SOURCE,
}));
