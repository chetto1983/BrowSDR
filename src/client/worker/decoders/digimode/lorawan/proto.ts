// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir rust/onair_mesh/src/lorawan.rs (the LoRaWAN PHY payload headers: MHDR, FHDR
// with DevAddr, FCtrl, FCnt and the FOpts MAC commands of 1.0.x, FPort, the length of the encrypted FRMPayload, the MIC;
// join requests, join accepts and rejoin requests) and core/src/mesh/mesh_proto_lorawan.cpp (meshDecodeLorawan),
// https://github.com/adswill/OnAir; see third_party/onair. Facts: LoRaWAN L2 1.0.4 (TS001-1.0.4) chapters 4 and 5,
// LoRaWAN 1.1, LoRaWAN Backend Interfaces 1.0 (TS002) 6.1. Payloads are never decrypted. Changes: none in substance.

import { euiText, hexUpper, macDef, macName, mtypeName, network, vendor } from './names';
import type { Lorawan } from './types';

const le32 = (p: Uint8Array, i: number): number => (p[i] | (p[i + 1] << 8) | (p[i + 2] << 16) | (p[i + 3] << 24)) >>> 0;
const be32 = (p: Uint8Array, i: number): number => ((p[i] << 24) | (p[i + 1] << 16) | (p[i + 2] << 8) | p[i + 3]) >>> 0;
function le64(p: Uint8Array, i: number): bigint {
	let v = 0n;
	for (let k = 7; k >= 0; k--) v = (v << 8n) | BigInt(p[i + k]);
	return v;
}

function empty(): Lorawan {
	return {
		ok: false,
		mtype: -1,
		major: 0,
		uplink: true,
		confirmed: false,
		adr: false,
		adrAckReq: false,
		ack: false,
		fpending: false,
		classB: false,
		devAddr: 0,
		foptsLen: 0,
		fcnt: 0,
		macNames: [],
		macDetail: '',
		devStatusBattery: -1,
		devStatusMargin: 0,
		fport: -1,
		frmLen: 0,
		mic: 0,
		joinEui: 0n,
		devEui: 0n,
		devNonce: 0,
		rejoinType: -1,
		rejoinNetId: 0,
		vendor: '',
		typeName: '',
		from: '',
		to: '',
		detail: '',
		note: '',
	};
}

/** The value text of the MAC commands that say something about the device or the link (empty for the rest). */
function macValue(cid: number, a: Uint8Array, uplink: boolean, name: string, lw: Lorawan): string {
	if (uplink && cid === 0x06) {
		const margin = a[1] & 0x20 ? (a[1] & 0x3f) - 64 : a[1] & 0x3f;
		lw.devStatusBattery = a[0];
		lw.devStatusMargin = margin;
		const battery = a[0] === 0 ? 'external power' : a[0] === 255 ? 'battery unknown' : `battery ${((a[0] * 100) / 254).toFixed(0)} %`;
		return `${battery}, margin ${margin} dB`;
	}
	if (uplink && (cid === 0x03 || cid === 0x05 || cid === 0x07 || cid === 0x0a)) return `${name} 0x${hexUpper(a[0], 2)}`;
	if (uplink && cid === 0x01) return `LoRaWAN 1.${a[0] & 15}`;
	if (!uplink && cid === 0x02) return `margin ${a[0]} dB, ${a[1]} gateways`;
	if (!uplink && cid === 0x03) return `DR${a[0] >> 4}, TX power ${a[0] & 15}, channel mask 0x${hexUpper(a[1] | (a[2] << 8), 4)}`;
	if (!uplink && cid === 0x0d) return `GPS time ${le32(a, 0)} s`;
	return '';
}

/** The FOpts MAC commands: their names (at most 16), and the values of the ones that say something. */
function macCommands(p: Uint8Array, uplink: boolean, lw: Lorawan): void {
	const push = (s: string) => {
		if (lw.macNames.length < 16) lw.macNames.push(s);
	};
	for (let i = 0; i < p.length;) {
		const cid = p[i];
		if (cid >= 0x80) return push(macName(cid, uplink)); // proprietary: its length is unknown
		const d = macDef(cid);
		const len = !d ? -1 : uplink ? d.upLen : d.downLen;
		if (!d || len < 0) return push(`${macName(cid, uplink)} (unknown: 1.1 encrypted FOpts?)`);
		const name = uplink ? d.up : d.down;
		if (i + 1 + len > p.length) return push(`${name} (truncated)`);
		push(name);
		const v = macValue(cid, p.subarray(i + 1), uplink, name, lw);
		if (v) lw.macDetail += (lw.macDetail ? ', ' : '') + v;
		i += 1 + len;
	}
}

