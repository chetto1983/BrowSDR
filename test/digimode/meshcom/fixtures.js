// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir core/src/mesh/mesh_proto_aprs.cpp (meshcomBuild: a MeshCom frame as
// the firmware builds it), core/include/dect2/mesh/mesh_proto.h (MeshComFrame defaults) and core/src/mesh/mesh_gen.cpp
// (kMcom: the MeshCom nodes of the 70 cm scene; a relayed frame keeps a max hop of 4, the others 5),
// https://github.com/adswill/OnAir; see third_party/onair. Protocol facts as credited there: MeshCom firmware
// (icssw-org/MeshCom-Firmware, MIT). Changes: plain arrays of bytes; the frames go through BrowSDR's test modulator
// (test/digimode/lora/phy.js) with the scene's schedule of test/digimode/lora/scene.js.

import { autoLdro, loraParams } from '@/worker/decoders/digimode/lora/code';

const utf8 = (s) => Array.from(new TextEncoder().encode(s));

/** meshcomBuild: type, message id, flags / max hop, "SRCPATH>DEST" + type + payload + NUL, trailer, byte sum, version. */
export function meshcomBuild({
	type = ':',
	msgId = 0,
	maxHop = 5,
	server = false,
	track = false,
	appOffline = false,
	mesh = true,
	sourcePath,
	dest = '*',
	payload,
	hw = 4,
	mod = 3,
	fw = 35,
	lastHw = 0x84,
	subVersion = 'a',
}) {
	const b = [type.charCodeAt(0)];
	for (let k = 0; k < 4; k++) b.push((msgId >>> (8 * k)) & 0xff);
	b.push((maxHop & 0x0f) | (server ? 0x80 : 0) | (track ? 0x40 : 0) | (appOffline ? 0x20 : 0) | (mesh ? 0x10 : 0));
	b.push(...utf8(`${sourcePath}>${dest}${type}${payload}`), 0, hw, mod);
	const sum = b.reduce((s, c) => s + c, 0);
	b.push((sum >> 8) & 0xff, sum & 0xff, fw, lastHw, subVersion ? subVersion.charCodeAt(0) : 0x23, 0x7e);
	return Uint8Array.from(b);
}

/** mesh_gen.cpp kMcom: [offset, node, type, source path, destination, payload]. */
export const MCOM_EVENTS = [
	[1.0, 0, '!', 'A61MC-1', '*', '2505.10N/05510.20E#/B=085/A=000040'],
	[7.0, 0, ':', 'A61MC-1', '*', 'Hello MeshCom from the Marina'],
	[14.0, 1, '!', 'A61MC-2,A61MC-1', '*', '2506.00N/05512.00E[/B=064'],
	[21.0, 1, ':', 'A61MC-2', 'A61MC-1', 'QSL, 59 here'],
	[30.0, 1, ':', 'A61MC-2', '262', 'Group 262 check-in'],
].map(([t, node, type, sourcePath, dest, payload]) => ({ t, node, type, sourcePath, dest, payload }));

/** A frame of the scene (mesh_gen.cpp schedule70): a relayed one has a max hop of 4. */
export const meshcomEvent = (e, msgId) =>
	meshcomBuild({
		type: e.type,
		msgId,
		sourcePath: e.sourcePath,
		dest: e.dest,
		payload: e.payload,
		maxHop: e.sourcePath.includes(',') ? 4 : 5,
	});

/** MeshCom's LoRa settings: EU (SF11, 250 kHz, 4/6, preamble 32) or UK / LA (SF10, 125 kHz, preamble 8); sync word 0x2B. */
export const meshcomLora = (sf = 11, bwHz = 250000, preamble = sf === 11 && bwHz === 250000 ? 32 : 8) =>
	loraParams({ sf, bwHz, cr: 6, preamble, syncWord: 0x2b, ldro: autoLdro(sf, bwHz) });

export const field = (record, label) => record.fields.find(([name]) => name === label)?.[1];
