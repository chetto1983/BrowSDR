// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/lorasat/lorasat_presets.cpp (presets, nearest, confidenceName,
// maxDopplerHz, maxDopplerRateHzS) and core/include/dect2/lorasat/lorasat_presets.h (bandwidthHz),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: the bandwidth in Hz (41.7 kHz is 125 / 3 kHz); the
// presets of the Digital Modes entries built from them and from SatNOGS DB's LoRa transmitters of TinyGS's satellites
// (satnogs.ts), each labelled with where it comes from and that it is unverified.

import type { DigimodePreset } from '@/worker/decoders/digimode/types';
import { SATNOGS_LORA, SATNOGS_LORA_SOURCE } from './satnogs';
import type { LoraSatPreset, SatnogsLoraTransmitter } from './types';

const KHZ41 = 125000 / 3;

/**
 * Public frequencies and LoRa settings of satellites and space-gateway services that use LoRa, from OnAir. NOTHING HERE WAS
 * CHECKED AGAINST A REAL SIGNAL: satellites change frequency, retire and re-launch; every entry says how sure it is.
 */
export const LORA_SAT_PRESETS: readonly LoraSatPreset[] = [
	{
		name: 'FOSSA Systems pico-satellites (FOSSASAT-1B / FOSSASAT-2 family)',
		mhz: 436.8,
		sf: 11,
		bwHz: 125000,
		cr: 8,
		sync: 0x12,
		uplinkOnly: false,
		confidence: 'uncertain',
		tleName: 'FOSSASAT',
		note: "LoRa beacons and telemetry of the FOSSA Systems 'PocketQube / 1P' satellites on 70 cm. The SF11 / 125 kHz / 4/8 / sync 0x12 setting is what the FOSSASAT-1 documentation and the TinyGS list gave when we last read them; later FOSSA satellites moved to other frequencies in 436 MHz and some use FSK or GMSK as well. Check the satellite's page.",
	},
	{
		name: 'FOSSASAT-2 family (second frequency)',
		mhz: 436.2,
		sf: 11,
		bwHz: 125000,
		cr: 8,
		sync: 0x12,
		uplinkOnly: false,
		confidence: 'uncertain',
		tleName: 'FOSSASAT-2',
		note: 'Second frequency seen in the community lists for the FOSSASAT-2 series. Uncertain.',
	},
	{
		name: 'Tianqi constellation (Guodian Gaoke) downlink',
		mhz: 400.45,
		sf: 0,
		bwHz: 500000,
		cr: 0,
		sync: -1,
		uplinkOnly: false,
		confidence: 'uncertain',
		tleName: 'TIANQI',
		note: 'The Tianqi (TQ) satellites run an IoT service with LoRa-based modulation around 400.45 MHz; the community networks list 500 kHz wide LoRa there with varying spreading factors. Spreading factor and sync word are searched. Uncertain: the service is commercial and the signal plan is not published in full.',
	},
	{
		name: 'Lacuna Space - uplink channel 868.1 (EU868)',
		mhz: 868.1,
		sf: 0,
		bwHz: 125000,
		cr: 5,
		sync: 0x34,
		uplinkOnly: true,
		confidence: 'plausible',
		tleName: 'LACUNA',
		note: "Lacuna Space's satellites listen to ordinary LoRa / LoRaWAN-style uplinks from ground devices on the EU868 channels (868.1, 868.3, 868.5 MHz, SF7 - SF12). You hear the devices, not the satellite (a satellite's downlink is on another band). Plausible: from the operator's public descriptions.",
	},
	{
		name: 'Lacuna Space - uplink channel 868.3 (EU868)',
		mhz: 868.3,
		sf: 0,
		bwHz: 125000,
		cr: 5,
		sync: 0x34,
		uplinkOnly: true,
		confidence: 'plausible',
		tleName: 'LACUNA',
		note: 'As above, second default EU868 channel.',
	},
	{
		name: 'Lacuna Space - uplink channel 868.5 (EU868)',
		mhz: 868.5,
		sf: 0,
		bwHz: 125000,
		cr: 5,
		sync: 0x34,
		uplinkOnly: true,
		confidence: 'plausible',
		tleName: 'LACUNA',
		note: 'As above, third default EU868 channel.',
	},
	{
		name: 'Space LoRaWAN uplinks, US915 sub-band 2 (903.9 - 905.3)',
		mhz: 904.6,
		sf: 0,
		bwHz: 125000,
		cr: 5,
		sync: 0x34,
		uplinkOnly: true,
		confidence: 'uncertain',
		tleName: '',
		note: 'Ground devices of satellite LoRa services in North America use the US915 uplink channels; sub-band 2 is the common one. Uncertain which services listen there.',
	},
	{
		name: 'FOSSASAT (401.703 MHz, settings from issue #229)',
		mhz: 401.703,
		sf: 11,
		bwHz: 125000,
		cr: 8,
		sync: -1,
		uplinkOnly: false,
		confidence: 'plausible',
		tleName: 'FOSSASAT',
		note: 'SF11, 125 kHz, CR 4/8 as a user posted them from the TinyGS settings (issue #229); the sync word is searched (0x12 and 0x34). Not checked against a signal.',
	},
	{
		name: '137.055 MHz LoRa telemetry, SF8 / 41.7 kHz (issue #229)',
		mhz: 137.055,
		sf: 8,
		bwHz: KHZ41,
		cr: 5,
		sync: 0x12,
		uplinkOnly: false,
		confidence: 'plausible',
		tleName: '',
		note: 'SF8, 41.7 kHz, CR 4/5, sync 0x12, 15-symbol preamble, CRC on, as a user posted them from the TinyGS settings (issue #229). Not checked against a signal.',
	},
	{
		name: 'Generic 70 cm LoRa cubesat, SF10 / 125 kHz',
		mhz: 437.4,
		sf: 10,
		bwHz: 125000,
		cr: 0,
		sync: 0x12,
		uplinkOnly: false,
		confidence: 'uncertain',
		tleName: '',
		note: 'A guess for experimenters: many amateur LoRa beacons sit between 435 and 438 MHz at 125 kHz and SF9 - SF12. Use it as a search start, not as a fact.',
	},
];

