// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/mesh/mesh_proto_lora_rs.cpp (meshDecodeMeshCom: the message of a
// TEXT frame, the position of a POSITION frame through the APRS parser with its battery, the details of each type) and
// core/src/mesh/mesh_rx.cpp (the MeshCom decoders of the region plan: sync word 0x2B, the coding rate from each frame's
// header; onAprs: the station, its position, battery and path, the messages, the packet row),
// https://github.com/adswill/OnAir; see third_party/onair. Protocol facts as credited there: MeshCom firmware
// (icssw-org/MeshCom-Firmware, MIT). Changes: one LoRa bandwidth per catalog entry on the VFO's channel (250 kHz with
// SF11: EU and the other 250 kHz profiles; 125 kHz with SF10: UK and LA); one record per frame in place of the station,
// message and packet tables; the position is parsed by BrowSDR's APRS decoder (as LoRa APRS) in place of OnAir's
// aprs::parse, without the "/B=" tag in the comment once it is read as the battery.

import { LoraDecoder, printable } from '@/worker/decoders/digimode/lora/decoder';
import { meshcomPresets, sfsAt } from '@/worker/decoders/digimode/lora/presets';
import type { LoraMode, LoraReport } from '@/worker/decoders/digimode/lora/types';
import { aprsSummary, coordinates, parseInfo } from '@/worker/decoders/digimode/lora-aprs/proto';
import type { DigimodeSink } from '@/worker/decoders/digimode/types';
import { hex8upper, meshcom } from './proto';
import type { MeshComFrame } from './types';

export const MESHCOM_BW = 250000;
export const MESHCOM_RATE = 500000;
export const MESHCOM_125_BW = 125000;
export const MESHCOM_125_RATE = 250000;

const latin1Bytes = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

/** Sender, relays and destination of a frame: "DL1ABC-1 via DB0XYZ-12 → all". */
const route = (m: MeshComFrame): string => `${m.src}${m.aprsPath ? ` via ${m.aprsPath}` : ''} → ${m.destCall === '*' ? 'all' : m.destCall}`;

/** The position of a POSITION frame (OnAir: aprs::parse of the destination's base call and the information field). */
function positionParts(m: MeshComFrame): { summary: string; fields: Array<[string, string]> } {
	const r = parseInfo(m.destCall, m.aprsInfo);
	const comment = m.batteryPct >= 0 ? r.comment?.replace(/\/B=\d{1,3}/, '').trim() : r.comment;
	const shown = { ...r, comment: comment || undefined };
	const fields: Array<[string, string]> = [];
	const hasPos = r.latitude !== undefined && r.longitude !== undefined;
	if (hasPos) fields.push(['Position', coordinates(r.latitude ?? 0, r.longitude ?? 0)]);
	if (r.symbol) fields.push(['Symbol', r.symbol]);
	if (r.altitude !== undefined) fields.push(['Altitude', `${r.altitude.toFixed(0)} m`]);
	if (r.speed !== undefined) fields.push(['Speed', `${r.speed.toFixed(0)} km/h`]);
	if (r.course !== undefined) fields.push(['Course', `${r.course}°`]);
	if (shown.comment) fields.push(['Comment', shown.comment]);
	if (m.batteryPct >= 0) fields.push(['Battery', `${m.batteryPct} %`]);
	const parts = [hasPos ? aprsSummary(shown, m.aprsInfo) : 'position not readable'];
	if (m.batteryPct >= 0) parts.push(`battery ${m.batteryPct} %`);
	return { summary: parts.join(' · '), fields };
}

/** An acknowledgement: its own id, the id it acknowledges and the hops left. */
function ackReport(m: MeshComFrame): LoraReport {
	return {
		text: `ACK · ${m.detail}`,
		fields: [
			['Type', 'ACK'],
			['Message ID', hex8upper(m.packetId)],
			['Acknowledges', hex8upper(m.ackedId ?? 0)],
			['Hops left', String(m.hopLimit)],
		],
		ok: true,
		last: 'ACK',
	};
}

/** The record of a MeshCom frame (the columns of OnAir's packet, station and message tables). */
export function meshcomReport(payload: Uint8Array): LoraReport {
	const m = meshcom(payload);
	if (!m.ok) {
		const note = m.note || 'empty frame';
		return { text: `Not a MeshCom packet: ${note} · ${printable(payload.subarray(0, 80))}`, fields: [['Note', note]], ok: false, last: '' };
	}
	if (m.kind === 'ack') return ackReport(m);
	const fields: Array<[string, string]> = [
		['Type', m.typeName],
		['Source', m.src],
	];
	if (m.aprsPath) fields.push(['Relays', m.aprsPath]);
	fields.push(['Destination', m.aprsDest]);
	let what: string;
	if (m.kind === 'text') {
		fields.push(['Channel', m.channel], ['Message', m.text]);
		what = m.text;
	} else if (m.kind === 'position') {
		const p = positionParts(m);
		fields.push(...p.fields);
		what = p.summary;
	} else {
		fields.push(['Beacon', m.detail]);
		what = m.detail;
	}
	fields.push(
		['Message ID', hex8upper(m.packetId)],
		['Hop limit', String(m.hopLimit)],
		['Node info', m.tail],
		['Information', printable(latin1Bytes(m.aprsInfo))],
	);
	return { text: `${route(m)} · ${m.typeName} · ${what}`, fields, ok: true, last: `${m.src} ${m.typeName}` };
}

const decode = (payload: Uint8Array): LoraReport => meshcomReport(payload);

/** MeshCom EU (433.175 MHz) and the other 250 kHz profiles: SF11, sync word 0x2B, preamble 32 (EU; 8 elsewhere). */
export const MESHCOM_MODE: LoraMode = {
	name: 'MeshCom',
	bwHz: MESHCOM_BW,
	rate: MESHCOM_RATE,
	sfs: sfsAt(meshcomPresets(), MESHCOM_BW),
	syncs: [0x2b],
	preamble: 32,
	decode,
};

/** MeshCom UK (439.9125 MHz) and LA (433.925 MHz): 125 kHz, SF10. */
export const MESHCOM_125_MODE: LoraMode = {
	name: 'MeshCom',
	bwHz: MESHCOM_125_BW,
	rate: MESHCOM_125_RATE,
	sfs: sfsAt(meshcomPresets(), MESHCOM_125_BW),
	syncs: [0x2b],
	preamble: 8,
	decode,
};

/** MeshCom on the VFO channel. */
export class MeshComDecoder extends LoraDecoder {
	constructor(sink: DigimodeSink, mode: LoraMode = MESHCOM_MODE) {
		super(sink, mode);
	}
}
