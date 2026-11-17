// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/include/dect2/fusion/fusion_gps.h (ysfRadioName, ysfGpsParse),
// https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the parser is split into helpers and returns a record.
//
// Yaesu System Fusion GPS in the slow data of V/D mode 1 and 2: tags 0x22 0x62 or 0x47 0x64, packed digit latitude and
// longitude, the radio model byte. OnAir took the layout from Jonathan Naylor's YSFGateway (GPL-2.0-or-later) and
// checked it on simulated blocks only: no off-air recording of this block was available.
import type { YsfGps } from './types';

const RADIOS: Readonly<Record<number, string>> = {
	0x20: 'DR-2X',
	0x24: 'FT-1D',
	0x25: 'FTM-400D',
	0x26: 'DR-1X',
	0x27: 'FT-991A',
	0x28: 'FT-2D',
	0x29: 'FTM-100D',
	0x30: 'FT-3D',
	0x31: 'FTM-300D',
	0x33: 'FT-5D',
};

export function ysfRadioName(b: number): string {
	return RADIOS[b] ?? `0x${b.toString(16).toUpperCase().padStart(2, '0')}`;
}

const NONE: YsfGps = { ok: false, lat: 0, lon: 0, radio: '' };

/** The end marker 0x03 scanning backward, whose 8-bit sum of everything before matches the next byte. */
function findEnd(b: Uint8Array, n: number): number {
	for (let i = n - 2; i > 0; i--) {
		if (b[i] !== 0x03) continue;
		let c = 0;
		for (let k = 0; k <= i; k++) c = (c + b[k]) & 0xff;
		if (c === b[i + 1]) return i;
	}
	return -1;
}

function longitudeDegrees(range: number, v: number): number {
	if (range === 5) {
		if (v >= 0x76 && v <= 0x7f) return v - 0x76;
		if (v >= 0x6c && v <= 0x75) return 100 + v - 0x6c;
		if (v >= 0x26 && v <= 0x6b) return 110 + v - 0x26;
	} else if (range === 3 && v >= 0x26 && v <= 0x7f) return 10 + v - 0x26;
	return -1;
}

function longitudeMinutes(m: number): number {
	if (m >= 0x58 && m <= 0x61) return m - 0x58;
	if (m >= 0x26 && m <= 0x57) return 10 + m - 0x26;
	return -1;
}

/** Latitude in degrees from the packed digits of b[5..10]; NaN when they are not a latitude. */
function latitude(b: Uint8Array): number {
	for (let i = 5; i <= 10; i++) if (b[i] >> 4 !== 5 && b[i] >> 4 !== 3) return NaN;
	const laD = (b[5] & 15) * 10 + (b[6] & 15);
	const laM = (b[7] & 15) * 10 + (b[8] & 15);
	const laF = (b[9] & 15) * 10 + (b[10] & 15);
	if (laD > 89 || laM > 59 || laF > 99) return NaN;
	const sign = b[8] >> 4 === 5 ? 1 : -1;
	return sign * (laD + (laM + laF * 0.01) / 60);
}

/** Longitude in degrees from b[9..13]; NaN when they are not a longitude. */
function longitude(b: Uint8Array): number {
	const sign = b[10] >> 4 === 3 ? 1 : -1;
	const loD = longitudeDegrees(b[9] >> 4, b[11]);
	const loM = longitudeMinutes(b[12]);
	const fr = b[13] >= 0x1c && b[13] <= 0x7f ? b[13] - 0x1c : -1;
	if (loD < 0 || loM < 0 || fr < 0 || fr > 99 || loD > 179 || loM > 59) return NaN;
	return sign * (loD + (loM + fr * 0.01) / 60);
}

/** b holds n assembled slow data bytes (offsets as in YSFGateway). */
export function ysfGpsParse(b: Uint8Array, n: number): YsfGps {
	if (n < 15) return NONE;
	if (!((b[1] === 0x22 && b[2] === 0x62) || (b[1] === 0x47 && b[2] === 0x64))) return NONE;
	if (findEnd(b, n) < 14) return NONE;
	const lat = latitude(b);
	const lon = longitude(b);
	if (Number.isNaN(lat) || Number.isNaN(lon)) return NONE;
	return { ok: true, lat, lon, radio: ysfRadioName(b[4]) };
}
