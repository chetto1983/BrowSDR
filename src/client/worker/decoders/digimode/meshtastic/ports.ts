// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir rust/onair_mesh/src/meshtastic.rs (decode_port and the port payloads Text,
// Position, NodeInfo, Telemetry (device, environment, air quality, power, local stats), Routing, Traceroute, NeighborInfo,
// Waypoint, Paxcounter, Store and Forward, Map report and the plain text ports, as a detail line plus a node update or a
// text message), https://github.com/adswill/OnAir; see third_party/onair. Protocol facts: meshtastic/protobufs mesh.proto,
// portnums.proto, telemetry.proto, config.proto (Meshtastic contributors, GPL-3.0). Changes: numbers are formatted with
// toFixed in place of C's printf; text is shown as UTF-8.

import { clip, cleanText, emptyMessage, emptyNode, hex8, utf8 } from '@/worker/decoders/digimode/lora/mesh';
import type { MeshNode } from '@/worker/decoders/digimode/lora/mesh.types';
import { hwModelName, nodeId, nodeStr, roleName, ROUTING_ERRORS } from './names';
import { asF32, asI32, asSint32, eachFixed32, eachVarint, PbReader } from './pb';
import type { MtCtx, MtData, MtDecoded, PbField } from './types';

function* fields(p: Uint8Array): Generator<PbField> {
	const r = new PbReader(p);
	for (let f = r.next(); f; f = r.next()) yield f;
}

/** POSITION_APP (mesh.proto Position): a fix only when latitude and longitude are present and not both zero. */
const POSITION_I32 = new Set(['1/5', '2/5', '3/0']);
const POSITION_U32 = new Set(['4/5', '7/5']);
const POSITION_VALUE = new Set(['15/0', '16/0', '12/0', '19/0', '23/0']);

/** The fields of a Position by number / wire type: int32 / sfixed32, fixed32, sint32 and plain varints. */
function positionFields(p: Uint8Array): Record<string, number | undefined> {
	const v: Record<string, number | undefined> = {};
	for (const f of fields(p)) {
		const key = `${f.num}/${f.wire}`;
		if (POSITION_I32.has(key)) v[key] = asI32(f);
		else if (POSITION_U32.has(key)) v[key] = f.lo;
		else if (key === '9/0') v[key] = asSint32(f);
		else if (POSITION_VALUE.has(key)) v[key] = f.value;
	}
	return v;
}

function position(d: MtData, out: MtDecoded): void {
	const v = positionFields(d.payload);
	const lat = v['1/5'],
		lon = v['2/5'];
	if (lat === undefined || lon === undefined || (lat === 0 && lon === 0)) {
		out.detail = 'no position fix';
		return;
	}
	const u = emptyNode();
	u.hasPosition = true;
	u.lat = lat * 1e-7;
	u.lon = lon * 1e-7;
	u.altM = v['3/0'] ?? v['9/0'] ?? 0;
	u.positionTime = v['4/5'] || v['7/5'] || 0;
	u.sats = v['19/0'] ?? -1;
	const gs = v['15/0'],
		track = v['16/0'],
		hdop = v['12/0'],
		prec = v['23/0'] ?? 0;
	let s = `${u.lat.toFixed(5)}, ${u.lon.toFixed(5)}, ${Math.trunc(u.altM)} m`;
	if (gs !== undefined) s += `, ${gs} m/s`;
	if (track !== undefined) s += `, track ${(track * 1e-5).toFixed(1)}`; // mesh.proto: 1e-5 degrees
	if (hdop !== undefined) s += `, HDOP ${(hdop / 100).toFixed(2)}`;
	if (prec !== 0 && prec < 32) s += `, ${prec} bit precision`;
	out.detail = s;
	out.node = u;
}

/** NODEINFO_APP (mesh.proto User): names, hardware model, role and whether a 32 byte public key is attached. */
function nodeinfo(d: MtData, out: MtDecoded): void {
	const u = emptyNode();
	let hw = 0,
		role = 0,
		hasKey = false;
	for (const f of fields(d.payload)) {
		if (f.num === 2 && f.wire === 2) u.longName = utf8(f.data);
		else if (f.num === 3 && f.wire === 2) u.shortName = utf8(f.data);
		else if (f.num === 5 && f.wire === 0) hw = asI32(f);
		else if (f.num === 7 && f.wire === 0) role = asI32(f);
		else if (f.num === 8 && f.wire === 2) hasKey = f.data.length === 32;
	}
	u.hwModel = hwModelName(hw);
	u.role = roleName(role);
	out.detail = `${u.longName} (${u.shortName}), ${u.hwModel}, ${u.role}${hasKey ? ', has public key' : ''}`;
	out.node = u;
}

