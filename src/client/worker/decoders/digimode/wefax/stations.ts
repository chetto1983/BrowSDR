// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/marine/marine_wefax_stations.cpp and
// core/include/dect2/marine/marine_wefax_stations.h (HF radiofax stations and broadcast times),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: rows as objects; wefaxNext names its fields in full.
//
// Frequencies are the assigned carriers in kHz (tune the USB dial 1.9 kHz lower). Broadcast times are UTC; most are
// marked approximate: they follow the published schedules only roughly, and stations change them with the seasons.
// Source: the NOAA "Worldwide Marine Radiofacsimile Broadcast Schedules" and the stations' own schedules.

import type { WefaxBroadcast, WefaxNext, WefaxStation } from './types';

const station = (id: string, name: string, callsign: string, country: string, region: string, carrierKhz: number[]): WefaxStation => ({
	id,
	name,
	callsign,
	country,
	region,
	carrierKhz,
});

export const WEFAX_STATIONS: readonly WefaxStation[] = [
	// Europe
	station('DDK', 'DWD Pinneberg (Hamburg)', 'DDH3 DDK3 DDK6', 'Germany', 'Europe', [3855, 7880, 13882.5]),
	station('GYA', 'Northwood (UK Met Office / Royal Navy)', 'GYA', 'United Kingdom', 'Europe', [2618.5, 4610, 8040, 11086.5]),
	station('SVJ4', 'Athens', 'SVJ4', 'Greece', 'Europe', [4481, 8105]),
	station('TAH', 'Istanbul (Turkish Met Service)', 'TAH', 'Turkey', 'Europe', [3377, 6825]),
	station('RBW', 'Murmansk', 'RBW41', 'Russia', 'Europe', [6445.5, 7907]),
	// North America
	station('NMF', 'Boston (NOAA / USCG)', 'NMF', 'United States', 'North America', [4235, 6340.5, 9110, 12750]),
	station('NMG', 'New Orleans (NOAA / USCG)', 'NMG', 'United States', 'North America', [4317.9, 8503.9, 12789.9, 17146.4]),
	station('NMC', 'Point Reyes (NOAA / USCG)', 'NMC', 'United States', 'North America', [4346, 8682, 12786, 17151.2, 22527]),
	station('NOJ', 'Kodiak (NOAA / USCG)', 'NOJ', 'United States', 'North America', [2054, 4298, 8459, 12412.5]),
	station('KVM70', 'Honolulu (NOAA)', 'KVM70', 'United States', 'Oceania', [9982.5, 11090, 16135, 23331.5]),
	station('CFH', 'Halifax (Canadian Forces)', 'CFH', 'Canada', 'North America', [4271, 6496.4, 10536, 13510]),
	station('VCO', 'Sydney, Nova Scotia (CCG)', 'VCO', 'Canada', 'North America', [4416, 6915.1]),
	station('VFF', 'Iqaluit (CCG, summer)', 'VFF', 'Canada', 'North America', [3253, 7710]),
	station('VFA', 'Inuvik (CCG, summer)', 'VFA', 'Canada', 'North America', [4292, 8457.8]),
	// Asia
	station('JMH', 'Tokyo (Japan Meteorological Agency)', 'JMH', 'Japan', 'Asia', [3622.5, 7795, 13988.5]),
	station('JJC', 'Kyodo News, Tokyo', 'JJC', 'Japan', 'Asia', [4316, 8467.5, 12745.5, 16971, 17069.6, 22542]),
	station('JFX', 'Kagoshima (Japan Coast Guard)', 'JFX', 'Japan', 'Asia', [4274, 8658, 13074, 16907.5, 22559.6]),
	station('HLL2', 'Seoul (KMA)', 'HLL2', 'South Korea', 'Asia', [3585, 5857.5, 7433.5, 9165, 13570]),
	station('BAF', 'Beijing', 'BAF', 'China', 'Asia', [5526.9, 8121.9, 10116.9, 14366.9, 16025.9, 18236.9]),
	station('XSG', 'Shanghai', 'XSG', 'China', 'Asia', [4170, 8302, 12382, 16559]),
	station('XSQ', 'Guangzhou', 'XSQ', 'China', 'Asia', [4199.8, 8412.5, 12629.3, 16826.3]),
	station('BMF', 'Taipei', 'BMF', 'Taiwan', 'Asia', [4616, 8140, 13900, 18560]),
	station('HSW64', 'Bangkok (Thai Navy)', 'HSW64', 'Thailand', 'Asia', [7395]),
	// Oceania
	station('VMC', 'Charleville (Bureau of Meteorology)', 'VMC', 'Australia', 'Oceania', [2628, 5100, 11030, 13920, 20469]),
	station('VMW', 'Wiluna (Bureau of Meteorology)', 'VMW', 'Australia', 'Oceania', [5755, 7535, 10555, 15615, 18060]),
	station('ZKLF', 'Wellington (MetService)', 'ZKLF', 'New Zealand', 'Oceania', [3247.4, 5807, 9459, 13550.5, 16340.1]),
	// South America
	station('CBV', 'Valparaiso (Chilean Navy)', 'CBV', 'Chile', 'South America', [4228, 8677, 17146.4]),
	station('CBM', 'Punta Arenas, Magallanes (Chilean Navy)', 'CBM', 'Chile', 'South America', [4322, 8696]),
	// Africa
	station('ZSJ', 'Cape Town (South African Navy)', 'ZSJ', 'South Africa', 'Africa', [4014, 7508, 13538, 18238]),
];