/** The OnAir preset within tolKhz of mhz, or -1. */
export function nearestPreset(mhz: number, tolKhz = 15): number {
	let best = -1,
		bd = tolKhz / 1e3;
	LORA_SAT_PRESETS.forEach((p, i) => {
		const d = Math.abs(p.mhz - mhz);
		if (d <= bd) [bd, best] = [d, i];
	});
	return best;
}

const GM = 3.986004418e14,
	RE = 6371e3,
	C = 299792458;

/** The largest Doppler shift at mhz for a satellite at altKm (circular orbit), seen at 0° elevation: v R / (R + h). */
export function maxDopplerHz(mhz: number, altKm = 600): number {
	const r = RE + altKm * 1e3,
		v = Math.sqrt(GM / r);
	return (mhz * 1e6 * v * (RE / r)) / C;
}

/** The largest Doppler rate, straight overhead (flat approximation reduced for the curvature: an upper bound). */
export function maxDopplerRateHzS(mhz: number, altKm = 600): number {
	const r = RE + altKm * 1e3,
		v = Math.sqrt(GM / r);
	return ((mhz * 1e6) / C) * ((v * v) / (altKm * 1e3)) * (RE / r);
}

const mhzText = (mhz: number) => mhz.toFixed(3);
const bwText = (hz: number) => `${+(hz / 1000).toFixed(1)} kHz`;

/** The SatNOGS transmitters and OnAir presets for one catalog bandwidth; SatNOGS ones without a bandwidth go to 125 kHz. */
export function digimodePresets(bwHz: number): DigimodePreset[] {
	const out: DigimodePreset[] = [];
	const add = (freqMHz: number, label: string) => {
		const same = out.find((p) => Math.abs(p.freqMHz - freqMHz) < 1e-6);
		if (same) same.label = `${same.label}; ${label}`;
		else out.push({ label, freqMHz });
	};
	const live = SATNOGS_LORA.filter((t) => t.alive && (t.bwHz ? Math.abs(t.bwHz - bwHz) < 1 : bwHz === 125000));
	const byFreq = new Map<number, SatnogsLoraTransmitter[]>();
	for (const t of live) byFreq.set(t.freqMHz, [...(byFreq.get(t.freqMHz) ?? []), t]);
	for (const [freq, list] of byFreq) {
		const names = [...new Set(list.flatMap((t) => t.names))].sort((a, b) => a.localeCompare(b));
		const shown = names.length > 3 ? `${names.slice(0, 2).join(', ')} and ${names.length - 2} more` : names.join(', ');
		add(freq, `${shown} ${mhzText(freq)} (SatNOGS${list.some((t) => !t.bwHz) ? ', bandwidth not listed' : ''}; unverified)`);
	}
	for (const p of LORA_SAT_PRESETS)
		if (Math.abs(p.bwHz - bwHz) < 1) add(p.mhz, `${p.name} (OnAir, ${p.confidence}${p.uplinkOnly ? ', uplinks' : ''})`);
	return out.sort((a, b) => a.freqMHz - b.freqMHz);
}

/** The SatNOGS transmitters of a satellite, by NORAD number. */
export const satnogsLora = (norad: number): SatnogsLoraTransmitter[] => SATNOGS_LORA.filter((t) => t.norad === norad);

export const bandwidthText = bwText;

/** What the presets are, for the catalog descriptions. */
export const SATNOGS_LORA_NOTE = `Presets: the LoRa transmitters ${SATNOGS_LORA_SOURCE} lists for TinyGS's satellites, and OnAir's list; none checked against a real signal.`;