/** A data frame: MHDR DevAddr(4) FCtrl(1) FCnt(2) FOpts(0..15) [FPort(1) FRMPayload] MIC(4). False with a note when it does not fit. */
function dataFrame(p: Uint8Array, lw: Lorawan): boolean {
	const n = p.length;
	if (n < 12) {
		lw.note = `data frame of ${n} bytes (12 at least)`;
		return false;
	}
	lw.devAddr = le32(p, 1);
	const fc = p[5];
	lw.adr = (fc & 0x80) !== 0;
	lw.ack = (fc & 0x20) !== 0;
	lw.foptsLen = fc & 15;
	if (lw.uplink) {
		lw.adrAckReq = (fc & 0x40) !== 0;
		lw.classB = (fc & 0x10) !== 0;
	} else lw.fpending = (fc & 0x10) !== 0;
	lw.fcnt = p[6] | (p[7] << 8);
	const fl = lw.foptsLen;
	if (8 + fl + 4 > n) {
		lw.note = `FOptsLen ${fl} does not fit ${n} bytes`;
		return false;
	}
	if (n > 8 + fl + 4) {
		lw.fport = p[8 + fl];
		lw.frmLen = n - (8 + fl + 1 + 4);
	}
	lw.mic = be32(p, n - 4);
	macCommands(p.subarray(8, 8 + fl), lw.uplink, lw);
	lw.network = network(lw.devAddr);
	lw.from = hexUpper(lw.devAddr, 8);
	const d: string[] = [];
	if (lw.adr) d.push('ADR');
	if (lw.adrAckReq) d.push('ADRACKReq');
	if (lw.ack) d.push('ACK');
	if (lw.fpending) d.push('FPending');
	if (lw.classB) d.push('class B');
	d.push(...lw.macNames);
	if (lw.macDetail) d.push(lw.macDetail);
	if (lw.fport === 0) d.push(`MAC commands in the payload, ${lw.frmLen} bytes encrypted`);
	else if (lw.fport > 0) d.push(`FPort ${lw.fport}, ${lw.frmLen} bytes encrypted`);
	if (lw.fport === 0 && lw.foptsLen > 0) d.push('FOpts with FPort 0 (not allowed)');
	d.push(`MIC ${hexUpper(lw.mic, 8)}`);
	lw.detail = d.join(', ');
	lw.note = lw.fport >= 0 ? 'payload encrypted' : 'no payload';
	return true;
}

/** MHDR JoinEUI(8) DevEUI(8) DevNonce(2) MIC(4), each little endian. */
function joinRequest(p: Uint8Array, lw: Lorawan): boolean {
	if (p.length !== 23) {
		lw.note = `join request of ${p.length} bytes (23 expected)`;
		return false;
	}
	lw.joinEui = le64(p, 1);
	lw.devEui = le64(p, 9);
	lw.devNonce = p[17] | (p[18] << 8);
	lw.mic = be32(p, 19);
	lw.vendor = vendor(lw.devEui);
	lw.from = euiText(lw.devEui);
	lw.to = euiText(lw.joinEui);
	lw.detail = `DevEUI ${lw.from}${lw.vendor ? ` (${lw.vendor})` : ''}, JoinEUI ${lw.to}, DevNonce ${lw.devNonce}, MIC ${hexUpper(lw.mic, 8)}`;
	return true;
}

/** 1.1: type 0 / 2: NetID(3) DevEUI(8) RJcount0(2); type 1: JoinEUI(8) DevEUI(8) RJcount1(2). */
function rejoinRequest(p: Uint8Array, lw: Lorawan): boolean {
	const n = p.length;
	if (n < 2) {
		lw.note = 'short rejoin request';
		return false;
	}
	lw.rejoinType = p[1];
	if ((lw.rejoinType === 0 || lw.rejoinType === 2) && n === 19) {
		lw.rejoinNetId = p[2] | (p[3] << 8) | (p[4] << 16);
		lw.devEui = le64(p, 5);
		lw.devNonce = p[13] | (p[14] << 8);
	} else if (lw.rejoinType === 1 && n === 24) {
		lw.joinEui = le64(p, 2);
		lw.devEui = le64(p, 10);
		lw.devNonce = p[18] | (p[19] << 8);
		lw.to = euiText(lw.joinEui);
	} else {
		lw.note = `rejoin request type ${lw.rejoinType} of ${n} bytes`;
		return false;
	}
	lw.mic = be32(p, n - 4);
	lw.vendor = vendor(lw.devEui);
	lw.from = euiText(lw.devEui);
	lw.detail = `type ${lw.rejoinType}, DevEUI ${lw.from}${lw.vendor ? ` (${lw.vendor})` : ''}, RJcount ${lw.devNonce}, MIC ${hexUpper(lw.mic, 8)}`;
	return true;
}

/** Decodes a LoRaWAN PHY payload; ok stays false for anything that is not LoRaWAN R1 (bad length, RFU bits, major version). */
export function decodeLorawan(p: Uint8Array): Lorawan {
	const lw = empty();
	const n = p.length;
	if (n < 1) {
		lw.note = 'empty';
		return lw;
	}
	lw.mtype = p[0] >> 5;
	lw.major = p[0] & 3;
	if (lw.mtype !== 7 && ((p[0] & 0x1c) !== 0 || lw.major !== 0)) {
		lw.note = 'not LoRaWAN R1 (RFU or major bits set)';
		return lw;
	}
	lw.uplink = [0, 2, 4, 6].includes(lw.mtype);
	lw.confirmed = lw.mtype === 4 || lw.mtype === 5;
	lw.typeName = mtypeName(lw.mtype);
	let ok: boolean;
	if (lw.mtype === 0) ok = joinRequest(p, lw);
	else if (lw.mtype === 1) {
		// encrypted with the device's key: only its length says 1.0 / 1.1 CFList or not
		ok = n === 17 || n === 33;
		if (!ok) lw.note = `join accept of ${n} bytes (17 or 33 expected)`;
		else {
			lw.mic = be32(p, n - 4);
			lw.detail = `${n - 1} bytes encrypted${n === 33 ? ' (with a channel list)' : ''}`;
			lw.note = 'encrypted';
		}
	} else if (lw.mtype === 6) ok = rejoinRequest(p, lw);
	else if (lw.mtype === 7) {
		// proprietary: the layout after MHDR is the network's own
		lw.detail = `${n - 1} bytes, layout unknown`;
		lw.note = 'proprietary';
		ok = true;
	} else ok = dataFrame(p, lw);
	lw.ok = ok;
	return lw;
}
