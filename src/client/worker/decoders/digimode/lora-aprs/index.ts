// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/mesh/mesh_rx.cpp (the LoRa APRS decoders of the plan: 125 kHz,
// sync word 0x12, preamble 8; onAprs: the station, its position and messages) and core/src/mesh/mesh_proto_lora_rs.cpp
// (meshDecodeLoraAprs), https://github.com/adswill/OnAir; see third_party/onair. Facts as credited there:
// richonguzman/LoRa_APRS_iGate and LoRa_APRS_Tracker (Ricardo Guzman, GPL-3.0). Changes: one channel on the VFO searching
// the spreading factors of the LoRa APRS presets (SF9 and SF12) at once; one record per packet in place of the station
// table; the information field is parsed by BrowSDR's APRS decoder.

import { LoraDecoder } from '@/worker/decoders/digimode/lora/decoder';
import { loraAprsPresets, sfsAt } from '@/worker/decoders/digimode/lora/presets';
import type { LoraMode, LoraReport } from '@/worker/decoders/digimode/lora/types';
import type { DigimodeSink } from '@/worker/decoders/digimode/types';
import { aprsSummary, coordinates, KIND_LABELS, parseInfo, splitLoraAprs } from './proto';
import { printable } from '@/worker/decoders/digimode/lora/decoder';

export const LORA_APRS_BW = 125000;
export const LORA_APRS_RATE = 250000;

const latin1Bytes = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

/** The record of a LoRa APRS frame: the TNC2 header and the parsed information field. */
export function loraAprsReport(payload: Uint8Array): LoraReport {
	const s = splitLoraAprs(payload);
	if (typeof s === 'string')
		return { text: `Not a LoRa APRS packet: ${s} · ${printable(payload.subarray(0, 80))}`, fields: [['Note', s]], ok: false, last: '' };
	const r = parseInfo(s.dest, s.info);
	const head = `${s.src} → ${s.dest}${s.path ? ` via ${s.path}` : ''}`;
	const summary = aprsSummary(r, s.info);
	const fields: Array<[string, string]> = [
		['Source', s.src],
		['Destination', s.dest],
	];
	if (s.path) fields.push(['Path', s.path]);
	fields.push(['Type', KIND_LABELS[r.kind]]);
	if (r.latitude !== undefined && r.longitude !== undefined) fields.push(['Position', coordinates(r.latitude, r.longitude)]);
	if (r.symbol) fields.push(['Symbol', r.symbol]);
	if (r.altitude !== undefined) fields.push(['Altitude', `${r.altitude.toFixed(0)} m`]);
	if (r.speed !== undefined) fields.push(['Speed', `${r.speed.toFixed(0)} km/h`]);
	if (r.course !== undefined) fields.push(['Course', `${r.course}°`]);
	if (r.name) fields.push([r.kind === 'item' ? 'Item' : 'Object', r.name]);
	if (r.message) fields.push(['Addressee', r.message.addressee], ['Message', r.message.text]);
	if (r.comment) fields.push(['Comment', r.comment]);
	if (r.timestamp) fields.push(['Timestamp', r.timestamp]);
	fields.push(['Summary', summary], ['Information', printable(latin1Bytes(s.info))]);
	return { text: `${head} · ${KIND_LABELS[r.kind]} · ${summary}`, fields, ok: true, last: `${s.src} ${KIND_LABELS[r.kind]}` };
}

export const LORA_APRS_MODE: LoraMode = {
	name: 'LoRa APRS',
	bwHz: LORA_APRS_BW,
	rate: LORA_APRS_RATE,
	sfs: sfsAt(loraAprsPresets(), LORA_APRS_BW),
	syncs: [0x12],
	preamble: 8,
	decode: (payload) => loraAprsReport(payload),
};

/** LoRa APRS on the VFO channel (SF12 and SF9 at 125 kHz). */
export class LoraAprsDecoder extends LoraDecoder {
	constructor(sink: DigimodeSink) {
		super(sink, LORA_APRS_MODE);
	}
}
