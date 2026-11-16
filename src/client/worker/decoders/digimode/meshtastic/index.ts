// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/mesh/mesh_rx.cpp (the Meshtastic decoders of the region plan with
// the preset search: one demodulator per spreading factor of the presets on the channel; the packet row of a frame) and
// core/src/mesh/mesh_proto.cpp (preset settings), https://github.com/adswill/OnAir; see third_party/onair. Protocol facts:
// Meshtastic (Meshtastic contributors, GPL-3.0). Changes: one 250 kHz channel on the VFO with every 250 kHz modem preset
// (ShortFast SF7 to LongFast SF11) searched at once, as OnAir's preset search does on EU_868; one record per packet.

import { LoraDecoder } from '@/worker/decoders/digimode/lora/decoder';
import { hex2, hex8, messageFields, nodeFields } from '@/worker/decoders/digimode/lora/mesh';
import type { MeshDecodeResult } from '@/worker/decoders/digimode/lora/mesh.types';
import { meshtasticPresets, sfsAt } from '@/worker/decoders/digimode/lora/presets';
import type { LoraMode, LoraReport } from '@/worker/decoders/digimode/lora/types';
import type { DigimodeSink } from '@/worker/decoders/digimode/types';
import { portName } from './names';
import { decodeMeshtastic } from './proto';

/** The channel: the 250 kHz presets' bandwidth at two samples per chip. */
export const MESHTASTIC_BW = 250000;
export const MESHTASTIC_RATE = 500000;

/** The record of a decoded packet (the columns of OnAir's packet table). */
export function meshtasticReport(r: MeshDecodeResult): LoraReport {
	const pi = r.packet;
	if (!r.ok) return { text: `Not a Meshtastic packet: ${pi.note}`, fields: [['Note', pi.note]], ok: false, last: '' };
	const body = Math.max(0, pi.size - 16);
	const what = pi.decrypted ? `${pi.type}${pi.detail ? ` · ${pi.detail}` : ''}` : `encrypted, ${body} bytes (${pi.note})`;
	const hops = pi.hopStart > 0 && pi.hopStart >= pi.hopLimit ? pi.hopStart - pi.hopLimit : -1;
	const fields: Array<[string, string]> = [
		['From', pi.from],
		['To', pi.to],
		['Packet ID', hex8(pi.packetId)],
		[
			'Channel',
			pi.decrypted && pi.channel !== hex2(pi.channelHash) ? `${pi.channel} (hash ${hex2(pi.channelHash)})` : `hash ${hex2(pi.channelHash)}`,
		],
		['Hop limit', `${pi.hopLimit} of ${pi.hopStart}${hops >= 0 ? `, ${hops} hop(s) so far` : ''}`],
	];
	if (pi.wantAck) fields.push(['Want ACK', 'yes']);
	if (pi.viaMqtt) fields.push(['Via MQTT', 'yes']);
	if (pi.nextHop > 0) fields.push(['Next hop', hex2(pi.nextHop)]);
	if (pi.relayNode > 0) fields.push(['Relay node', hex2(pi.relayNode)]);
	if (pi.decrypted) fields.push(['Port', `${pi.portnum} ${portName(pi.portnum)}`], ['Detail', pi.detail]);
	else fields.push(['Encrypted', `${body} bytes`]);
	if (pi.note) fields.push(['Note', pi.note]);
	for (const m of r.messages) fields.push(...messageFields(m));
	for (const u of r.nodes) fields.push(...nodeFields(u));
	return { text: `${pi.from} → ${pi.to} · ${what}`, fields, ok: true, last: `${pi.from} ${pi.decrypted ? pi.type : 'encrypted'}` };
}

export const MESHTASTIC_MODE: LoraMode = {
	name: 'Meshtastic',
	bwHz: MESHTASTIC_BW,
	rate: MESHTASTIC_RATE,
	sfs: sfsAt(meshtasticPresets(), MESHTASTIC_BW),
	syncs: [0x2b],
	preamble: 16,
	decode: (payload) => meshtasticReport(decodeMeshtastic(payload)),
};

/** Meshtastic on the VFO channel (every 250 kHz modem preset). */
export class MeshtasticDecoder extends LoraDecoder {
	constructor(sink: DigimodeSink) {
		super(sink, MESHTASTIC_MODE);
	}
}