/** Device metrics (telemetry.proto DeviceMetrics) or local stats (LocalStats, local) into the node update. */
function metrics(m: PbField, local: boolean, u: MeshNode): void {
	for (const g of fields(m.data)) {
		const key = `${g.num}/${g.wire}`;
		if (local) {
			if (key === '1/0') u.uptimeS = g.value;
			else if (key === '2/5') u.channelUtilPct = asF32(g);
			else if (key === '3/5') u.airUtilTxPct = asF32(g);
		} else if (key === '1/0')
			u.batteryPct = g.value > 100 ? 101 : g.value; // 101 = on external power
		else if (key === '2/5') u.voltage = asF32(g);
		else if (key === '3/5') u.channelUtilPct = asF32(g);
		else if (key === '4/5') u.airUtilTxPct = asF32(g);
		else if (key === '5/0') u.uptimeS = g.value;
	}
}

function deviceDetail(u: MeshNode): string {
	const head =
		u.batteryPct > 100
			? `powered, ${u.voltage.toFixed(2)} V`
			: u.batteryPct >= 0
				? `battery ${Math.trunc(u.batteryPct)} %, ${u.voltage.toFixed(2)} V`
				: 'device metrics';
	return `${head}, ch util ${u.channelUtilPct.toFixed(1)} %, air tx ${u.airUtilTxPct.toFixed(1)} %`;
}

function airQuality(f: PbField): string {
	let s = 'air quality';
	const v: Record<number, number> = {};
	for (const g of fields(f.data)) if (g.wire === 0 && (g.num === 2 || g.num === 3 || g.num === 13)) v[g.num] = g.value;
	if (v[2] !== undefined) s += `, PM2.5 ${v[2]}`;
	if (v[3] !== undefined) s += `, PM10 ${v[3]}`;
	if (v[13] !== undefined) s += `, CO2 ${v[13]} ppm`;
	return s;
}

/** Power channels (PowerMetrics): voltage and current as fixed32 floats. */
function power(f: PbField): string {
	const v: Array<number | undefined> = [undefined, undefined, undefined];
	const i: Array<number | undefined> = [undefined, undefined, undefined];
	for (const g of fields(f.data))
		if (g.wire === 5 && g.num >= 1 && g.num <= 6) (((g.num - 1) & 1) === 0 ? v : i)[(g.num - 1) >> 1] = asF32(g);
	let s = 'power';
	for (let k = 0; k < 3; k++) {
		const vk = v[k],
			ik = i[k];
		if (vk === undefined) continue;
		s += `, ch${k + 1} ${vk.toFixed(2)} V`;
		if (ik !== undefined) s += ` ${ik.toFixed(1)} mA`;
	}
	return s;
}

/** TELEMETRY_APP (telemetry.proto Telemetry): the last section present gives the detail line. */
function telemetry(d: MtData, out: MtDecoded): void {
	const u = emptyNode();
	let det = '';
	for (const f of fields(d.payload)) {
		if (f.wire !== 2) continue;
		if (f.num === 2) {
			metrics(f, false, u);
			det = deviceDetail(u);
		} else if (f.num === 4) det = airQuality(f);
		else if (f.num === 5) det = power(f);
		else if (f.num === 3) {
			for (const g of fields(f.data)) {
				if (g.wire !== 5 || g.num < 1 || g.num > 3) continue;
				if (g.num === 1) u.tempC = asF32(g);
				else if (g.num === 2) u.humidity = asF32(g);
				else u.pressureHpa = asF32(g);
				u.hasEnv = true;
			}
			det = `environment ${u.tempC.toFixed(1)} C, ${u.humidity.toFixed(0)} %, ${u.pressureHpa.toFixed(0)} hPa`;
		} else if (f.num === 6) {
			metrics(f, true, u);
			det = `local stats, uptime ${u.uptimeS} s`;
		}
	}
	out.detail = det || 'telemetry';
	out.node = u;
}

