// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/avroad/avroad_air.cpp (FanetDec: the LoRa receiver set to SF7,
// sync word 0xF1 and 250 kHz, or 500 kHz above 900 MHz; frames with a bad CRC or that do not parse only counted; one row
// per frame; the headline) and core/src/avroad/avroad_dec.cpp (the FANET tuning, 868.2 MHz), with the LoRa receiver of
// core/src/loraraw/loraraw_rx.cpp (the default preamble of 8), https://github.com/adswill/OnAir; see third_party/onair.
// Format facts as credited there: the FANET protocol description (protocol.txt of Skytraxx's fanet-stm32,
// https://github.com/3s1d/fanet-stm32; format only, no code copied). Changes: BrowSDR's LoRa bank on the VFO channel;
// the band is the catalog entry's (OnAir picks it from the tuned frequency), with the description's 125 kHz zones too;
// records paced as FLARM's (an aircraft when first heard, then at most every 5 s; other frames per sender and kind),
// with the distance from the station; positions whose sender switched online tracking off are counted, never shown
// (OnAir shows them); a status line in place of OnAir's table and headline.

import { LoraBank } from '@/worker/decoders/digimode/lora/bank';
import { loraRadio, radioFields } from '@/worker/decoders/digimode/lora/decoder';
import { hexEncode } from '@/worker/decoders/digimode/lora/crypto';
import type { LoraDecoded } from '@/worker/decoders/digimode/lora/types';
import { AircraftTable, aircraftRecord } from '@/worker/decoders/digimode/flarm/report';
import type { LatLon, PacedReport } from '@/worker/decoders/digimode/flarm/types';
import type { DigimodeDecoder, DigimodeSink } from '@/worker/decoders/digimode/types';
import { fanetAddress } from './names';
import { fanetParse } from './proto';
import { frameRecord, trackingReport } from './report';
import type { FanetBand, FanetFrame, FanetRecord, FanetStats } from './types';

export { fanetParse } from './proto';

/** Europe (868.2 MHz) and India (866.2 MHz). */
export const FANET_250: FanetBand = { bwHz: 250000, rate: 500000 };
/** The Americas, Australia and New Zealand (920.8 MHz). */
export const FANET_500: FanetBand = { bwHz: 500000, rate: 1000000 };
/** Korea and the rest of Asia (923.2 MHz), Israel (918.5 MHz). */
export const FANET_125: FanetBand = { bwHz: 125000, rate: 250000 };
export const FANET_SF = 7;
export const FANET_SYNC = 0xf1;

/** An aircraft heard within this time counts as present, s. */
const PRESENT_SEC = 30;
/** Expiry and status at most this often, s of signal. */
const TICK_SEC = 0.25;

/** Records of a sender are paced per kind; a name, message or landmark per content (a forwarded copy is not shown again). */
function paceKey(id: string, f: FanetFrame, payload: Uint8Array): string {
	if (f.type === 3) return `${id} 3 ${f.unicast ? fanetAddress(f.destManufacturer, f.destDevice) : ''} ${f.message}`;
	if (f.type === 2) return `${id} 2 ${f.name}`;
	if (f.type === 5) return `${id} 5 ${hexEncode(payload.subarray(4))}`;
	return `${id} ${f.type}`;
}

/** FANET on the VFO channel: SF7, sync word 0xF1, the band's bandwidth. */
export class FanetDecoder implements DigimodeDecoder {
	readonly stats: FanetStats = { frames: 0, crcBad: 0, invalid: 0, privacyFrames: 0 };
	private bank: LoraBank;
	private readonly got: LoraDecoded[] = [];
	private readonly aircraft = new AircraftTable();
	private readonly others = new AircraftTable<PacedReport>();
	private readonly names = new Map<string, string>();
	/** Senders whose positions were withheld (online tracking off). */
	private readonly hidden = new Set<string>();
	private station: LatLon | null = null;
	private samples = 0;
	/** Seconds of signal when the bank started (it restarts at reset). */
	private bankStart = 0;
	private nextTick = 0;
	private lastStatus = '';

