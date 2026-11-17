// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/mesh/mesh_proto.cpp (Meshtastic modem presets and regions, slot
// frequency, default channel key, MeshCore Public secret and defaults, meshLoraLdro), core/src/mesh/mesh_presets.cpp and
// mesh_presets_data.cpp (the MeshCore community presets of api.meshcore.nz, fetched 2026-10-13; meshCorePresetToLora),
// core/src/mesh/mesh_proto_aprs.cpp (loraAprsPresets, meshcomPresets) and core/src/mesh/mesh_proto_lorawan.cpp
// (lorawanPresets), https://github.com/adswill/OnAir; see third_party/onair. Facts as credited there: Meshtastic firmware
// RadioInterface.cpp, MeshRadio.h, Channels.cpp (Meshtastic contributors, GPL-3.0); MeshCore companion_radio and radiolib
// helpers (MeshCore contributors, MIT); LoRa_APRS_iGate and LoRa_APRS_Tracker configurations (Ricardo Guzman, GPL-3.0);
// MeshCom firmware country_profile.cpp, configuration_default.h and configuration_global.h (icssw-org/MeshCom-Firmware,
// MIT); LoRaWAN RP002-1.0.4. Changes: tables only (no saved preset file); names as in OnAir.

import type { LoraSettings } from './types';

/** Low data rate optimisation as RadioLib decides it (symbol time >= 16 ms). */
export const meshLoraLdro = (sf: number, bwHz: number): boolean => bwHz > 0 && (2 ** sf / bwHz) * 1000 >= 16;

/** MeshRadio.h defaultpsk: the key of the default Meshtastic channel. */
export const MESHTASTIC_DEFAULT_PSK = Uint8Array.from([
	0xd4, 0xf1, 0xbb, 0x3a, 0x20, 0x29, 0x07, 0x59, 0xf0, 0xbc, 0xff, 0xab, 0xcf, 0x4e, 0x69, 0x01,
]);
/** examples/companion_radio/MyMesh.cpp PUBLIC_GROUP_PSK "izOH6cXN6mrJ5e26oRXNcg==": the MeshCore Public channel. */
export const MESHCORE_PUBLIC_SECRET = Uint8Array.from([
	0x8b, 0x33, 0x87, 0xe9, 0xc5, 0xcd, 0xea, 0x6a, 0xc9, 0xe5, 0xed, 0xba, 0xa1, 0x15, 0xcd, 0x72,
]);

/** MeshRadio.h modemPresetToParams (non-wide regions): name, SF, bandwidth (kHz), CR, default channel name, fixed frequency. */
const MESHTASTIC_PRESETS: ReadonlyArray<[string, number, number, number, string?, number?]> = [
	['ShortTurbo', 7, 500, 5],
	['ShortFast', 7, 250, 5],
	['ShortSlow', 8, 250, 5],
	['MediumFast', 9, 250, 5],
	['MediumSlow', 10, 250, 5],
	['LongTurbo', 11, 500, 8],
	['LongFast', 11, 250, 5],
	['LongModerate', 11, 125, 8, 'LongMod'],
	['LongSlow', 12, 125, 8],
	// Finnish EU2 setup: a user preset with an override frequency in EU_868
	['EdgeFastLow', 8, 62.5, 8, undefined, 869431274.4140625],
];

/** RadioInterface.cpp regions[]: name, start and end (MHz), wide LoRa (2.4 GHz). */
const MESHTASTIC_REGIONS: ReadonlyArray<[string, number, number, boolean?]> = [
	['US', 902.0, 928.0],
	['EU_433', 433.0, 434.0],
	['EU_868', 869.4, 869.65],
	['CN', 470.0, 510.0],
	['JP', 920.5, 923.5],
	['ANZ', 915.0, 928.0],
	['ANZ_433', 433.05, 434.79],
	['RU', 868.7, 869.2],
	['KR', 920.0, 923.0],
	['TW', 920.0, 925.0],
	['IN', 865.0, 867.0],
	['NZ_865', 864.0, 868.0],
	['TH', 920.0, 925.0],
	['UA_433', 433.0, 434.7],
	['UA_868', 868.0, 868.6],
	['MY_433', 433.0, 435.0],
	['MY_919', 919.0, 924.0],
	['SG_923', 917.0, 925.0],
	['PH_433', 433.0, 434.7],
	['PH_868', 868.0, 869.4],
	['PH_915', 915.0, 918.0],
	['KZ_433', 433.075, 434.775],
	['KZ_863', 863.0, 868.0],
	['NP_865', 865.0, 868.0],
	['BR_902', 902.0, 907.5],
	['LORA_24', 2400.0, 2483.5, true],
];

