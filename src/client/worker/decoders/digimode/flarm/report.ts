// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/geo/maidenhead.cpp (greatCircle) and the aircraft rows of
// core/src/flarm/flarm_rx.cpp and core/src/adsl/adsl_rx.cpp (Rec, expire: an aircraft silent for 60 s leaves the
// table), https://github.com/adswill/OnAir; see third_party/onair. Changes: the aircraft table only paces the records
// (the first packet of an aircraft at once, then one record per aircraft every 5 s of signal); the record text and
// fields are BrowSDR's; the packets of an input block go through FrameQueue (one copy of each, in time order).

import type { AircraftEntry, AircraftReport, LatLon, QueuedFrame } from './types';

/** The same packet within this time is a copy (another phase, or the other channel), s. */
const COPY_SEC = 0.004;
/** An aircraft heard again within this time continues its record pace, s. */
const EXPIRY_SEC = 60;
/** At most one record per aircraft in this time, s. */
export const REPORT_SEC = 5;
const CHANNELS = ['868.2 MHz', '868.4 MHz'];

/** Great-circle distance (km) and initial bearing (degrees) from point 1 to point 2. */
export function greatCircle(lat1: number, lon1: number, lat2: number, lon2: number): { km: number; bearingDeg: number } {
	const r = Math.PI / 180;
	const p1 = lat1 * r;
	const p2 = lat2 * r;
	const dl = (lon2 - lon1) * r;
	const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
	const km = 2 * 6371.0088 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
	const b = Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) / r;
	return { km, bearingDeg: (b + 360) % 360 };
}

const signed = (v: number, digits: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(digits)}`;

/** The headline values that a record line and its fields share. */
function values(r: AircraftReport, station: LatLon | null): Array<[string, string, string]> {
	const out: Array<[string, string, string]> = [];
	if (r.lat !== undefined && r.lon !== undefined) {
		const pos = `${r.lat.toFixed(5)}, ${r.lon.toFixed(5)}`;
		out.push(['Position', pos, pos]);
	}
	if (r.altM !== undefined) out.push(['Altitude', `${r.altM.toFixed(0)} m`, `${r.altM.toFixed(0)} m`]);
	if (r.speedKmh !== undefined) out.push(['Speed', `${r.speedKmh.toFixed(0)} km/h`, `${r.speedKmh.toFixed(0)} km/h`]);
	if (r.trackDeg !== undefined) out.push(['Track', `${r.trackDeg.toFixed(0)}°`, `track ${r.trackDeg.toFixed(0)}°`]);
	if (r.climbMs !== undefined) out.push(['Climb', `${signed(r.climbMs, 1)} m/s`, `${signed(r.climbMs, 1)} m/s`]);
	if (station && r.lat !== undefined && r.lon !== undefined) {
		const g = greatCircle(station.lat, station.lon, r.lat, r.lon);
		out.push(['Distance', `${g.km.toFixed(1)} km, bearing ${g.bearingDeg.toFixed(0)}°`, `${g.km.toFixed(1)} km`]);
	}
	return out;
}

/** The record of an aircraft: one line, then the fields. */
export function aircraftRecord(
	r: AircraftReport,
	station: LatLon | null,
): { text: string; fields: Array<[string, string]>; alert?: boolean } {
	const v = values(r, station);
	const head = `${r.protocol} ${r.id} · ${r.aircraft}`;
	const text = r.note ? `${head} · ${r.note}` : [head, ...v.map(([, , short]) => short)].join(' · ');
	const fields: Array<[string, string]> = [
		['Protocol', r.protocol === 'FLARM' ? 'FLARM (old protocol)' : r.protocol === 'OGN' ? 'OGN tracker' : 'ADS-L (M-band)'],
		['Aircraft ID', r.id],
		['ID type', r.idType],
		['Aircraft type', r.aircraft],
		...v.map(([label, long]): [string, string] => [label, long]),
	];
	if (r.note) fields.push(['Note', r.note]);
	if (r.lat === undefined && !r.note && r.protocol === 'FLARM') fields.push(['Position', 'needs the station location']);
	fields.push(...r.extra, ['Channel', CHANNELS[r.channel] ?? '?']);
	if (r.levelDb !== undefined && Number.isFinite(r.levelDb)) fields.push(['Level', `${r.levelDb.toFixed(1)} dB over the noise`]);
	return r.alert ? { text, fields, alert: true } : { text, fields };
}

/** The aircraft heard lately: a record for the first packet of each, then at most one every REPORT_SEC. */
export class AircraftTable {
	private readonly entries = new Map<string, AircraftEntry>();

	/** Whether this packet's report is due as a record. */
	update(key: string, report: AircraftReport, tnow: number): boolean {
		const e = this.entries.get(key);
		if (!e) {
			this.entries.set(key, { lastSeen: tnow, lastReport: tnow, packets: 1, report });
			return true;
		}
		e.lastSeen = tnow;
		e.packets++;
		const wasAlert = !!e.report.alert;
		e.report = report;
		if (tnow - e.lastReport < REPORT_SEC && (wasAlert || !report.alert)) return false;
		e.lastReport = tnow;
		return true;
	}

	expire(tnow: number): void {
		for (const [key, e] of this.entries) if (tnow - e.lastSeen > EXPIRY_SEC) this.entries.delete(key);
	}

	/** The aircraft and their packet counts (tests). */
	snapshot(): Array<[string, AircraftEntry]> {
		return [...this.entries];
	}

	/** Aircraft heard within the last seconds. */
	recent(tnow: number, seconds: number): number {
		let n = 0;
		for (const e of this.entries.values()) if (tnow - e.lastSeen <= seconds) n++;
		return n;
	}
}

/**
 * The packets of an input block in time order, each taken once: a copy within 4 ms (another phase, or the other channel,
 * where a strong signal comes through the channel filter 50 dB down) goes to the channel that heard it loudest.
 */
export class FrameQueue {
	private pending: QueuedFrame[] = [];
	private readonly recent = new Map<string, number>();

	push(frame: QueuedFrame): void {
		this.pending.push(frame);
	}

	flush(): void {
		if (!this.pending.length) return;
		const all = this.pending.sort((x, y) => x.t - y.t);
		this.pending = [];
		for (const c of all) {
			for (const [k, t] of this.recent) if (Math.abs(c.t - t) > 0.5) this.recent.delete(k);
			const seen = this.recent.get(c.key);
			if (seen !== undefined && Math.abs(c.t - seen) < COPY_SEC) continue;
			this.recent.set(c.key, c.t);
			all
				.filter((o) => o.key === c.key && Math.abs(o.t - c.t) < COPY_SEC)
				.reduce((x, y) => (y.level > x.level ? y : x))
				.apply();
		}
	}
}