/** hhmm -> minutes after 00:00. */
const m = (hhmm: number) => Math.trunc(hhmm / 100) * 60 + (hhmm % 100);
const chart = (id: string, hhmm: number, lpm: number, ioc: number, product: string): WefaxBroadcast => ({
	station: id,
	utcMin: m(hhmm),
	lpm,
	ioc,
	product,
	approximate: true,
});

/** UTC start, station, product. Charts every 6 hours are the usual pattern; the exact minutes vary. */
export const WEFAX_BROADCASTS: readonly WefaxBroadcast[] = [
	chart('DDK', 430, 120, 576, 'Surface analysis, North Atlantic and Europe'),
	chart('DDK', 1030, 120, 576, 'Surface analysis'),
	chart('DDK', 1630, 120, 576, 'Surface analysis'),
	chart('DDK', 2230, 120, 576, 'Surface analysis'),
	chart('DDK', 900, 120, 576, 'Sea state / wave forecast'),
	chart('GYA', 300, 120, 576, 'Surface analysis'),
	chart('GYA', 900, 120, 576, 'Surface analysis'),
	chart('GYA', 1500, 120, 576, 'Surface analysis'),
	chart('GYA', 2100, 120, 576, 'Surface analysis'),
	chart('GYA', 1000, 120, 576, 'Sea and swell forecast'),
	chart('SVJ4', 900, 120, 576, 'Surface analysis, Mediterranean'),
	chart('SVJ4', 1600, 120, 576, 'Surface forecast'),
	chart('NMF', 230, 120, 576, 'Surface analysis, Atlantic'),
	chart('NMF', 815, 120, 576, 'Surface analysis'),
	chart('NMF', 1400, 120, 576, 'Surface analysis'),
	chart('NMF', 1945, 120, 576, 'Surface analysis'),
	chart('NMG', 0, 120, 576, 'Tropical surface analysis'),
	chart('NMG', 600, 120, 576, 'Tropical surface analysis'),
	chart('NMG', 1200, 120, 576, 'Tropical surface analysis'),
	chart('NMG', 1800, 120, 576, 'Tropical surface analysis'),
	chart('NMC', 140, 120, 576, 'Surface analysis, Pacific'),
	chart('NMC', 740, 120, 576, 'Surface analysis'),
	chart('NMC', 1340, 120, 576, 'Surface analysis'),
	chart('NMC', 1940, 120, 576, 'Surface analysis'),
	chart('NOJ', 400, 120, 576, 'Surface analysis, Alaska'),
	chart('NOJ', 1600, 120, 576, 'Surface analysis'),
	chart('KVM70', 130, 120, 576, 'Surface analysis, Pacific'),
	chart('KVM70', 1330, 120, 576, 'Surface analysis'),
	chart('CFH', 300, 120, 576, 'Surface analysis'),
	chart('CFH', 1500, 120, 576, 'Surface analysis'),
	chart('JMH', 300, 120, 576, 'Asia surface analysis'),
	chart('JMH', 900, 120, 576, 'Asia surface analysis'),
	chart('JMH', 1500, 120, 576, 'Asia surface analysis'),
	chart('JMH', 2100, 120, 576, 'Asia surface analysis'),
	chart('JJC', 0, 60, 576, 'Weather charts and news'),
	chart('HLL2', 330, 120, 576, 'Surface analysis'),
	chart('HLL2', 1530, 120, 576, 'Surface analysis'),
	chart('BMF', 200, 120, 576, 'Surface analysis'),
	chart('VMC', 130, 120, 576, 'MSL analysis, Australia'),
	chart('VMC', 730, 120, 576, 'MSL analysis'),
	chart('VMC', 1330, 120, 576, 'MSL analysis'),
	chart('VMC', 1930, 120, 576, 'MSL analysis'),
	chart('VMW', 200, 120, 576, 'MSL analysis, Indian Ocean'),
	chart('VMW', 1400, 120, 576, 'MSL analysis'),
	chart('ZKLF', 100, 120, 576, 'MSL analysis, Southwest Pacific'),
	chart('ZKLF', 1300, 120, 576, 'MSL analysis'),
	chart('CBV', 1100, 120, 576, 'Surface analysis, Southeast Pacific'),
	chart('CBV', 2300, 120, 576, 'Surface analysis'),
	chart('ZSJ', 600, 120, 576, 'Surface analysis, South Atlantic'),
	chart('ZSJ', 1800, 120, 576, 'Surface analysis'),
];

export const wefaxStation = (id: string): WefaxStation | undefined => WEFAX_STATIONS.find((s) => s.id === id);

/** USB: the fax centre (1900 Hz) sits on the carrier, so the dial is 1.9 kHz below it. */
export const wefaxDialKhz = (carrierKhz: number): number => carrierKhz - 1.9;

/** The next `count` broadcasts after `nowUtcSec` (Unix time), soonest first; `region` empty = all. */
export function wefaxNext(nowUtcSec: number, count: number, region = ''): WefaxNext[] {
	const out: WefaxNext[] = [];
	const day0 = nowUtcSec - (((nowUtcSec % 86400) + 86400) % 86400);
	for (const broadcast of WEFAX_BROADCASTS) {
		const s = wefaxStation(broadcast.station);
		if (!s || (region && region !== s.region)) continue;
		let t = day0 + broadcast.utcMin * 60;
		if (t + 600 < nowUtcSec) t += 86400; // a broadcast that began up to 10 minutes ago is still on
		out.push({ broadcast, station: s, startUtc: t });
	}
	out.sort((x, y) => x.startUtc - y.startUtc);
	return out.slice(0, Math.max(0, count));
}
