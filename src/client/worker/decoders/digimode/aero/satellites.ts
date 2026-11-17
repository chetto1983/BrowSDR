// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/inmsat/inmsat_satid.cpp (satTable, geoLook, the "content" evidence
// of identifySatellite) and core/include/dect2/inmsat/inmsat_satid.h, https://github.com/adswill/OnAir; see
// third_party/onair. Changes: only what one Aero channel needs: the satellite named by the longitude its system table
// sends, and where that satellite stands in the station's sky; the frequency fingerprint and the scoring of OnAir's
// all-carriers mode are left out.
//
// The P channel lists are those of github.com/alphafox02/inmarsat-sniffer (satellites.c, taken from Inmarsat's L-band
// frequency list) as OnAir quotes them; the slot longitudes are the nominal ones. Unverified against a real capture,
// except Alphasat 25E (OnAir, 2026-10-30), whose 10500 bit/s pair was found at 1545.315 / 1545.3275 MHz.

import type { AeroSatellite } from './types';

export const AERO_SATELLITES: readonly AeroSatellite[] = [
	{ name: 'Alphasat 25E', lonDeg: 25, p600: [1545.115, 1545.13], p10500: [1545.315, 1545.3275] },
	{ name: 'Inmarsat-4 F3 98W', lonDeg: -98, p600: [1545.02, 1545.205], p10500: [1546.005, 1546.0775] },
	{ name: 'Inmarsat-3 F5 54W (AOR-W)', lonDeg: -54, p600: [1545.025, 1545.04], p10500: [1546.055, 1546.07] },
	{ name: 'Inmarsat-6 F1 83.5E', lonDeg: 83.5, p600: [1545.16, 1545.225], p10500: [1546.0425, 1546.1225] },
	{ name: 'Inmarsat-4 F1 143.5E', lonDeg: 143.5, p600: [0, 0], p10500: [0, 0] },
	{ name: 'Inmarsat 15.5W (AOR-E)', lonDeg: -15.5, p600: [0, 0], p10500: [0, 0] },
	{ name: 'Inmarsat 64.5E (IOR)', lonDeg: 64.5, p600: [0, 0], p10500: [0, 0] },
	{ name: 'Inmarsat 178E (POR)', lonDeg: 178, p600: [0, 0], p10500: [0, 0] },
];

const lonDiff = (a: number, b: number): number => Math.abs(((((a - b + 540) % 360) + 360) % 360) - 180);

/** The satellite at a longitude the system table sends (the table's longitude has a 1.5 degree step); undefined when none is near. */
export function satelliteAt(lonDeg: number): AeroSatellite | undefined {
	let best: AeroSatellite | undefined;
	for (const s of AERO_SATELLITES)
		if (lonDiff(lonDeg, s.lonDeg) <= 1.6 && (!best || lonDiff(lonDeg, s.lonDeg) < lonDiff(lonDeg, best.lonDeg))) best = s;
	return best;
}

/** Azimuth and elevation (degrees) of a geostationary satellite at `lonSatDeg` seen from the ground. */
export function geoLook(latDeg: number, lonDeg: number, lonSatDeg: number): [azDeg: number, elDeg: number] {
	const d2r = Math.PI / 180,
		Re = 6378.137,
		Rs = 42164.17;
	const la = latDeg * d2r,
		lo = lonDeg * d2r,
		ls = lonSatDeg * d2r;
	const px = Re * Math.cos(la) * Math.cos(lo),
		py = Re * Math.cos(la) * Math.sin(lo),
		pz = Re * Math.sin(la);
	const dx = Rs * Math.cos(ls) - px,
		dy = Rs * Math.sin(ls) - py,
		dz = -pz;
	const e = -Math.sin(lo) * dx + Math.cos(lo) * dy;
	const n = -Math.sin(la) * Math.cos(lo) * dx - Math.sin(la) * Math.sin(lo) * dy + Math.cos(la) * dz;
	const u = Math.cos(la) * Math.cos(lo) * dx + Math.cos(la) * Math.sin(lo) * dy + Math.sin(la) * dz;
	const r = Math.hypot(dx, dy, dz);
	const az = Math.atan2(e, n) / d2r;
	return [az < 0 ? az + 360 : az, Math.asin(u / r) / d2r];
}