const lower = (s: string): string => s.replace(/[_ -]/g, '').toLowerCase();
const findRegion = (name: string) => MESHTASTIC_REGIONS.find((g) => lower(g[0]) === lower(name));
const findPreset = (name: string) =>
	MESHTASTIC_PRESETS.find((p) => lower(p[0]) === lower(name)) ?? (lower(name) === 'longmod' ? MESHTASTIC_PRESETS[7] : undefined);
/** MeshRadio.h wide_lora (2.4 GHz SX128x): 1625 kHz for the 500 kHz presets, 406.25 for 125, else 812.5. */
const presetBwKHz = (bwKHz: number, wide: boolean): number => (!wide ? bwKHz : bwKHz >= 500 ? 1625 : bwKHz <= 125 ? 406.25 : 812.5);

/** RadioInterface.cpp hash(): djb2. */
function djb2(s: string): number {
	let h = 5381;
	for (const c of new TextEncoder().encode(s)) h = (Math.imul(h, 33) + c) >>> 0;
	return h;
}

/** Every Meshtastic modem preset ("LongFast", ...) with its LoRa settings (no frequency). */
export function meshtasticPresets(): LoraSettings[] {
	return MESHTASTIC_PRESETS.map(([name, sf, bwKHz, cr]) => ({
		name,
		freqHz: 0,
		sf,
		bwHz: bwKHz * 1000,
		cr,
		preamble: 16, // RadioInterface.h preambleLength
		syncWord: 0x2b, // RadioLibInterface.h syncWord
		ldro: meshLoraLdro(sf, bwKHz * 1000),
	}));
}

/**
 * The slot of a preset in a region: numChannels = floor((end - start) / bw); slot = hash(default channel name) % numChannels;
 * f = start + bw / 2 + slot bw. 0 when unknown or when the preset does not fit the region.
 */
export function meshtasticSlotHz(region: string, preset: string): number {
	const p = findPreset(preset),
		g = findRegion(region);
	if (!p || !g) return 0;
	if (p[5] && lower(region) === 'eu868') return Math.round(p[5]);
	const bw = presetBwKHz(p[2], !!g[3]) / 1000;
	if (g[2] - g[1] < bw) return 0;
	const n = Math.floor((g[2] - g[1]) / bw + 1e-9);
	if (n === 0) return 0;
	const slot = djb2(p[4] ?? p[0]) % n;
	return Math.round((g[1] + bw / 2 + slot * bw) * 1e6);
}

/** MeshCore community presets: title, region, MHz, bandwidth (kHz), SF, CR. */
const MESHCORE_PRESETS: ReadonlyArray<[string, string, number, number, number, number]> = [
	['Australia', 'Oceania', 915.8, 250, 10, 5],
	['Australia (Narrow)', 'Oceania', 916.575, 62.5, 7, 7],
	['Australia (Mid)', 'Oceania', 915.075, 125, 9, 5],
	['Australia: SA, WA', 'Oceania', 923.125, 62.5, 8, 8],
	['Australia: QLD', 'Oceania', 923.125, 62.5, 8, 5],
	['Brazil', 'South America', 923.125, 62.5, 8, 8],
	['Canada', 'North America', 910.525, 62.5, 7, 5],
	['Costa Rica', 'North America', 910.525, 125, 11, 5],
	['EU/UK (Narrow)', 'Europe', 869.618, 62.5, 8, 8],
	['EU/UK (Deprecated)', 'Europe', 869.525, 250, 11, 5],
	['Czech Republic (Narrow)', 'Europe', 869.432, 62.5, 7, 5],
	['EU 433MHz (Long Range)', 'Europe', 433.65, 250, 11, 5],
	['EU 433MHz (Narrow)', 'Europe', 433.65, 62.5, 8, 8],
	['Hungary', 'Europe', 869.618, 62.5, 7, 5],
	['Netherlands', 'Europe', 869.618, 62.5, 7, 5],
	['Netherlands (Limburg)', 'Europe', 869.618, 62.5, 8, 8],
	['New Zealand (Narrow)', 'Oceania', 917.375, 62.5, 7, 5],
	['New Zealand (Gisborne)', 'Oceania', 917.375, 250, 11, 5],
	['Portugal 433', 'Europe', 433.375, 62.5, 9, 6],
	['Portugal 868', 'Europe', 869.618, 62.5, 7, 6],
	['Slovakia', 'Europe', 869.618, 62.5, 7, 5],
	['Switzerland', 'Europe', 869.618, 62.5, 8, 8],
	['USA', 'North America', 910.525, 62.5, 7, 5],
	['USA - Southern California', 'North America', 927.875, 62.5, 7, 5],
	['Vietnam (Narrow)', 'Asia', 920.25, 62.5, 8, 5],
	['Vietnam (Deprecated)', 'Asia', 920.25, 250, 11, 5],
];

