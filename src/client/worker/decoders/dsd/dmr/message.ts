// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/dmr/dmr_link.cpp (Link::finishMessage and the status / precoded
// short data of Link::decodeData), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the message, its format and its position are returned to the caller (dmr/link.ts) instead of going to the
// call log, the message list and the location list of DmrTelemetry.
//
// A data message whose blocks have all arrived: the message CRC-32 (with the other CRC conventions OnAir accepts for
// position reports, OnAir #335), the pad octets, the text of short data, and what the IP payload carries: Motorola ARS
// (port 4005), Motorola text messages (TMS, port 4007), LRRP positions, NMEA sentences, and an LRRP document behind a
// compressed IP/UDP header.
import { crc32Msg } from './codes';
import { DPF_SHORT_DEFINED, DPF_SHORT_RAW, dpfName, sapName } from './data';
import { dmrIpv4HeaderOk, parseDmrLrrp, parseDmrLrrpCompressed, parseDmrNmea } from './position';
import { ddName, textFromBytes } from './text';
import { ipService } from './vendor';
import type { DmrAssembler, DmrMessageResult } from './types';

/** The message CRC-32: as the standard says, or (OnAir #335) plain octet order, complemented or byte-swapped. */
function messageCrcOk(m: DmrAssembler, body: number): boolean {
	const b = m.bytes;
	const calc = crc32Msg(b, body);
	const rx = (b[body] | (b[body + 1] << 8) | (b[body + 2] << 16) | (b[body + 3] << 24)) >>> 0;
	if (calc === rx) return m.crcAllOk;
	if (!m.crcAllOk || b.length < 28) return false;
	const swap32 = (v: number) => ((v >>> 24) | ((v >>> 8) & 0xff00) | ((v << 8) & 0xff0000) | (v << 24)) >>> 0;
	const straight = b.slice(0, body); // octets of each word swapped back: the plain byte order
	for (let i = 0; i + 1 < straight.length; i += 2) [straight[i], straight[i + 1]] = [straight[i + 1], straight[i]];
	const c2 = crc32Msg(straight);
	return [calc, c2, ~calc >>> 0, ~c2 >>> 0].some((c) => c === rx || c === swap32(rx));
}

/** The text and format of a message by its data packet format. */
function messageText(m: DmrAssembler, data: Uint8Array): { format: string; text: string } {
	if (m.hdr.dpf === DPF_SHORT_DEFINED) return { format: `short data, ${ddName(m.hdr.dd)}`, text: textFromBytes(data, m.hdr.dd) };
	if (m.hdr.dpf === DPF_SHORT_RAW) return { format: 'short data, raw', text: textFromBytes(data, 0) };
	const printable = data.length > 0 && data.every((c) => c >= 0x20 && c <= 0x7e);
	return {
		format: `${dpfName(m.hdr.dpf)}, ${sapName(m.hdr.sap)}`,
		text: printable ? String.fromCharCode(...data) : `${data.length} bytes`,
	};
}

/** The message octets less the CRC and the pad octets, and whether the message CRC held. */
function messageData(m: DmrAssembler): { data: Uint8Array; crcOk: boolean } {
	const total = m.bytes.length;
	if (total < 4) return { data: new Uint8Array(0), crcOk: false };
	const body = total - 4;
	const shortData = m.hdr.dpf === DPF_SHORT_DEFINED || (m.hdr.dpf === DPF_SHORT_RAW && m.hdr.blocks > 0);
	const padBytes = Math.min(shortData ? m.hdr.pad >> 3 : m.hdr.pad, body);
	return { data: Uint8Array.from(m.bytes.slice(0, body - padBytes)), crcOk: messageCrcOk(m, body) };
}

/** What an IP / UDP payload or a text carries: a Motorola service, an LRRP position or an NMEA sentence. */
function ipPayload(data: Uint8Array, r: DmrMessageResult): void {
	const svc = ipService(data);
	if (svc?.port === 4005) [r.format, r.text] = ['ARS: radio on the system', svc.text || 'registration'];
	else if (svc?.port === 4007) [r.format, r.text] = [svc.ack ? 'Text message acknowledgment' : 'Text message (TMS)', svc.text];
	r.location = parseDmrLrrp(data);
	r.source = r.location ? 'LRRP' : '';
	if (r.location) return;
	// a plain-text NMEA sentence (e.g. $GNRMC) carried in a short-data / UDT message
	r.location = parseDmrNmea(r.text) ?? parseDmrNmea(String.fromCharCode(...data));
	r.source = r.location ? 'NMEA' : '';
}

/** What a completed data message says: its format and text, whether its CRC held, and a position if it carries one. */
export function finishMessage(m: DmrAssembler): DmrMessageResult {
	const { data, crcOk } = messageData(m);
	const r: DmrMessageResult = { ...messageText(m, data), crcOk, location: null, source: '' };
	// a wrong packet CRC but a right IPv4 header checksum (OnAir #335)
	if (crcOk || (m.crcAllOk && m.bytes.length >= 32 && dmrIpv4HeaderOk(data))) ipPayload(data, r);
	if (!r.location && m.prop && m.crcAllOk) {
		// a position behind a compressed header; the document's own length is the check
		r.location = parseDmrLrrpCompressed(Uint8Array.from([...m.prop.subarray(2), ...data]));
		r.source = r.location ? 'LRRP' : '';
	}
	const loc = r.location;
	if (loc?.hasFix) [r.format, r.text] = [`${r.source} GPS`, `${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)}`];
	else if (loc) [r.format, r.text] = ['LRRP status', loc.resultCode === 16 ? 'no fix' : 'status'];
	return r;
}