/** TRACEROUTE_APP (mesh.proto RouteDiscovery): request or reply, the route, the SNRs (quarter dB) and the hops back. */
function traceroute(d: MtData, c: MtCtx, out: MtDecoded): void {
	const req = d.wantResponse || d.requestId === 0;
	const route: string[] = [];
	const snr: string[] = [];
	let back = 0;
	for (const f of fields(d.payload)) {
		if (f.num === 1) eachFixed32(f, (n) => route.push(nodeId(n)));
		else if (f.num === 2) eachVarint(f, (v) => snr.push(((v | 0) / 4).toFixed(1)));
		else if (f.num === 3) eachFixed32(f, () => back++);
	}
	const fromId = nodeId(c.from);
	let s = `${req ? 'traceroute request: ' : 'traceroute reply: '}${req ? fromId : nodeStr(c.to)}`;
	for (const n of route) s += ` > ${n}`;
	s += ` > ${req ? nodeStr(c.to) : fromId}`;
	if (snr.length) s += ` (SNR ${snr.join(' ')} dB)`;
	if (back > 0) s += `, back ${back} hops`;
	out.detail = s;
}

/** NEIGHBORINFO_APP (mesh.proto NeighborInfo): the number of neighbours and the first four with their SNR. */
function neighbors(d: MtData, out: MtDecoded): void {
	const list: string[] = [];
	let count = 0;
	for (const f of fields(d.payload)) {
		if (f.num !== 4 || f.wire !== 2) continue;
		let id = 0,
			snr = 0;
		for (const g of fields(f.data)) {
			if (g.num === 1) id = g.lo;
			else if (g.num === 2 && g.wire === 5) snr = asF32(g);
		}
		if (count < 4) list.push(`${nodeId(id)} ${snr.toFixed(1)} dB`);
		count++;
	}
	out.detail = `${count} neighbors${list.length ? `: ${list.join(', ')}` : ''}`;
}

/** ROUTING_APP (mesh.proto Routing): an ack, an error or a route discovery. */
function routing(d: MtData, out: MtDecoded): void {
	let err = 0,
		hasRoute = false;
	for (const f of fields(d.payload)) {
		if (f.num === 3 && f.wire === 0) err = asI32(f);
		else if ((f.num === 1 || f.num === 2) && f.wire === 2) hasRoute = true;
	}
	out.detail = hasRoute
		? 'route discovery'
		: err === 0
			? `ack of ${hex8(d.requestId)}`
			: `error ${ROUTING_ERRORS.get(err) ?? '?'} for ${hex8(d.requestId)}`;
}

/** TEXT_MESSAGE_APP: the text message (control characters as blanks). */
function text(d: MtData, c: MtCtx, out: MtDecoded): void {
	const m = emptyMessage();
	m.from = nodeId(c.from);
	m.to = nodeStr(c.to);
	const t = cleanText(d.payload);
	m.text = utf8(t);
	m.hops = c.hopStart > 0 ? c.hopStart - c.hopLimit : -1;
	m.packetId = c.packetId;
	m.replyId = d.replyId;
	out.detail = clip(t, 80) + (d.replyId ? ' (reply)' : '');
	out.message = m;
}

/** Decodes the payload of the port in d into a detail line and the records. */
export function decodePort(d: MtData, c: MtCtx): MtDecoded {
	const out: MtDecoded = { detail: '' };
	switch (d.portnum) {
		case 1:
			text(d, c, out);
			break;
		case 3:
			position(d, out);
			break;
		case 4:
			nodeinfo(d, out);
			break;
		case 5:
			routing(d, out);
			break;
		case 67:
			telemetry(d, out);
			break;
		case 70:
			traceroute(d, c, out);
			break;
		case 71:
			neighbors(d, out);
			break;
		case 10:
		case 11:
		case 32:
		case 66: {
			// plain text ports: detection sensor, alert, reply, range test
			const label = d.portnum === 10 ? 'sensor: ' : d.portnum === 11 ? 'ALERT: ' : d.portnum === 32 ? 'reply: ' : 'range test: ';
			out.detail = label + clip(d.payload, 120);
			break;
		}
		default:
			out.detail = otherPort(d);
	}
	return out;
}