/** MeshCore: sync word 0x12 (RADIOLIB_SX126X_SYNC_WORD_PRIVATE), preamble 32 up to SF8 and 16 above. */
export function meshCorePresets(): Array<LoraSettings & { region: string }> {
	return MESHCORE_PRESETS.map(([name, region, mhz, bwKHz, sf, cr]) => ({
		name,
		region,
		freqHz: mhz * 1e6,
		sf,
		bwHz: bwKHz * 1000,
		cr,
		syncWord: 0x12,
		preamble: sf <= 8 ? 32 : 16,
		ldro: meshLoraLdro(sf, bwKHz * 1000),
	}));
}

/** LoRa APRS (richonguzman/LoRa_APRS_iGate and Tracker, lora-aprs/LoRa_APRS_iGate): 125 kHz, sync 0x12, preamble 8. */
export function loraAprsPresets(): LoraSettings[] {
	const rows: Array<[string, number, number, number]> = [
		['LoRa APRS EU', 433.775, 12, 5],
		['LoRa APRS PL', 434.855, 9, 7],
		['LoRa APRS UK', 439.9125, 12, 5],
		['LoRa APRS 915', 915.0, 12, 5],
	];
	return rows.map(([name, mhz, sf, cr]) => ({
		name,
		freqHz: mhz * 1e6,
		sf,
		bwHz: 125000,
		cr,
		preamble: 8,
		syncWord: 0x12,
		ldro: meshLoraLdro(sf, 125000),
	}));
}

/**
 * MeshCom 4 (icssw-org/MeshCom-Firmware country_profile.cpp, the ESP32 columns): frequency, bandwidth, SF; 4/6 everywhere,
 * sync word 0x2B; preamble 32 for the default (EU), 8 in the country table.
 */
export function meshcomPresets(): LoraSettings[] {
	const rows: Array<[string, number, number, number, number]> = [
		['MeshCom EU', 433.175, 250, 11, 32],
		['MeshCom UK', 439.9125, 125, 10, 8],
		['MeshCom LA', 433.925, 125, 10, 8],
		['MeshCom 868', 869.525, 250, 11, 8],
		['MeshCom 915', 906.875, 250, 11, 8],
		['MeshCom VR2', 435.775, 250, 11, 8],
		['MeshCom 435', 435.75, 250, 11, 8],
		['MeshCom 436', 436.25, 250, 11, 8],
		['MeshCom 442', 442.0, 250, 11, 8],
	];
	return rows.map(([name, mhz, bwKHz, sf, preamble]) => ({
		name,
		freqHz: mhz * 1e6,
		sf,
		bwHz: bwKHz * 1000,
		cr: 6,
		preamble,
		syncWord: 0x2b,
		ldro: meshLoraLdro(sf, bwKHz * 1000),
	}));
}

/** The channels the receiver searches: EU868 (region 0) or US915 (region 1); 4/5, preamble 8, public sync word 0x34. */
export function lorawanPresets(region: number): LoraSettings[] {
	const v: LoraSettings[] = [];
	const add = (mhz: number, sf: number, bw: number) =>
		v.push({
			name: `LoRaWAN ${mhz.toFixed(1)}`,
			freqHz: mhz * 1e6,
			sf,
			bwHz: bw,
			cr: 5,
			preamble: 8,
			syncWord: 0x34,
			ldro: meshLoraLdro(sf, bw),
		});
	if (region >= 2) return v; // ANZ: AU915 is not covered
	if (region === 1) {
		for (let c = 0; c < 64; c++) for (let sf = 7; sf <= 10; sf++) add(902.3 + 0.2 * c, sf, 125e3); // DR0 - DR3
		for (let c = 0; c < 8; c++) add(903.0 + 1.6 * c, 8, 500e3); // DR4
	} else {
		for (const f of [868.1, 868.3, 868.5, 867.1, 867.3, 867.5, 867.7, 867.9]) for (let sf = 7; sf <= 12; sf++) add(f, sf, 125e3); // DR5 - DR0
		add(868.3, 7, 250e3); // DR6
	}
	return v;
}

/** The spreading factors of the presets of one bandwidth, ascending. */
export function sfsAt(presets: LoraSettings[], bwHz: number): number[] {
	return [...new Set(presets.filter((p) => Math.abs(p.bwHz - bwHz) < 1).map((p) => p.sf))].sort((a, b) => a - b);
}
