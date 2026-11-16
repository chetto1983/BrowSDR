// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/mesh/mesh_rx.cpp (the MeshCore decoders of the region plan: one
// demodulator per spreading factor of the region's presets on a channel, the coding rate from each frame's header; the
// packet row of a frame), https://github.com/adswill/OnAir; see third_party/onair. Protocol facts: MeshCore (MeshCore
// contributors, MIT). Changes: one 62.5 kHz channel on the VFO with every spreading factor of the 62.5 kHz community
// presets (SF7 to SF9) searched at once; one record per packet.

import { LoraDecoder } from '@/worker/decoders/digimode/lora/decoder';
import { hex2, messageFields, nodeFields } from '@/worker/decoders/digimode/lora/mesh';
import type { MeshDecodeResult } from '@/worker/decoders/digimode/lora/mesh.types';
import { meshCorePresets, sfsAt } from '@/worker/decoders/digimode/lora/presets';
import type { LoraMode, LoraReport } from '@/worker/decoders/digimode/lora/types';
import type { DigimodeSink } from '@/worker/decoders/digimode/types';
import { decodeMeshCore, ROUTE_NAMES } from './proto';

/** The narrow presets' bandwidth at two samples per chip. */
export const MESHCORE_BW = 62500;
export const MESHCORE_RATE = 125000;

/** The record of a decoded packet (the columns of OnAir's packet table). */
export function meshcoreReport(r: MeshDecodeResult): LoraReport {
	const pi = r.packet;
	if (!r.ok) return { text: `Not a MeshCore packet: ${pi.note}`, fields: [['Note', pi.note]], ok: false, last: '' };
	const group = pi.payloadType === 5 || pi.payloadType === 6;
	let text: string;
	if (group && pi.decrypted) text = `${pi.channel} · ${pi.detail}`;
	else if (group) text = `${pi.type} · encrypted, ${pi.size} bytes (${pi.note})`;
	else text = `${pi.type}${pi.from ? ` ${pi.from}` : ''} · ${pi.detail || pi.note || `${pi.size} bytes`}`;
	const fields: Array<[string, string]> = [
		['Type', `${pi.type} (version ${pi.payloadVersion + 1})`],
		['Route', ROUTE_NAMES[pi.routeType] ?? String(pi.routeType)],
	];
	if (pi.from) fields.push(['From', pi.from]);
	if (pi.to) fields.push(['To', pi.to]);
	if (pi.channelHash >= 0)
		fields.push(['Channel', pi.decrypted ? `${pi.channel} (hash ${hex2(pi.channelHash)})` : `hash ${hex2(pi.channelHash)}`]);
	if (pi.path) fields.push(['Path', `${pi.path} (${pi.pathHashSize} byte hashes)`]);
	if (pi.detail) fields.push(['Detail', pi.detail]);
	if (pi.note) fields.push(['Note', pi.note]);
	for (const m of r.messages) fields.push(...messageFields(m));
	for (const u of r.nodes) fields.push(...nodeFields(u));
	return { text, fields, ok: true, last: `${pi.type}${pi.from ? ` ${pi.from}` : ''}` };
}

export const MESHCORE_MODE: LoraMode = {
	name: 'MeshCore',
	bwHz: MESHCORE_BW,
	rate: MESHCORE_RATE,
	sfs: sfsAt(meshCorePresets(), MESHCORE_BW),
	syncs: [0x12],
	preamble: 32,
	decode: (payload) => meshcoreReport(decodeMeshCore(payload)),
};

/** MeshCore on the VFO channel (the 62.5 kHz presets). */
export class MeshCoreDecoder extends LoraDecoder {
	constructor(sink: DigimodeSink) {
		super(sink, MESHCORE_MODE);
	}
}