/** WAYPOINT_APP, PAXCOUNTER_APP, STORE_FORWARD_APP, MAP_REPORT_APP and the rest (their length). */
function otherPort(d: MtData): string {
	if (d.portnum === 8) return waypoint(d);
	if (d.portnum === 34) {
		const v: Record<number, number> = { 1: 0, 2: 0, 3: 0 };
		for (const f of fields(d.payload)) if (f.wire === 0 && f.num >= 1 && f.num <= 3) v[f.num] = f.value;
		return `paxcounter: wifi ${v[1]}, ble ${v[2]}, uptime ${v[3]} s`;
	}
	if (d.portnum === 65) return storeForward(d);
	if (d.portnum === 73) return mapReport(d);
	return `${d.payload.length} bytes`;
}

/** WAYPOINT_APP (mesh.proto Waypoint): a named map pin. */
function waypoint(d: MtData): string {
	let id = 0,
		lat: number | undefined,
		lon: number | undefined,
		name: Uint8Array = new Uint8Array(0),
		desc: Uint8Array = new Uint8Array(0);
	for (const f of fields(d.payload)) {
		const key = `${f.num}/${f.wire}`;
		if (key === '1/0') id = f.value;
		else if (key === '2/5') lat = asI32(f);
		else if (key === '3/5') lon = asI32(f);
		else if (key === '6/2') name = f.data;
		else if (key === '7/2') desc = f.data;
	}
	let s = `waypoint ${id}`;
	if (name.length) s += ` ${utf8(cleanText(name))}`;
	if (desc.length) s += `: ${utf8(cleanText(desc))}`;
	if (lat !== undefined && lon !== undefined) s += ` at ${(lat * 1e-7).toFixed(5)} ${(lon * 1e-7).toFixed(5)}`;
	return s;
}

const SF_NAMES = new Map<number, string>([
	[1, 'router error'],
	[2, 'router heartbeat'],
	[3, 'router ping'],
	[4, 'router pong'],
	[5, 'router busy'],
	[6, 'router history'],
	[7, 'router stats'],
	[8, 'text direct'],
	[9, 'text broadcast'],
	[64, 'client error'],
	[65, 'client history request'],
	[66, 'client stats request'],
	[67, 'client ping'],
	[68, 'client pong'],
	[106, 'client abort'],
]);

/** STORE_FORWARD_APP (storeforward.proto): the request/response code and, for a router, its heartbeat or history size. */
function storeForward(d: MtData): string {
	let rr = 0,
		secondary = 0,
		period: number | undefined,
		hist: number | undefined;
	for (const f of fields(d.payload)) {
		if (f.num === 1 && f.wire === 0) rr = f.value;
		else if (f.num === 3 && f.wire === 2) {
			for (const g of fields(f.data)) if (g.num === 1 && g.wire === 0) hist = g.value;
		} else if (f.num === 4 && f.wire === 2)
			for (const g of fields(f.data)) {
				if (g.num === 1 && g.wire === 0) period = g.value;
				else if (g.num === 2 && g.wire === 0) secondary = g.value;
			}
	}
	let s = `store and forward: ${SF_NAMES.get(rr) ?? 'unset'}`;
	if (period !== undefined) s += `, every ${period} s${secondary ? ', secondary' : ''}`;
	if (hist !== undefined) s += `, ${hist} messages`;
	return s;
}

/** MAP_REPORT_APP (mqtt.proto MapReport): name, firmware, position, nodes online. */
function mapReport(d: MtData): string {
	let name: Uint8Array = new Uint8Array(0),
		fw: Uint8Array = new Uint8Array(0),
		lat: number | undefined,
		lon: number | undefined,
		nodes: number | undefined;
	for (const f of fields(d.payload)) {
		const key = `${f.num}/${f.wire}`;
		if (key === '1/2') name = f.data;
		else if (key === '5/2') fw = f.data;
		else if (key === '9/5') lat = asI32(f);
		else if (key === '10/5') lon = asI32(f);
		else if (key === '13/0') nodes = f.value;
	}
	let s = `map report: ${clip(name, 40)}`;
	if (fw.length) s += `, fw ${clip(fw, 24)}`;
	if (lat !== undefined && lon !== undefined) s += `, ${(lat * 1e-7).toFixed(5)} ${(lon * 1e-7).toFixed(5)}`;
	if (nodes !== undefined) s += `, ${nodes} nodes`;
	return s;
}
