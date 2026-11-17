// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir rust/onair_hfdl/src/parse.rs (coord_deg, read_pos_time, read_hfnpdu,
// khz_list, khz_mask) and core/src/hfdl/hfdl_proto.cpp (hfdlReadAcars), https://github.com/adswill/OnAir; see
// third_party/onair. Protocol facts as OnAir credits them: ARINC 635 / ICAO Doc 9741 as dumphfdl (szpajder, GPL-3.0)
// implements them, read for reference. Changes: the detail lines are labelled; the ACARS block is read with BrowSDR's
// ACARS block reader of the VDL2 decoder (vdl2/acars.ts, OnAir's ACARS layer as ported there), so the ADS-C, CPDLC
// and position-text readers OnAir runs on it (its aero code) are not ported: positions come from the performance and
// frequency data.
//
// The HFNPDU at the start of an unnumbered data LPDU: 0xFF, then the type: 0xD1 performance data, 0xD5 frequency data,
// 0xD0 system table (a part of it: not reassembled), 0xD2 system table request, 0xDE delayed echo, 0xFF ACARS.
// Positions: 20-bit two's complement latitude and longitude, 180 / 2^19 degrees per step; UTC in 2 s steps.

import { acarsCrc, acarsLines, acarsParseBlock, acarsSummary } from '@/worker/decoders/digimode/vdl2/acars';
import { gsName, maskKhz } from './stations';
import type { HfdlMessage } from './types';

const SOH = 0x01;

/** Two digits for 0 .. 9, as OnAir's d2. */
export const d2 = (v: number): string => (v >= 0 && v < 10 ? `0${v}` : String(v));
/** hh:mm:ss of seconds of the day. */
export const hms = (t: number): string => `${d2(Math.trunc(t / 3600) % 24)}:${d2(Math.trunc((t % 3600) / 60))}:${d2(t % 60)}`;
/** Upper case hex, zero padded. */
export const hex = (v: number, width: number): string => v.toString(16).toUpperCase().padStart(width, '0');

/** A frequency list: kHz, or "bitN" for entries beyond the table; "none" when empty. */
export function khzList(k: readonly number[]): string {
	if (!k.length) return 'none';
	return k.map((v) => (v > 0 ? String(v) : `bit${-v - 1}`)).join(' ');
}
export const khzMask = (gs: number, mask: number): string => khzList(maskKhz(gs, mask));

function coordDeg(raw: number): number {
	let v = raw & 0xfffff;
	if (v & 0x80000) v -= 0x100000;
	return (v * 180) / 524288;
}

/** The flight id, latitude, longitude and UTC time at h[2 .. 15] of a performance / frequency data HFNPDU. */
function readPosTime(h: Uint8Array, m: HfdlMessage, what: string): void {
	let fl = '';
	for (const c of h.subarray(2, 8)) if (c >= 0x20 && c < 0x7f) fl += String.fromCharCode(c);
	fl = fl.replace(/^ +| +$/g, '');
	const la = h[8] | (h[9] << 8) | ((h[10] & 0xf) << 16);
	const lo = ((h[10] & 0xf0) >> 4) | (h[11] << 4) | (h[12] << 12);
	const t = (h[13] | (h[14] << 8)) * 2;
	m.flight = fl;
	m.lat = coordDeg(la);
	m.lon = coordDeg(lo);
	m.hasPos = Math.abs(m.lat) <= 90 && Math.abs(m.lon) <= 180 && !(la === 0 && lo === 0);
	m.posKind = what;
	m.utcSec = t;
	m.detail.push([what, `flight ${fl || '-'}, position ${m.lat.toFixed(4)} ${m.lon.toFixed(4)}, time ${hms(t)} UTC`]);
}

const nums = (h: Uint8Array, from: number, to: number): string => [...h.subarray(from, to)].join(' ');

