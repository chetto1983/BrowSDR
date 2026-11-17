// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/aero/aero_rx.cpp (AeroReceiver: the report every quarter second,
// the aircraft named by their AES address, the log lines) and core/include/dect2/aero/aero_tel.h (aeroSummary),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: records in place of the message, log-on, aircraft and
// system tables; the station location gives distances and the satellite's place in the sky. C channel voice
// (aero_cchan, aero_crx) is not ported.
//
// Inmarsat Aero (classic Aero data): the P channels from the ground earth stations to the aircraft at 600, 1200 and
// 10500 bit/s, with log-ons, ACARS messages (ADS-C and CPDLC inside them) and the system table.

import type { DigimodeDecoder, DigimodeSink } from '@/worker/decoders/digimode/types';
import { AERO_RATE, AeroReceiver } from './receiver';
import { acarsRecord, logonRecord, systemRecord } from './report';
import type { AeroAcars, AeroHeard, AeroReceiverEvents } from './types';

export { AERO_RATE };
/** The band search stays this close to the VFO: inside the 40 kHz channel's pass-band. */
export const AERO_SEARCH_HZ = 18000;
const TICK = 0.25;
const MAX_AIRCRAFT = 200;

export class AeroDecoder implements DigimodeDecoder {
	readonly receiver: AeroReceiver;
	/** Registration and flight of the aircraft heard, by AES address. */
	private readonly aircraft = new Map<number, { registration: string; flight: string }>();
	private station: [number, number] | null = null;
	private sinceTick = 0;
	private ticks = 0;
	private lastStatus = '';
	private lastState = '';
	messages = 0;
	logons = 0;
	positions = 0;

	constructor(
		private readonly sink: DigimodeSink,
		frame?: AeroReceiverEvents['frame'],
	) {
		this.receiver = new AeroReceiver(
			{
				frame,
				acars: (m, heard) => this.acars(m, heard),
				logon: (l, heard) => {
					this.logons++;
					this.sink.record(logonRecord(l, this.aircraft.get(l.aesId)?.registration ?? '', heard));
				},
				system: (si, heard) => this.sink.record(systemRecord(si, heard, this.station)),
				channel: () => this.status(true),
			},
			AERO_SEARCH_HZ,
		);
		this.status(true);
	}

	setStation(lat: number, lon: number): void {
		this.station = [lat, lon];
	}

	process(iq: Float32Array): void {
		for (let at = 0; at < iq.length;) {
			const take = Math.min(iq.length - at, 2 * (Math.round(AERO_RATE * TICK) - this.sinceTick));
			this.receiver.process(iq.subarray(at, at + take));
			at += take;
			this.sinceTick += take >> 1;
			if (this.sinceTick >= AERO_RATE * TICK) {
				this.sinceTick = 0;
				this.status(++this.ticks % 4 === 0);
			}
		}
	}

	/** A gap in the samples: the carriers are searched again. */
	reset(): void {
		this.receiver.reset();
		this.sinceTick = 0;
		this.status(true);
	}

	private acars(m: AeroAcars, heard: AeroHeard): void {
		this.messages++;
		const known = this.aircraft.get(m.aesId);
		if (m.aesId && (m.registration || m.flight || !known)) {
			if (!known && this.aircraft.size >= MAX_AIRCRAFT) this.aircraft.delete(this.aircraft.keys().next().value!);
			this.aircraft.set(m.aesId, { registration: m.registration || known?.registration || '', flight: m.flight || known?.flight || '' });
		}
		const { rec, pos } = acarsRecord(m, heard, this.station);
		if (pos) this.positions++;
		this.sink.record(rec);
	}

	/** The state (which carriers decode) and the status line. */
	private statusLine(): [string, string] {
		const chans = this.receiver.chans;
		if (!chans.length) return ['search', `Searching for P channels (±${AERO_SEARCH_HZ / 1000} kHz)`];
		const locked = chans.filter((c) => c.active >= 0 && c.best?.synced);
		if (!locked.length) return ['carrier', `${chans.length} carrier${chans.length === 1 ? '' : 's'}, finding the bit rate and frames`];
		const parts = locked.map((c) => {
			const d = c.best!;
			return `${d.rate} bit/s at ${c.carrierHz > 0 ? '+' : ''}${(c.carrierHz / 1000).toFixed(2)} kHz, Eb/N0 ${d.ebn0Db.toFixed(1)} dB`;
		});
		const r = this.receiver;
		const counts = `${this.messages} message${this.messages === 1 ? '' : 's'}, ${this.aircraft.size} aircraft, SUs ${r.susOk} good ${r.susBad} bad`;
		return [locked.map((c) => `${c.id}:${c.best!.rate}`).join(','), `${parts.join('; ')} · ${counts}`];
	}

	/** The status line; `now` lets a new reading out, else only a change of state does. */
	private status(now: boolean): void {
		const [state, line] = this.statusLine();
		if ((!now && state === this.lastState) || line === this.lastStatus) return;
		this.lastState = state;
		this.lastStatus = line;
		this.sink.status(line, state !== 'search' && state !== 'carrier');
	}
}