	constructor(
		private readonly sink: DigimodeSink,
		readonly band: FanetBand = FANET_250,
	) {
		this.bank = this.newBank();
	}

	private newBank(): LoraBank {
		return new LoraBank({ bwHz: this.band.bwHz, rate: this.band.rate, sfs: [FANET_SF], syncs: [FANET_SYNC], preamble: 8 });
	}

	setStation(lat: number, lon: number): void {
		this.station = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
	}

	/** Seconds of signal so far. */
	now(): number {
		return this.samples / this.band.rate;
	}

	process(iq: Float32Array): void {
		this.got.length = 0;
		this.bank.feed(iq, this.got);
		this.samples += iq.length >> 1;
		for (const d of this.got) this.frame(d);
		const t = this.now();
		if (t < this.nextTick && !this.got.length) return;
		this.nextTick = t + TICK_SEC;
		this.aircraft.expire(t);
		this.others.expire(t);
		this.updateStatus();
	}

	/** The demodulators start again; the senders heard stay. */
	reset(): void {
		this.bankStart = this.now();
		this.bank = this.newBank();
	}

	/** Aircraft heard in the last 30 s. */
	aircraftCount(): number {
		return this.aircraft.recent(this.now(), PRESENT_SEC);
	}

	private frame(d: LoraDecoded): void {
		const fr = d.frame;
		// FANET always sends a payload CRC (OnAir counts any frame without a good one as bad)
		if (!fr.hdr.crc || !fr.crcOk) {
			this.stats.crcBad++;
			return;
		}
		const f = fanetParse(fr.payload);
		if (!f.valid) {
			this.stats.invalid++;
			return;
		}
		this.stats.frames++;
		const tnow = this.bankStart + d.sec;
		const id = fanetAddress(f.manufacturer, f.device);
		if (f.name) this.names.set(id, f.name);
		if ((f.type === 1 || f.type === 7) && !f.online) {
			this.stats.privacyFrames++;
			this.hidden.add(id);
			this.aircraft.delete(id);
			this.others.delete(`${id} 7`);
			return;
		}
		const name = this.names.get(id);
		if (f.type === 1) {
			const report = trackingReport(f, name);
			if (this.aircraft.update(id, report, tnow)) this.emit(aircraftRecord(report, this.station), d);
			return;
		}
		const r = frameRecord(f, name, this.station);
		if (this.others.update(paceKey(id, f, fr.payload), { alert: r.alert }, tnow)) this.emit(r, d);
	}

	private emit(r: FanetRecord, d: LoraDecoded): void {
		const text = r.text.slice(0, 2000);
		const fields = [...r.fields, ...radioFields(loraRadio(d), d.frame.payload)]
			.slice(0, 64)
			.map(([k, v]): [string, string] => [k, v.slice(0, 4000)]);
		this.sink.record(r.alert ? { text, fields, alert: true } : { text, fields });
	}

	private statusText(present: number): string {
		const s = this.stats;
		const bw = `SF${FANET_SF}, ${this.band.bwHz / 1000} kHz`;
		if (!s.frames)
			return s.crcBad || s.invalid
				? `Listening for FANET (${bw}): no good frame yet, ${s.crcBad + s.invalid} bad`
				: `Listening for FANET (${bw})`;
		const parts = [`${present} aircraft`, `${s.frames} frames`];
		if (s.crcBad) parts.push(`${s.crcBad} CRC errors`);
		if (this.hidden.size) parts.push(`${this.hidden.size} with online tracking off (not shown)`);
		return parts.join(' · ');
	}

	private updateStatus(): void {
		const present = this.aircraftCount();
		const text = this.statusText(present);
		const locked = present > 0 || this.bank.receiving;
		const key = `${text}|${locked}`;
		if (key === this.lastStatus) return;
		this.lastStatus = key;
		this.sink.status(text, locked);
	}
}