function performanceData(h: Uint8Array, m: HfdlMessage): void {
	m.hfnpdu = 'Performance data';
	if (h.length < 47) {
		m.summary = 'Performance data (short)';
		return;
	}
	readPosTime(h, m, 'Performance data');
	m.detail.push(['Performance', `version ${h[15]}, flight leg ${h[16]}, ground station ${gsName(h[17] & 0x7f)}, frequency id ${h[18]}`]);
	m.detail.push([
		'Counters',
		`MPDUs received 1800/1200/600/300: ${nums(h, 27, 31)}, with errors ${nums(h, 31, 35)}; SPDUs received ${h[35] | (h[36] << 8)}, missed ${h[37]}`,
	]);
	m.summary = `Performance data ${m.flight}  ${m.lat.toFixed(3)} ${m.lon.toFixed(3)}`;
}

function frequencyData(h: Uint8Array, m: HfdlMessage): void {
	m.hfnpdu = 'Frequency data';
	if (h.length < 15) {
		m.summary = 'Frequency data (short)';
		return;
	}
	readPosTime(h, m, 'Frequency data');
	let cnt = 0;
	for (let p = 15; p + 6 <= h.length && cnt < 6; p += 6, cnt++) {
		const gs = h[p] & 0x7f;
		const heard = h[p + 1] | (h[p + 2] << 8) | ((h[p + 3] & 0xf) << 16);
		const tuned = ((h[p + 3] & 0xf0) >> 4) | (h[p + 4] << 4) | (h[p + 5] << 12);
		m.detail.push(['Station', `${gsName(gs)}: heard on ${khzMask(gs, heard)} kHz, listening on ${khzMask(gs, tuned)} kHz`]);
	}
	m.summary = `Frequency data ${m.flight}  ${m.lat.toFixed(3)} ${m.lon.toFixed(3)}, ${cnt} station${cnt === 1 ? '' : 's'} heard`;
}

/** The ACARS block of an HFNPDU (the octets after its FF FF): the fields, summary and detail of m. */
export function readAcars(block: Uint8Array, m: HfdlMessage): void {
	m.hfnpdu = 'ACARS';
	const p = block.length && block[0] === SOH ? block.subarray(1) : block;
	let end = p.length;
	if (end && p[end - 1] === 0x7f) end--;
	if (end < 13 + 2) {
		m.summary = 'ACARS: cut short';
		m.detail.push(['ACARS', `${block.length} octets, too short`]);
		return;
	}
	const bl = end - 2;
	const a = acarsParseBlock(
		p.subarray(0, bl).map((c) => c & 0x7f),
		acarsCrc(p.subarray(0, bl + 2)) === 0,
	);
	if (!a) {
		m.summary = 'ACARS: not a valid block';
		m.detail.push(['ACARS', 'the block layout is not valid']);
		return;
	}
	m.acars = a;
	m.flight = a.flight;
	m.summary = acarsSummary(a);
	m.detail.push(...acarsLines(a));
}

/** The HFNPDU at the start of `h` (an LPDU body without its type octet and check sequence). */
export function readHfnpdu(h: Uint8Array, m: HfdlMessage): void {
	const n = h.length;
	if (n < 2 || h[0] !== 0xff) {
		m.summary = `${m.kind} (${n} octets, not an HFNPDU)`;
		m.detail.push(['User data', `${n} octets`]);
		return;
	}
	switch (h[1]) {
		case 0xff:
			readAcars(h.subarray(2), m);
			return;
		case 0xd1:
			performanceData(h, m);
			return;
		case 0xd5:
			frequencyData(h, m);
			return;
		case 0xd0:
			m.hfnpdu = 'System table';
			if (n >= 5) {
				const part = `part ${h[2] & 0xf} of ${(h[2] >> 4) + 1}, version ${(h[3] >> 4) | (h[4] << 4)}`;
				m.summary = `System table ${part}`;
				m.detail.push(['System table', part]);
			}
			return;
		case 0xd2:
			m.hfnpdu = m.summary = 'System table request';
			return;
		case 0xde:
			m.hfnpdu = m.summary = 'Delayed echo';
			return;
		default:
			m.hfnpdu = 'HFNPDU';
			m.summary = `HFNPDU type 0x${hex(h[1], 2)} (${n} octets)`;
	}
}
