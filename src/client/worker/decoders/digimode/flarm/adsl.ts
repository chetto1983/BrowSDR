// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/adsl/adsl_rx.cpp (AdslReceiver::Impl: tryJob, tryNet,
// onPacket, applyTraffic, the status of a known aircraft), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the M-band only (868.2 / 868.4 MHz; the O-band at 869.525 MHz is outside the channel); a Traffic target
// becomes an aircraft record (OnAir updates its aircraft table); a packet goes through the input block's queue
// (report.ts FrameQueue), so the copy a strong signal leaves in the other channel counts once; no track history.

import type { FlarmChannel } from './channel';
import { FLARM_RATE } from './front';
import {
	amtName,
	categoryName,
	checkParity,
	correctCrc,
	emergencyName,
	parseNetwork,
	STATUS_NET_BYTES,
	TRAFFIC_NET_BYTES,
	TYPE_FISB,
	TYPE_REMOTE_ID,
} from './adsl-proto';
import type { AdslParsed, AdslStatus, AdslTraffic, AircraftReport, ProtocolHost, SyncCand } from './types';

const EXPIRY_SEC = 60;
const FLIGHT_STATES = ['undefined', 'on the ground', 'airborne', 'reserved'];

const hex6 = (v: number): string => (v & 0xffffff).toString(16).toUpperCase().padStart(6, '0');
const key = (amt: number, addr: number): string => `adsl:${amt}:${addr & 0xffffff}`;

/** ADS-L on the M-band: length, parity (CRC, a CRC repair of the weakest bits, Reed-Solomon), Traffic, Status, Uplink. */
export class AdslProtocol {
	/** Aircraft heard in good packets, with their last status. */
	private readonly known = new Map<string, { lastSeen: number; status?: AdslStatus }>();
	fisB = 0;
	remoteId = 0;

	constructor(private readonly host: ProtocolHost) {}

	expire(tnow: number): void {
		for (const [k, v] of this.known) if (tnow - v.lastSeen > EXPIRY_SEC) this.known.delete(k);
	}

	/** A sync whose packet is all in. The length byte has no parity of its own: the usual sizes are tried as well. */
	job(ch: FlarmChannel, cd: SyncCand): void {
		const level = ch.level(cd.k0 - 16, cd.k0 + (1 + 32) * 16);
		const len = ch.byteAt(cd, 0);
		const sizes: number[] = [];
		if (len >= 8) sizes.push(len);
		if (len !== TRAFFIC_NET_BYTES) sizes.push(TRAFFIC_NET_BYTES);
		if (len !== STATUS_NET_BYTES) sizes.push(STATUS_NET_BYTES);
		if (sizes.some((n) => this.tryNet(ch, cd, n, level))) return;
		if (cd.err <= 1) this.host.stats.adsl.bad++;
	}

	private tryNet(ch: FlarmChannel, cd: SyncCand, n: number, level: number): boolean {
		const net = new Uint8Array(n);
		const margin = new Float32Array(n * 8);
		for (let i = 0; i < n; i++) net[i] = ch.byteAt(cd, 1 + i, margin, 8 * i);
		let fixed = checkParity(net);
		if (fixed < 0 && n === TRAFFIC_NET_BYTES) {
			const order = Array.from({ length: n * 8 }, (_, i) => i).sort((a, b) => margin[a] - margin[b]);
			fixed = correctCrc(net, order, 4);
		}
		if (fixed < 0) return false;
		const q = parseNetwork(net);
		if (q.kind === 'bad' || q.kind === 'reserved') return false;
		const t = ch.n / FLARM_RATE;
		this.host.queue({ key: `adsl:${String.fromCharCode(...net)}`, t, level, apply: () => this.onPacket(q, ch.index, t, level, fixed) });
		return true;
	}

	private onPacket(q: AdslParsed, channel: number, tnow: number, level: number, fixed: number): void {
		const s = this.host.stats.adsl;
		s.ok++;
		if (fixed) s.corrected++;
		if (q.signature) s.signed++;
		const trusted = fixed === 0;
		switch (q.kind) {
			case 'traffic':
				s.traffic++;
				for (const t of q.targets) this.traffic(t, channel, tnow, level, false, trusted);
				break;
			case 'uplink':
				s.uplink++;
				for (const t of q.targets) this.traffic(t, channel, tnow, level, true, trusted);
				break;
			case 'status': {
				s.status++;
				const k = this.known.get(key(q.amt, q.addr));
				if (k) k.status = q.status;
				break;
			}
			case 'encrypted':
				s.encrypted++;
				break;
			default:
				if (q.type === TYPE_FISB) this.fisB++;
				else if (q.type === TYPE_REMOTE_ID) this.remoteId++;
				else s.other++;
		}
	}

	/** A repaired packet can only add to an aircraft already known. */
	private traffic(p: AdslTraffic, channel: number, tnow: number, level: number, uplink: boolean, trusted: boolean): void {
		const k = key(p.amt, p.addr);
		const entry = this.known.get(k);
		if (!entry && !trusted) return;
		const known = entry ?? { lastSeen: tnow };
		known.lastSeen = tnow;
		this.known.set(k, known);
		this.host.report(k, adslReport(p, channel, level, uplink, known.status), tnow);
	}
}

function statusFields(s: AdslStatus): Array<[string, string]> {
	return [
		['Highest version', String(s.maxVersion)],
		['Receives', `M-band ${s.mRx}, O-band LDR ${s.ldrRx}, HDR ${s.hdrRx}`],
	];
}

/** The record of one Traffic target. */
export function adslReport(p: AdslTraffic, channel: number, level: number, uplink: boolean, status?: AdslStatus): AircraftReport {
	const extra: Array<[string, string]> = [
		['Flight state', FLIGHT_STATES[p.flightState]],
		['Emergency', emergencyName(p.emergency)],
		['Accuracy', `NIC ${p.nic}, horizontal ${p.hAcc}, vertical ${p.vAcc}, velocity ${p.velAcc}`],
	];
	if (uplink) extra.push(['Received', 'through a ground uplink']);
	else if (p.relay) extra.push(['Received', 'relayed']);
	if (status) extra.push(...statusFields(status));
	const r: AircraftReport = {
		protocol: 'ADS-L',
		id: hex6(p.addr),
		idType: amtName(p.amt),
		aircraft: categoryName(p.category),
		channel,
		levelDb: level,
		extra,
		alert: p.emergency >= 2 && p.emergency <= 6,
	};
	if (p.hasPos) Object.assign(r, { lat: p.lat, lon: p.lon });
	if (p.hasAlt) r.altM = p.altM;
	if (p.hasClimb) r.climbMs = p.climbMs;
	if (p.hasSpeed) r.speedKmh = p.speedMs * 3.6;
	if (p.hasTrack) r.trackDeg = p.trackDeg;
	return r;
}
