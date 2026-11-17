// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/aero/aero_rx.cpp (onFrame: what a message, a log-on and a
// position say in the log; addPosition) and app/aero/aero_ui.cpp (the message detail: aircraft, ground station, label,
// flight, text, ADS-C and CPDLC, position, carrier), https://github.com/adswill/OnAir; see third_party/onair. Changes: one
// log record per message, log-on and system table fact, with labelled fields; the distance from the station when it is
// set; an ADS-C emergency report is an alert.

import { adscFields } from './adsc';
import { aeroDecodeCpdlc, aeroDescribeCpdlc } from './arinc';
import { aeroPositionFromMessage } from './pos';
import { geoLook, satelliteAt } from './satellites';
import { lonText } from './su';
import type { AeroAcars, AeroFields, AeroHeard, AeroLogon, AeroPosition, AeroRecord as Rec, AeroSysInfo } from './types';

const hex = (v: number, n: number): string => v.toString(16).toUpperCase().padStart(n, '0');
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const signed = (v: number, digits: number): string => `${v > 0 ? '+' : ''}${v.toFixed(digits)}`;

/** Great circle distance, km. */
function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const r = Math.PI / 180;
	const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
	return 12742 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** "A6-EUA (896411)", "896411", or the registration alone. */
export function aircraftName(aesId: number, registration: string): string {
	if (!aesId) return registration || 'unknown aircraft';
	return registration ? `${registration} (${hex(aesId, 6)})` : `AES ${hex(aesId, 6)}`;
}

export const heardText = (h: AeroHeard): string =>
	`${h.bitRate} bit/s P channel at ${signed(h.offsetHz / 1000, 3)} kHz from the VFO, Eb/N0 ${h.ebn0Db.toFixed(1)} dB`;

function positionText(p: AeroPosition, station: [number, number] | null): string {
	let s = `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`;
	if (p.altFt !== null) s += ` · ${p.altFt} ft`;
	if (p.speedKt !== null) s += ` · ${Math.round(p.speedKt)} kt`;
	if (p.trackDeg !== null) s += ` · ${Math.round(p.trackDeg)}°`;
	if (station) s += ` · ${distanceKm(station[0], station[1], p.lat, p.lon).toFixed(0)} km`;
	return s;
}

function acarsFields(m: AeroAcars): AeroFields {
	const f: AeroFields = [];
	if (m.label) f.push(['Label', `${m.label}${m.labelText ? ` (${m.labelText})` : ''}`]);
	if (m.flight) f.push(['Flight', m.flight]);
	if (m.blockId) f.push(['Block id', m.blockId]);
	if (m.msgNo) f.push(['Message number', m.msgNo]);
	if (m.mode) f.push(['Mode', m.mode]);
	if (m.sublabel || m.mfi) f.push(['Sublabel / MFI', `${m.sublabel || '-'} / ${m.mfi || '-'}`]);
	if (m.text) f.push([m.binary ? 'User data (hex)' : 'Text', m.text.slice(0, 4000)]);
	if (m.decoded) f.push(['Reading', m.decoded]);
	return f;
}

/** The summary of a message: direction and aircraft, then what it carries. */
function headline(m: AeroAcars, pos: AeroPosition | null, what: string, station: [number, number] | null): string {
	const who = `${m.uplink ? 'Uplink to' : 'Downlink from'} ${aircraftName(m.aesId, m.registration)}`;
	const label = m.binary
		? 'User data (not ACARS)'
		: `ACARS ${m.label}${m.labelText ? ` (${m.labelText})` : ''}${m.flight ? ` ${m.flight}` : ''}`;
	const where = pos ? ` · position ${positionText(pos, station)}` : '';
	const body = what ? '' : oneLine(m.text); // an ADS-C or CPDLC application is read in the fields
	return `${who} · ${what || label}${where}${body ? `: ${body}` : ''}`.slice(0, 2000);
}

/** One record for an ACARS message with its ADS-C, CPDLC and position readings. */
export function acarsRecord(m: AeroAcars, heard: AeroHeard, station: [number, number] | null): { rec: Rec; pos: AeroPosition | null } {
	const { adsc, pos } = m.crcOk && !m.binary ? aeroPositionFromMessage(m.label, m.text, m.uplink) : { adsc: null, pos: null };
	const cpdlc = m.crcOk && !m.binary && !adsc ? aeroDecodeCpdlc(m.text) : null;
	const fields: AeroFields = [
		['Direction', m.uplink ? 'uplink (ground to aircraft)' : 'downlink (aircraft to ground)'],
		['Aircraft', aircraftName(m.aesId, m.registration)],
		['Ground earth station', m.gesId >= 0 ? `GES ${hex(m.gesId, 2)}` : '-'],
		...acarsFields(m),
	];
	if (adsc) fields.push(...adscFields(adsc));
	if (cpdlc) fields.push(['CPDLC', aeroDescribeCpdlc(cpdlc)]);
	if (pos) fields.push(['Position', `${positionText(pos, station)} (${pos.kind})`]);
	fields.push(['Channel', heardText(heard)]);
	fields.push(['Check', m.crcOk ? 'block check and parity good' : 'block check or parity FAILED']);
	const what = adsc
		? `ADS-C ${adsc.disconnect ? 'disconnect' : adsc.uplink ? 'contract request' : 'report'}`
		: cpdlc
			? `CPDLC ${cpdlc.imi}`
			: '';
	return {
		rec: { text: headline(m, pos, what, station), fields: fields.slice(0, 64), damaged: !m.crcOk, alert: pos?.emergency ?? false },
		pos,
	};
}

export function logonRecord(l: AeroLogon, registration: string, heard: AeroHeard): Rec {
	const who = aircraftName(l.aesId, registration);
	return {
		text: `${l.logon ? 'Log-on' : 'Log-off'}: ${who} at GES ${hex(Math.max(l.gesId, 0), 2)}`,
		fields: [
			['Aircraft', who],
			['Ground earth station', `GES ${hex(Math.max(l.gesId, 0), 2)}`],
			['Channel', heardText(heard)],
		],
	};
}

/** A system table fact: the satellite (named, and its place in the station's sky) or a P channel the ground station lists. */
export function systemRecord(si: AeroSysInfo, heard: AeroHeard, station: [number, number] | null): Rec {
	const beam = si.spotBeam ? 'spot beam' : 'global beam';
	const fields: AeroFields = [['Channel', heardText(heard)]];
	if (si.kind === 3) {
		const text = `System table: GES ${hex(si.gesId, 2)} P channel ${si.freqMHz[0].toFixed(4)} MHz at ${si.bitRate || '?'} bit/s, ${beam}`;
		return { text, fields };
	}
	const sat = satelliteAt(si.lonDeg);
	let text = `System table: satellite ${si.satId} at ${lonText(si.lonDeg)}${sat ? ` (${sat.name})` : ''}, P channel ${si.freqMHz[0].toFixed(4)} MHz`;
	if (si.freqMHz[1] > 0) text += ` and ${si.freqMHz[1].toFixed(4)} MHz`;
	text += `, ${beam}`;
	if (station) {
		const [az, el] = geoLook(station[0], station[1], si.lonDeg);
		fields.unshift([
			'Seen from the station',
			`azimuth ${az.toFixed(0)}°, elevation ${el.toFixed(0)}°${el < 0 ? ' (below the horizon)' : ''}`,
		]);
	}
	return { text, fields };
}
