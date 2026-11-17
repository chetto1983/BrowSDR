// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/hfdl/hfdl_rx.cpp (HfdlReceiver::Impl::note and expire: the
// logon table that names aircraft ids, the aircraft and ground station tables) and core/include/dect2/limits.h
// (kAeroStaleSec), https://github.com/adswill/OnAir; see third_party/onair. Changes: the tables only name the aircraft
// in later records and count them in the status (OnAir's HFDL screens, track history, results file and automations
// are left out); the record text and fields are BrowSDR's, with the distance from the station when it is set.

import { greatCircle } from '@/worker/decoders/digimode/flarm/report';
import type { DigimodePosition } from '@/worker/decoders/digimode/types';
import { hex } from './hfnpdu';
import { hfdlStation } from './stations';
import type { HfdlAircraftEntry, HfdlBurst, HfdlLine, HfdlMessage } from './types';

/** An aircraft not heard for this long leaves the table (OnAir's 6 h), signal seconds. */
const STALE_SEC = 6 * 3600;
/** Table sizes, a safety cap. */
const MAX_AIRCRAFT = 2000;
const MAX_FIELDS = 64;

/** The aircraft heard and the ground stations heard directly, as OnAir's note() keeps them. */
export class HfdlBook {
	/** gs << 8 | aircraft id -> ICAO address, from logon confirms. */
	private readonly acIcao = new Map<number, number>();
	readonly aircraft = new Map<number, HfdlAircraftEntry>();
	readonly stations = new Set<number>();

	/** Notes a message at `now` signal seconds; fills its address from the logon table; returns the aircraft entry. */
	note(m: HfdlMessage, now: number): HfdlAircraftEntry | undefined {
		if (m.squitter) {
			this.stations.add(m.gsId);
			return undefined;
		}
		if (m.gsId && m.uplink) this.stations.add(m.gsId);
		const slot = (m.gsId << 8) | (m.acId & 0xff);
		this.logon(m, slot);
		const reg = m.acars?.reg ?? '';
		if (!m.icao && m.acId <= 0 && !reg) return undefined;
		const a = this.entry(m.icao ? m.icao : 0x1000000 | slot, slot, now);
		if (m.icao) a.icao = m.icao;
		if (m.acId > 0) a.acId = m.acId;
		a.gsId = m.gsId;
		if (reg) a.reg = reg;
		if (m.flight) a.flight = m.flight;
		if (m.kind === 'Logon confirm') a.loggedOn = true;
		if (m.kind === 'Logoff request' || m.kind === 'Logon denied') a.loggedOn = false;
		this.expire(now);
		return a;
	}

	/** A logon confirm names the aircraft id's address; a message with an id only gets the address named. */
	private logon(m: HfdlMessage, slot: number): void {
		if ((m.kind === 'Logon confirm' || m.kind === 'Logon resume confirm') && m.icao && m.acId >= 0) {
			if (this.acIcao.size >= MAX_AIRCRAFT) this.acIcao.delete(this.acIcao.keys().next().value!);
			this.acIcao.set(slot, m.icao);
		}
		if (!m.icao && m.acId > 0) m.icao = this.acIcao.get(slot) ?? 0;
	}

	/** The entry of `key` (taken over from the aircraft id's entry once the address is known), moved to the newest end. */
	private entry(key: number, slot: number, now: number): HfdlAircraftEntry {
		let a = this.aircraft.get(key);
		if (!a && key < 0x1000000) {
			a = this.aircraft.get(0x1000000 | slot);
			if (a) this.aircraft.delete(a.key);
		}
		a ??= { key, icao: 0, acId: -1, gsId: 0, reg: '', flight: '', lastHeardSec: now, loggedOn: false };
		a.key = key;
		a.lastHeardSec = now;
		// most recently heard last; the oldest expire by age, then by the safety cap
		this.aircraft.delete(key);
		this.aircraft.set(key, a);
		return a;
	}

	private expire(now: number): void {
		for (const [key, a] of this.aircraft) {
			if (now - a.lastHeardSec <= STALE_SEC && this.aircraft.size <= MAX_AIRCRAFT) break;
			this.aircraft.delete(key);
		}
	}
}

/** "GS 7 Shannon". */
const gsLabel = (id: number): string => `GS ${id}${hfdlStation(id) ? ` ${hfdlStation(id)!.name}` : ''}`;

