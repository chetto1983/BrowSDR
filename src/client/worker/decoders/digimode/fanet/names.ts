// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/avroad/avroad_air.cpp (fanetParse: the aircraft types kAc and
// the ground states kG) and FanetDec::feed (the "%02X:%04X" sender), https://github.com/adswill/OnAir; see
// third_party/onair. Format facts as credited there: the FANET protocol description (protocol.txt of Skytraxx's
// fanet-stm32, https://github.com/3s1d/fanet-stm32; format only, no code copied). Changes: the manufacturer list, the
// names of the other frame types and the landmark subtypes and layers are added from the protocol description; ground
// state 4 reads "boat" (the description's German "Boot"); the states it leaves to be defined read "state N".

/** Tracking: the aircraft type (bits 12 - 14). */
export const AIRCRAFT = ['other', 'paraglider', 'hang glider', 'balloon', 'glider', 'powered aircraft', 'helicopter', 'UAV'];

/** Ground tracking: the state (bits 4 - 7 of byte 6); empty: still to be defined. */
const GROUND = [
	'other',
	'walking',
	'vehicle',
	'bike',
	'boat',
	'',
	'',
	'',
	'need a ride',
	'landed well',
	'',
	'',
	'need technical support',
	'need medical help',
	'distress call',
	'distress call automatically',
];

export const groundName = (state: number): string => GROUND[state] || `state ${state}`;
/** Need medical help and the distress calls. */
export const groundAlert = (state: number): boolean => state >= 13;

const TYPES: Record<number, string> = {
	0: 'acknowledge',
	1: 'tracking',
	2: 'name',
	3: 'message',
	4: 'service',
	5: 'landmark',
	6: 'remote configuration',
	7: 'ground tracking',
	8: 'hardware info (old)',
	9: 'thermal',
	10: 'hardware info',
};
export const typeName = (type: number): string => TYPES[type] ?? `type ${type}`;

const MANUFACTURERS: Record<number, string> = {
	0x01: 'Skytraxx',
	0x03: 'BitBroker.eu',
	0x04: 'AirWhere',
	0x05: 'Windline',
	0x06: 'Burnair.ch',
	0x07: 'SoftRF',
	0x08: 'GXAircom',
	0x09: 'Airtribune',
	0x0a: 'FLARM',
	0x0b: 'FlyBeeper',
	0x0c: 'Leaf Vario',
	0x0d: 'LYNKX',
	0x0e: 'Syride',
	0x0f: 'FlyBrief',
	0x10: 'alfapilot',
	0x11: 'FANET+',
	0x20: 'XC Tracer',
	0xba: 'Burnair',
	0xcb: 'Cloudbuddy',
	0xe0: 'OGN Tracker',
	0xe4: '4aviation',
	0xfa: 'various',
	0xfb: 'Espressif base station',
	0xfc: 'unregistered',
	0xfd: 'unregistered',
	0xfe: 'multicast',
};

const hex = (v: number, digits: number): string => v.toString(16).toUpperCase().padStart(digits, '0');

/** OnAir's "%02X:%04X": manufacturer and device. */
export const fanetAddress = (manufacturer: number, device: number): string => `${hex(manufacturer, 2)}:${hex(device, 4)}`;

export const manufacturerName = (m: number): string => `${MANUFACTURERS[m] ?? 'unknown'} (0x${hex(m, 2)})`;

const SUBTYPES = ['text', 'line', 'arrow', 'area', 'filled area', 'circle', 'filled circle', '3D line', '3D area', '3D cylinder'];
export const landmarkName = (subtype: number): string => SUBTYPES[subtype] ?? `subtype ${subtype}`;

const LAYERS = ['info', 'warning', 'keep out', 'touch down', 'no airspace warn zone'];
export const layerName = (layer: number): string => (layer === 15 ? "don't care" : (LAYERS[layer] ?? `layer ${layer}`));

const SECTORS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
/** The wind sectors of a landmark (bit 0 N ... bit 7 NW); none set: only without wind. */
export const sectorNames = (bits: number): string => SECTORS.filter((_, i) => (bits >> i) & 1).join(', ') || 'no wind';
