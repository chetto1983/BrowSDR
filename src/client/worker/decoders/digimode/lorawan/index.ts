// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/lorawan/lorawan_rx.cpp (the LoRaWAN monitor: every uplink spreading
// factor of a 125 kHz channel, public sync word 0x34; the frame row with its type, flags, MAC commands and MIC) and
// core/src/mesh/mesh_rx.cpp (onLorawan: DevAddr, FCnt, FPort, join requests by DevEUI), https://github.com/adswill/OnAir;
// see third_party/onair. Facts: LoRaWAN L2 1.0.4 and RP002-1.0.4 (EU863-870: SF7 to SF12 at 125 kHz). Changes: one
// channel on the VFO; one record per frame in place of the frame log and device table; no downlinks (inverted IQ), FSK
// channel, Class B beacons or decryption with user keys.

import { LoraDecoder } from '@/worker/decoders/digimode/lora/decoder';
import { lorawanPresets, sfsAt } from '@/worker/decoders/digimode/lora/presets';
import type { LoraMode, LoraReport } from '@/worker/decoders/digimode/lora/types';
import type { DigimodeSink } from '@/worker/decoders/digimode/types';
import { euiText, hexUpper } from './names';
import { decodeLorawan } from './proto';
import type { Lorawan } from './types';

export const LORAWAN_BW = 125000;
export const LORAWAN_RATE = 250000;

/** DevAddr, network, frame counter, flags, MAC commands and FPort of a data frame. */
function dataFields(w: Lorawan, f: Array<[string, string]>): void {
	const nw = w.network;
	f.push(['DevAddr', w.from]);
	if (nw) f.push(['Network', `${nw.name} (DevAddr type ${nw.kind}${nw.haveIds ? `, NwkID 0x${hexUpper(nw.nwkId, 1)}` : ''})`]);
	f.push(['FCnt', String(w.fcnt)]);
	const flags = [w.adr && 'ADR', w.adrAckReq && 'ADRACKReq', w.ack && 'ACK', w.fpending && 'FPending', w.classB && 'class B'].filter(
		Boolean,
	);
	if (flags.length) f.push(['Flags', flags.join(', ')]);
	if (w.macNames.length) f.push(['MAC commands', w.macNames.join(', ') + (w.macDetail ? ` (${w.macDetail})` : '')]);
	if (w.fport >= 0) f.push(['FPort', String(w.fport)], ['Encrypted payload', `${w.frmLen} bytes`]);
}

/** DevEUI, its maker, JoinEUI and the nonce of a join or rejoin request. */
function joinFields(w: Lorawan, f: Array<[string, string]>): void {
	f.push(['DevEUI', euiText(w.devEui) + (w.vendor ? ` (${w.vendor})` : '')]);
	if (w.mtype === 0 || w.joinEui) f.push(['JoinEUI', euiText(w.joinEui)]);
	f.push([w.mtype === 0 ? 'DevNonce' : 'RJcount', String(w.devNonce)]);
	if (w.mtype === 6) f.push(['Rejoin type', String(w.rejoinType)]);
	if (w.mtype === 6 && w.rejoinType !== 1) f.push(['NetID', `0x${hexUpper(w.rejoinNetId, 6)}`]);
}

/** The record of a frame: headers only, nothing decrypted. */
export function lorawanReport(w: Lorawan): LoraReport {
	if (!w.ok) return { text: `Not a LoRaWAN frame: ${w.note}`, fields: [['Note', w.note]], ok: false, last: '' };
	const f: Array<[string, string]> = [
		['Message type', `${w.typeName} (MType ${w.mtype})`],
		['Direction', w.mtype === 7 ? 'unknown' : w.uplink ? 'uplink' : 'downlink'],
	];
	if (w.mtype >= 2 && w.mtype <= 5) dataFields(w, f);
	if (w.mtype === 0 || w.mtype === 6) joinFields(w, f);
	if (w.mtype !== 7) f.push(['MIC', `${hexUpper(w.mic, 8)} (not checked)`]);
	if (w.detail) f.push(['Detail', w.detail]);
	if (w.note) f.push(['Note', w.note]);
	let text: string;
	if (w.mtype >= 2 && w.mtype <= 5) text = `${w.typeName} · ${w.from} (${w.network?.name ?? ''}) · FCnt ${w.fcnt} · ${w.detail}`;
	else text = `${w.typeName} · ${w.detail || w.note}`;
	return { text, fields: f, ok: true, last: `${w.typeName} ${w.from}` };
}

export const LORAWAN_MODE: LoraMode = {
	name: 'LoRaWAN',
	bwHz: LORAWAN_BW,
	rate: LORAWAN_RATE,
	sfs: sfsAt(lorawanPresets(0), LORAWAN_BW),
	syncs: [0x34],
	preamble: 8,
	decode: (payload) => lorawanReport(decodeLorawan(payload)),
};

/** LoRaWAN uplinks on the VFO channel (EU868: SF7 to SF12 at 125 kHz). */
export class LorawanDecoder extends LoraDecoder {
	constructor(sink: DigimodeSink) {
		super(sink, LORAWAN_MODE);
	}
}
