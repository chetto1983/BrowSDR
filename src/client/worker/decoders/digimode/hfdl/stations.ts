// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir rust/onair_hfdl/src/stations.rs (STATIONS, station, mask_khz,
// station_on_khz), https://github.com/adswill/OnAir; see third_party/onair. Changes: none beyond the language; the
// table is OnAir's own (frequencies in kHz as published in recent HFDL system tables), shipped with the decoder, never
// fetched.
//
// The built-in ground station table and the frequency masks that squitters carry: bit i of a mask is the i-th
// frequency of the station, as the system table (HFNPDU 0xD0, not reassembled) would define it.

import type { HfdlStation } from './types';

const gs = (id: number, name: string, lat: number, lon: number, khz: number[]): HfdlStation => ({ id, name, lat, lon, khz });

/** The table, in OnAir's order. */
export const HFDL_STATIONS: readonly HfdlStation[] = [
	gs(1, 'San Francisco', 37.6, -122.4, [21934, 17919, 13276, 11327, 10081, 8927, 6559, 5508]),
	gs(2, 'Molokai', 21.2, -157.2, [21937, 17919, 13324, 13312, 13276, 11348, 11312, 10027, 8936, 8912, 6565, 5514]),
	gs(3, 'Reykjavik', 64.1, -21.9, [17985, 15025, 11184, 8977, 6712, 5720, 3900]),
	gs(4, 'Riverhead', 40.9, -72.6, [21931, 17919, 13276, 11387, 8912, 6661, 5652]),
	gs(5, 'Auckland', -37.0, 174.8, [17916, 13351, 10084, 8921, 6535, 5583]),
	gs(6, 'Hat Yai', 6.9, 100.4, [21949, 17928, 13270, 10066, 8825, 6535, 5655]),
	gs(7, 'Shannon', 52.7, -8.9, [11384, 10081, 8942, 8843, 6532, 5547, 3455, 2998]),
	gs(8, 'Johannesburg', -26.1, 28.2, [21949, 17922, 13321, 11321, 8834, 5529, 4681, 3016]),
	gs(
		9,
		'Barrow',
		71.3,
		-156.8,
		[21937, 21928, 17934, 17919, 11354, 10093, 10027, 8936, 8927, 6646, 5544, 5538, 5529, 4687, 4654, 3497, 3007, 2992, 2944],
	),
	gs(10, 'Muan', 34.9, 126.4, [21931, 17958, 13342, 10060, 8939, 6619, 5502, 2941]),
	gs(11, 'Albrook', 9.0, -79.6, [17901, 13264, 10063, 8894, 6589, 5589]),
	gs(13, 'Santa Cruz', -17.6, -63.1, [21997, 17916, 13315, 11318, 8957, 6628, 4660]),
	gs(14, 'Krasnoyarsk', 56.2, 92.5, [21990, 17912, 13321, 10087, 8886, 6596, 5622]),
	gs(15, 'Al Muharraq', 26.3, 50.6, [21982, 17967, 13354, 11348, 8885, 5544]),
	gs(16, 'Agana', 13.5, 144.8, [21928, 17919, 13312, 11306, 8927, 6652, 5451]),
	gs(17, 'Canarias', 27.9, -15.4, [21955, 17928, 13303, 11348, 8948, 6529]),
];

/** The station with this id. */
export const hfdlStation = (id: number): HfdlStation | undefined => HFDL_STATIONS.find((s) => s.id === id);

/** The frequencies a 20-bit mask selects at station `gsId`; a bit beyond the table (or an unknown station) gives -1 - bit. */
export function maskKhz(gsId: number, mask: number): number[] {
	const s = hfdlStation(gsId);
	const out: number[] = [];
	for (let b = 0; b < 20; b++) if ((mask >>> b) & 1) out.push(s && b < s.khz.length ? s.khz[b] : -b - 1);
	return out;
}

/** The first station that lists this frequency (0 none). */
export const stationOnKhz = (khz: number): number => HFDL_STATIONS.find((s) => s.khz.includes(khz))?.id ?? 0;

/** "<id> <name>" or "<id> (not in the table)". */
export const gsName = (id: number): string => `${id} ${hfdlStation(id)?.name ?? '(not in the table)'}`;