/** An aircraft as the record line names it: its address (and registration), else its id at the ground station. */
function aircraftLabel(m: HfdlMessage, a: HfdlAircraftEntry | undefined): string {
	const reg = m.acars?.reg || a?.reg;
	const id = m.icao ? hex(m.icao, 6) : m.acId >= 0 ? `AC ${m.acId}` : 'aircraft';
	return reg ? `${id} (${reg})` : id;
}

/** The record line of a message. */
export function recordText(m: HfdlMessage, a: HfdlAircraftEntry | undefined): string {
	if (m.squitter) return m.summary;
	const air = aircraftLabel(m, a);
	const gs = gsLabel(m.gsId);
	const route = m.uplink ? `${gs} → ${air}` : `${air} → ${gs}`;
	return `${route} · ${m.summary || m.kind}`.slice(0, 2000);
}

/**
 * The map position of a message with one: the aircraft by its address, else by its id at the ground station or its
 * flight (these are prefixed with "HFDL").
 */
export function recordPosition(m: HfdlMessage, a: HfdlAircraftEntry | undefined): DigimodePosition | undefined {
	if (!m.hasPos) return undefined;
	const flight = m.flight || a?.flight || '';
	const id = m.icao ? hex(m.icao, 6) : m.acId > 0 ? `HFDL ${m.gsId}/${m.acId}` : flight ? `HFDL ${flight}` : '';
	if (!id) return undefined;
	return flight ? { id, lat: m.lat, lon: m.lon, label: flight } : { id, lat: m.lat, lon: m.lon };
}

/** Labels made unique (the log keys fields by label). */
function uniqueFields(lines: HfdlLine[]): HfdlLine[] {
	const seen = new Map<string, number>();
	return lines.slice(0, MAX_FIELDS).map(([label, value]) => {
		const count = (seen.get(label) ?? 0) + 1;
		seen.set(label, count);
		return [count > 1 ? `${label} (${count})` : label, value.slice(0, 4000)];
	});
}

/** Whole hertz with a sign. */
export const signedHz = (v: number): string => {
	const r = Math.round(v) || 0;
	return `${r > 0 ? '+' : ''}${r}`;
};

/** Who the message is about: the ground station (and its distance), the aircraft, its position (and distance). */
function who(m: HfdlMessage, a: HfdlAircraftEntry | undefined, station: { lat: number; lon: number } | null): HfdlLine[] {
	const out: HfdlLine[] = [];
	const gs = hfdlStation(m.gsId);
	if (m.gsId) {
		const far = gs && station ? `, ${greatCircle(station.lat, station.lon, gs.lat, gs.lon).km.toFixed(0)} km away` : '';
		out.push(['Ground station', `${m.gsId} ${gs?.name ?? '(not in the table)'}${far}`]);
	}
	if (!m.squitter) {
		if (m.icao) out.push(['ICAO address', hex(m.icao, 6)]);
		if (m.acId >= 0) out.push(['Aircraft id', String(m.acId)]);
		const reg = m.acars?.reg || a?.reg;
		if (reg) out.push(['Registration', reg]);
		const flight = m.flight || a?.flight;
		if (flight) out.push(['Flight', flight]);
	}
	if (m.hasPos) {
		out.push(['Position', `${m.lat.toFixed(5)}, ${m.lon.toFixed(5)} (${m.posKind})`]);
		if (station) {
			const g = greatCircle(station.lat, station.lon, m.lat, m.lon);
			out.push(['Distance', `${g.km.toFixed(0)} km, bearing ${g.bearingDeg.toFixed(0)}°`]);
		}
	}
	return out;
}

const MODES = ['', ', decoded without the equaliser', ', decoded on the known symbols only'];

/** The fields of a message's record: who, where, the decoded layers, the signal. */
export function recordFields(
	m: HfdlMessage,
	a: HfdlAircraftEntry | undefined,
	b: HfdlBurst,
	station: { lat: number; lon: number } | null,
): HfdlLine[] {
	const out = who(m, a, station);
	out.push(...m.detail.slice(0, MAX_FIELDS - 12));
	const slots = b.rate.twoSlots ? '2 slots (4.2 s interleaver)' : '1 slot (1.8 s interleaver)';
	out.push(['Signal', `level ${b.levelDb.toFixed(1)} dB, SNR ${b.snrDb.toFixed(1)} dB, carrier ${signedHz(b.cfoHz)} Hz`]);
	out.push(['Burst', `${b.rate.bps} bit/s, ${slots}${MODES[b.mode]}`]);
	return uniqueFields(out);
}
