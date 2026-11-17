// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/flarm/flarm_rx.cpp (FlarmReceiver: configure, feed, publish,
// the clock and reference settings) and core/src/adsl/adsl_rx.cpp (AdslReceiver: the M-band part of feed and publish),
// with the OGN tracker decoder of core/src/avroad/avroad_air.cpp (OgnDec), https://github.com/adswill/OnAir; see
// third_party/onair. Changes: FLARM, the ADS-L M-band and the OGN tracker protocol run on the same two channels of
// one 400 kS/s VFO channel at 868.3 MHz (OnAir: three receivers, ADS-L also on the O-band at 869.525 MHz); records of
// the aircraft paced by report.ts and a status line in place of the aircraft table and telemetry; the station location
// (when the app knows one) is the reference of FLARM positions and of distances.

import type { DigimodeDecoder, DigimodeSink } from '@/worker/decoders/digimode/types';
import { AdslProtocol } from './adsl';
import { FlarmChannel } from './channel';
import { FlarmProtocol } from './flarm';
import { FLARM_RATE, FlarmFront } from './front';
import { OgnFrames } from './ogn';
import { AircraftTable, aircraftRecord, FrameQueue } from './report';
import type { AircraftEntry, AircraftReport, FlarmOptions, FlarmStats, LatLon, ProtocolHost, QueuedFrame } from './types';

export { FLARM_RATE } from './front';

/** An aircraft heard within this time counts as present, s. */
const PRESENT_SEC = 30;
/** Expiry and status at most this often, s of signal. */
const TICK_SEC = 0.25;

function emptyStats(): FlarmStats {
	const counts = { ok: 0, bad: 0 };
	return {
		flarm: { ...counts, perChannel: [0, 0], newProtocol: 0, newProtocolDevices: 0, otherType: 0, privacyFlagged: 0, privacyPackets: 0 },
		ogn: { ...counts, repaired: 0, encrypted: 0, privacy: 0 },
		adsl: { ...counts, traffic: 0, status: 0, uplink: 0, encrypted: 0, other: 0, corrected: 0, signed: 0 },
	};
}

/** FLARM (old protocol), OGN trackers and ADS-L on 868.2 and 868.4 MHz, from a VFO at 868.3 MHz. */
export class FlarmDecoder implements DigimodeDecoder, ProtocolHost {
	readonly stats = emptyStats();
	readonly options: FlarmOptions;
	private readonly front = new FlarmFront();
	private readonly channels: FlarmChannel[];
	private readonly flarm = new FlarmProtocol(this);
	private readonly adsl = new AdslProtocol(this);
	private readonly frames = new FrameQueue();
	private readonly ogn = new OgnFrames(
		this.stats,
		(key, report, tnow) => this.report(key, report, tnow),
		(key) => this.hide(key),
		(frame) => this.queue(frame),
	);
	private readonly table = new AircraftTable();
	private ref: LatLon | null = null;
	/** Unix time of the first sample; undefined: the computer's clock. */
	private unix0?: number;
	private nextTick = 0;
	private lastStatus = '';

	constructor(
		private readonly sink: DigimodeSink,
		options: Partial<FlarmOptions> = {},
	) {
		this.options = { chase: true, toneDetect: true, ...options };
		const chips = {
			flarmJob: this.flarm.job.bind(this.flarm),
			adslJob: this.adsl.job.bind(this.adsl),
			ognFrame: (channel: number, bytes: Uint8Array, soft: Float32Array, sec: number, level: number) =>
				this.ogn.frame(channel, bytes, soft, sec, level),
		};
		this.channels = [new FlarmChannel(0, chips, this.options), new FlarmChannel(1, chips, this.options)];
	}

	/** The station: the reference that completes FLARM positions (within ±3° latitude, ±6° longitude) and of distances. */
	setStation(lat: number, lon: number): void {
		this.ref = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
	}

	/** Files and tests: the unix time of the first sample, in place of the computer's clock (FLARM keys change every 64 s). */
	setUnixTime(unixSecAtStart: number): void {
		this.unix0 = unixSecAtStart;
	}

	station(): LatLon | null {
		return this.ref;
	}

	unixNow(tnow: number): number {
		return this.unix0 === undefined ? Date.now() / 1000 : this.unix0 + tnow;
	}

	/** Seconds of signal so far. */
	now(): number {
		return this.channels[0].n / FLARM_RATE;
	}

	/** The aircraft heard, by protocol and address, with their packet counts (tests). */
	heard(): Map<string, AircraftEntry> {
		return new Map(this.table.snapshot());
	}

	/** Aircraft heard in the last 30 s. */
	aircraftCount(): number {
		return this.table.recent(this.now(), PRESENT_SEC);
	}

	process(iq: Float32Array): void {
		const f = this.front;
		const count = f.process(iq);
		this.channels[0].process(f.re0, f.im0, count);
		this.channels[1].process(f.re1, f.im1, count);
		this.frames.flush();
		const t = this.now();
		if (t < this.nextTick) return;
		this.nextTick = t + TICK_SEC;
		this.table.expire(t);
		this.flarm.expire(t);
		this.adsl.expire(t);
		this.updateStatus();
	}

	/** The demodulators start again; the aircraft stay (OnAir's reset). */
	reset(): void {
		this.front.reset();
		for (const channel of this.channels) channel.reset();
	}

	queue(frame: QueuedFrame): void {
		this.frames.push(frame);
	}

	report(key: string, report: AircraftReport, tnow: number): void {
		if (!this.table.update(key, report, tnow)) return;
		this.sink.record(aircraftRecord(report, this.ref));
		this.updateStatus();
	}

	hide(key: string): void {
		this.table.delete(key);
		this.updateStatus();
	}

	private statusText(present: number): string {
		const { flarm, ogn, adsl } = this.stats;
		if (!flarm.ok && !ogn.ok && !adsl.ok && !flarm.newProtocol)
			return this.channels.some((c) => c.n - c.lastEnergyN < 5 * FLARM_RATE)
				? 'Energy on 868.2 / 868.4 MHz, no good packet yet'
				: 'Listening on 868.2 and 868.4 MHz';
		const parts = [`${present} aircraft`, `FLARM ${flarm.ok}, OGN ${ogn.ok}, ADS-L ${adsl.ok} packets`];
		if (flarm.newProtocol) parts.push(`${flarm.newProtocolDevices} FLARM on the newer protocol (not decoded)`);
		const hidden = flarm.privacyFlagged + ogn.privacy;
		if (hidden) parts.push(`${hidden} privacy-flagged (not shown)`);
		if (ogn.encrypted || adsl.encrypted) parts.push(`${ogn.encrypted + adsl.encrypted} encrypted`);
		if (!this.ref && flarm.ok) parts.push('set the station location for FLARM positions');
		return parts.join(' · ');
	}

	private updateStatus(): void {
		const present = this.aircraftCount();
		const text = this.statusText(present);
		if (text === this.lastStatus) return;
		this.lastStatus = text;
		this.sink.status(text, present > 0);
	}
}
