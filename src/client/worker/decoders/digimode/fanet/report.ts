// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/avroad/avroad_air.cpp (FanetDec::feed: the row of a frame, its
// kind, the "%02X:%04X" sender, the text and the position), https://github.com/adswill/OnAir; see third_party/onair.
// Format facts as credited there: the FANET protocol description (protocol.txt of Skytraxx's fanet-stm32,
// https://github.com/3s1d/fanet-stm32; format only, no code copied). Changes: a tracking frame becomes BrowSDR's
// aircraft record (the one FLARM, OGN and ADS-L use); the other frames get a line and labelled fields of their values,
// with the distance from the station; the sender's name, once heard, is added to its later records.

import { greatCircle } from '@/worker/decoders/digimode/flarm/report';
import type { AircraftReport, LatLon } from '@/worker/decoders/digimode/flarm/types';
import { AIRCRAFT, fanetAddress, groundAlert, groundName, landmarkName, layerName, manufacturerName, sectorNames, typeName } from './names';
import type { FanetFrame, FanetLandmark, FanetRecord, FanetService, FanetThermal } from './types';

const signed = (v: number, digits: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(digits)}`;
const coordinates = (lat: number, lon: number): string => `${lat.toFixed(5)}, ${lon.toFixed(5)}`;

/** Forwarding, destination and signature: the fields every frame may carry. */
function headerFields(f: FanetFrame): Array<[string, string]> {
	const out: Array<[string, string]> = [];
	if (f.unicast) out.push(['To', `${fanetAddress(f.destManufacturer, f.destDevice)}, ${manufacturerName(f.destManufacturer)}`]);
	if (f.forward) out.push(['Forward', 'requested']);
	if (f.hasSignature) out.push(['Signature', 'present (not checked)']);
	return out;
}

/** A tracking frame as BrowSDR's aircraft report. */
export function trackingReport(f: FanetFrame, name: string | undefined): AircraftReport {
	const extra: Array<[string, string]> = [];
	if (name) extra.push(['Name', name]);
	if (f.turnRateDegS !== undefined) extra.push(['Turn rate', `${signed(f.turnRateDegS, 2)}°/s`]);
	if (f.qneOffsetM !== undefined) extra.push(['QNE offset', `${signed(f.qneOffsetM, 0)} m`]);
	extra.push(...headerFields(f));
	return {
		protocol: 'FANET',
		id: fanetAddress(f.manufacturer, f.device),
		idType: `FANET address, ${manufacturerName(f.manufacturer)}`,
		aircraft: AIRCRAFT[f.aircraftType],
		lat: f.lat,
		lon: f.lon,
		altM: f.altM,
		speedKmh: f.speedKmh,
		headingDeg: f.headingDeg,
		climbMs: f.climbMs,
		channel: -1,
		extra,
	};
}

function serviceFields(s: FanetService): Array<[string, string]> {
	const out: Array<[string, string]> = [['Internet gateway', s.gateway ? 'yes' : 'no']];
	if (s.tempC !== undefined) out.push(['Temperature', `${s.tempC.toFixed(1)} °C`]);
	if (s.windDeg !== undefined)
		out.push(['Wind', `${s.windKmh?.toFixed(1)} km/h from ${s.windDeg.toFixed(0)}°, gusts ${s.gustKmh?.toFixed(1)} km/h`]);
	if (s.humidityPct !== undefined) out.push(['Humidity', `${s.humidityPct.toFixed(0)} %`]);
	if (s.pressureHpa !== undefined) out.push(['Pressure', `${s.pressureHpa.toFixed(1)} hPa`]);
	if (s.chargePct !== undefined) out.push(['State of charge', `${s.chargePct.toFixed(0)} %`]);
	if (s.remoteConfig) out.push(['Remote configuration', 'supported']);
	return out;
}

const thermalFields = (t: FanetThermal): Array<[string, string]> => [
	['Thermal top', `${t.altM} m`],
	['Climb of the air', `${signed(t.climbMs, 1)} m/s`],
	['Quality', `${Math.round((t.quality * 100) / 7)} %`],
	['Wind', `${t.windKmh.toFixed(1)} km/h from ${t.windDeg.toFixed(0)}°`],
];

function landmarkFields(lm: FanetLandmark): Array<[string, string]> {
	const out: Array<[string, string]> = [
		['Landmark', landmarkName(lm.subtype)],
		['Layer', layerName(lm.layer)],
	];
	if (lm.text !== undefined) out.push(['Text', lm.text]);
	if (lm.points.length) out.push(['Points', lm.points.map(([lat, lon]) => coordinates(lat, lon)).join('; ')]);
	if (lm.radiusM !== undefined) out.push(['Radius', `${lm.radiusM} m`]);
	if (lm.altBottomM !== undefined) out.push(['Altitudes', `${lm.altBottomM} - ${lm.altTopM} m`]);
	if (lm.windSectors !== undefined) out.push(['Shown with wind from', sectorNames(lm.windSectors)]);
	out.push(['Lives', `${lm.ttlMin} min`]);
	return out;
}

/** The fields of a frame's payload. */
function payloadFields(f: FanetFrame): Array<[string, string]> {
	if (f.name !== undefined) return [['Name', f.name]];
	if (f.message !== undefined) return [['Message', f.message]];
	if (f.service) return serviceFields(f.service);
	if (f.thermal) return thermalFields(f.thermal);
	if (f.landmark) return landmarkFields(f.landmark);
	if (f.groundType !== undefined) return [['State', groundName(f.groundType)]];
	return f.type === 9 || f.type === 0 ? [] : [['Content', f.text]];
}

/** The record of any frame but tracking: sender (and destination), what it says, where, how far. */
export function frameRecord(f: FanetFrame, name: string | undefined, station: LatLon | null): FanetRecord {
	const id = fanetAddress(f.manufacturer, f.device);
	const head = `FANET ${id}${f.unicast ? ` → ${fanetAddress(f.destManufacturer, f.destDevice)}` : ''}`;
	const parts = [head, f.text];
	const fields: Array<[string, string]> = [
		['Protocol', 'FANET'],
		['Sender', id],
		['Manufacturer', manufacturerName(f.manufacturer)],
	];
	if (name && f.name === undefined) fields.push(['Name', name]);
	fields.push(['Frame', typeName(f.type)], ...payloadFields(f));
	if (f.hasPos) {
		const pos = coordinates(f.lat, f.lon);
		parts.push(pos);
		fields.push(['Position', pos]);
		if (station) {
			const g = greatCircle(station.lat, station.lon, f.lat, f.lon);
			parts.push(`${g.km.toFixed(1)} km`);
			fields.push(['Distance', `${g.km.toFixed(1)} km, bearing ${g.bearingDeg.toFixed(0)}°`]);
		}
	}
	fields.push(...headerFields(f));
	const alert = f.groundType !== undefined && groundAlert(f.groundType);
	return alert ? { text: parts.join(' · '), fields, alert } : { text: parts.join(' · '), fields };
}
