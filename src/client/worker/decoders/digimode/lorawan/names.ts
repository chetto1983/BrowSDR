// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir rust/onair_mesh/src/lorawan_names.rs (MAC command names and payload lengths
// of TS001 1.0.4 / 1.1 chapter 5, MType names, DevAddr types and the network of a DevAddr per TS002 6.1 and the LoRa
// Alliance NetID list, device makers by IEEE OUI, EUI text), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: none in substance.

import type { LorawanNetwork, MacDef } from './types';

const mac = (cid: number, up: string, upLen: number, down: string, downLen: number): MacDef => ({ cid, up, upLen, down, downLen });

/** MAC commands of TS001 1.0.4 / 1.1 chapter 5 (uplink name and length, downlink name and length). */
export const MACS: readonly MacDef[] = [
	mac(0x01, 'ResetInd', 1, 'ResetConf', 1),
	mac(0x02, 'LinkCheckReq', 0, 'LinkCheckAns', 2),
	mac(0x03, 'LinkADRAns', 1, 'LinkADRReq', 4),
	mac(0x04, 'DutyCycleAns', 0, 'DutyCycleReq', 1),
	mac(0x05, 'RXParamSetupAns', 1, 'RXParamSetupReq', 4),
	mac(0x06, 'DevStatusAns', 2, 'DevStatusReq', 0),
	mac(0x07, 'NewChannelAns', 1, 'NewChannelReq', 5),
	mac(0x08, 'RXTimingSetupAns', 0, 'RXTimingSetupReq', 1),
	mac(0x09, 'TxParamSetupAns', 0, 'TxParamSetupReq', 1),
	mac(0x0a, 'DlChannelAns', 1, 'DlChannelReq', 4),
	mac(0x0b, 'RekeyInd', 1, 'RekeyConf', 1),
	mac(0x0c, 'ADRParamSetupAns', 0, 'ADRParamSetupReq', 1),
	mac(0x0d, 'DeviceTimeReq', 0, 'DeviceTimeAns', 5),
	mac(0x0e, '', -1, 'ForceRejoinReq', 2),
	mac(0x0f, 'RejoinParamSetupAns', 1, 'RejoinParamSetupReq', 1),
	mac(0x10, 'PingSlotInfoReq', 1, 'PingSlotInfoAns', 0),
	mac(0x11, 'PingSlotChannelAns', 1, 'PingSlotChannelReq', 4),
	mac(0x12, 'BeaconTimingReq', 0, 'BeaconTimingAns', 3),
	mac(0x13, 'BeaconFreqAns', 1, 'BeaconFreqReq', 3),
	mac(0x20, 'DeviceModeInd', 1, 'DeviceModeConf', 1),
];

export const macDef = (cid: number): MacDef | undefined => MACS.find((m) => m.cid === cid);

/** NetIDs of a few big networks (LoRa Alliance NetID list): DevAddr type, NwkID, name. */
const NETS: ReadonlyArray<[number, number, string]> = [
	[0, 0x00, 'Experimental / private'],
	[0, 0x01, 'Experimental / private'],
	[0, 0x02, 'Actility'],
	[0, 0x03, 'Proximus'],
	[0, 0x04, 'Swisscom'],
	[0, 0x07, 'Bouygues Telecom'],
	[0, 0x08, 'Orbiwise'],
	[0, 0x09, 'Senet'],
	[0, 0x0a, 'KPN'],
	[0, 0x0b, 'Everynet'],
	[0, 0x0f, 'SK Telecom'],
	[0, 0x10, 'Sagemcom'],
	[0, 0x11, 'Orange'],
	[0, 0x12, 'A2A Smart City'],
	[0, 0x13, 'The Things Network'],
	[0, 0x24, 'Helium'],
	[6, 0x53, 'Helium'], // NetID 0xC00053, DevAddr 0xFC01 4C00 - 0xFC01 4FFF
];
/** NwkID length in bits by DevAddr type 0..7 (TS002 table 1). */
const NWK_BITS = [6, 6, 9, 11, 12, 13, 15, 17];

/** IEEE OUIs of common LoRaWAN device makers (the first three bytes of the DevEUI). */
const OUIS = new Map<number, string>([
	[0xa84041, 'Dragino'],
	[0x0004a3, 'Microchip'],
	[0x24e124, 'Milesight'],
	[0xac1f09, 'RAKwireless'],
	[0x0018b2, 'Adeunis'],
	[0x00137a, 'Netvox'],
	[0x647fda, 'Tektelic'],
	[0x58a0cb, 'The Things Industries'],
	[0x2cf7f1, 'Seeed (SenseCAP)'],
	[0x0016c0, 'Semtech'],
	[0x0080e1, 'STMicroelectronics'],
	[0xa81758, 'Elsys'],
	[0x70b3d5, 'IEEE small-vendor block'],
]);

const MTYPES = [
	'Join request',
	'Join accept',
	'Unconfirmed up',
	'Unconfirmed down',
	'Confirmed up',
	'Confirmed down',
	'Rejoin request',
	'Proprietary',
];
/** Message type name of the MHDR (TS001 4.2.1); "?" outside 0..7. */
export const mtypeName = (t: number): string => MTYPES[t] ?? '?';

export const hexUpper = (v: number, width: number): string => (v >>> 0).toString(16).toUpperCase().padStart(width, '0');

/** Name of a MAC command (CID 0x42 when unknown, proprietary 0x80 from 0x80). */
export function macName(cid: number, uplink: boolean): string {
	if (cid >= 0x80) return `proprietary 0x${hexUpper(cid, 2)}`;
	const d = macDef(cid);
	const name = d ? (uplink ? d.up : d.down) : '';
	return name || `CID 0x${hexUpper(cid, 2)}`;
}

/** The network of a DevAddr as text ("The Things Network", "NetID 0x000005", ...) and its numbers. */
export function network(devAddr: number): LorawanNetwork {
	let kind = 0;
	while (kind < 8 && (devAddr >>> (31 - kind)) & 1) kind++;
	if (kind >= 8) return { name: 'reserved DevAddr', kind: -1, nwkId: 0, netId: 0, haveIds: false };
	const bits = NWK_BITS[kind];
	const nwk = (devAddr >>> (32 - (kind + 1) - bits)) & ((1 << bits) - 1);
	const net = kind <= 2 ? ((kind << 21) | nwk) >>> 0 : 0;
	const known = NETS.find((e) => e[0] === kind && e[1] === nwk);
	const name = known ? known[2] : kind <= 2 ? `NetID 0x${hexUpper(net, 6)}` : `NetID type ${kind}, NwkID 0x${hexUpper(nwk, 1)}`;
	return { name, kind, nwkId: nwk, netId: net, haveIds: true };
}

/** The device maker of an EUI-64 from the short OUI table; empty when not in it. */
export function vendor(eui: bigint): string {
	if (eui >> 28n === 0x00070b3d57edn) return 'The Things Network block';
	return OUIS.get(Number(eui >> 40n)) ?? '';
}

/** %016llX of an EUI-64 (most significant byte first). */
export const euiText = (eui: bigint): string => eui.toString(16).toUpperCase().padStart(16, '0');
