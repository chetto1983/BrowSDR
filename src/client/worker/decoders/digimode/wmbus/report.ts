// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/wmbus/wmbus_live.cpp (WmbusLiveReceiver::finish: the frame summary
// and the frame log), https://github.com/adswill/OnAir; see third_party/onair. Changes: one Digital Modes record per
// telegram in place of OnAir's device table and frame log; an encrypted payload names its security mode; a frame whose
// CRC failed is reported as such even when its records were also cut off.

import type { DigimodeRecord } from '@/worker/decoders/digimode/types';
import { phyName } from './proto';
import type { WmbusFrame, WmbusTelegram } from './types';

/** The panel's limit for one field. */
const MAX_FIELD = 4000;

const hex2 = (value: number) => value.toString(16).toUpperCase().padStart(2, '0');
const hex = (bytes: Uint8Array) => Array.from(bytes, hex2).join('');
const clip = (text: string) => (text.length > MAX_FIELD ? `${text.slice(0, MAX_FIELD - 1)}…` : text);

/** OnAir's one-line summary: the first readings, or what the payload is. */
function summary(f: WmbusFrame): string {
	if (f.encrypted) return `encrypted, ${f.encryption}`;
	if (f.records.length)
		return f.records
			.slice(0, 4)
			.map((r) => `${r.quantity} ${r.value}`)
			.join('; ');
	if (!f.payload.length) return 'no data';
	return f.hasManufacturerData ? 'manufacturer data' : f.ciName;
}

function signalFields(t: WmbusTelegram): Array<[string, string]> {
	return [
		['Level', `${t.levelDb.toFixed(1)} dBFS`],
		['Carrier offset', `${(t.cfoHz / 1000).toFixed(1)} kHz`],
	];
}

function goodRecord(t: WmbusTelegram, f: WmbusFrame): Omit<DigimodeRecord, 'id' | 'time' | 'mode'> {
	const header = f.shortHeader || f.longHeader;
	const readings = f.records.map((r) => `${r.quantity} ${r.value}${r.note ? ` (${r.note})` : ''}`).join('; ');
	const fields: Array<[string, string]> = [
		['Manufacturer', f.mfr],
		['ID', f.id],
		['Version', `0x${hex2(f.version)}`],
		['Device type', `${f.typeName} (0x${hex2(f.type)})`],
		['Mode', `${phyName(t.phy)}, frame format ${f.formatB ? 'B' : 'A'}`],
		['C field', `0x${hex2(f.C)} ${f.cName}`],
		['CI field', `0x${hex2(f.ci)} ${f.ciName}`],
		['Access number', header ? String(f.acc) : '—'],
	];
	if (header) fields.push(['Status', f.statusText]);
	fields.push(
		['Encryption', f.encrypted ? `${f.encryption}, payload not decrypted` : 'none'],
		['Length', `L = ${f.L}, ${t.bytes.length} bytes on air`],
		['CRC', 'ok'],
		...signalFields(t),
	);
	if (readings) fields.push(['Readings', clip(readings)]);
	if (f.error) fields.push(['Note', f.error]);
	fields.push(['Payload', clip(hex(f.payload))], ['Frame', clip(hex(f.data))]);
	return { text: `${f.mfr} ${f.typeName} ${f.id} · ${phyName(t.phy)} · ${summary(f)}`, fields };
}

function damagedRecord(t: WmbusTelegram, f: WmbusFrame): Omit<DigimodeRecord, 'id' | 'time' | 'mode'> {
	const reason = f.error && f.error !== 'record cut off' ? f.error : 'CRC failed';
	const who = f.mfr ? `${f.mfr} ${f.id}` : '?';
	const fields: Array<[string, string]> = [];
	if (f.mfr) fields.push(['Manufacturer', f.mfr], ['ID', f.id]);
	fields.push(
		['Mode', `${phyName(t.phy)}, frame format ${t.formatB ? 'B' : 'A'}`],
		['Length', `L = ${t.bytes[0]}, ${t.bytes.length} bytes on air`],
		['CRC', 'failed'],
		...signalFields(t),
		['Bytes', clip(hex(t.bytes))],
	);
	return { text: `${who} · ${phyName(t.phy)} · ${reason}`, fields, damaged: true };
}

/** One record per telegram: "<manufacturer> <device type> <ID> · <mode> · <readings>", or flagged when its CRC failed. */
export function telegramRecord(t: WmbusTelegram, f: WmbusFrame): Omit<DigimodeRecord, 'id' | 'time' | 'mode'> {
	return f.ok ? goodRecord(t, f) : damagedRecord(t, f);
}
