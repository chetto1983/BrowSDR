// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/hfdl/hfdl_rx.cpp (HfdlReceiver: feed, the messages of a good
// burst, the state of the telemetry: searching, preambles, decoding), core/include/dect2/hfdl/hfdl_tel.h (hfdlSummary)
// and the HFDL mode tuning of hfdl_rx.cpp (hfdlTuning), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: one channel per VFO (OnAir decodes every HFDL channel of the capture); a record per message instead of
// OnAir's HFDL screens, with the station distances and a map position; the burst decoding spread over the input
// blocks; BrowSDR's status line.
//
// One HFDL channel per VFO: the VFO on the assigned (dial) frequency, the channel 7200 Hz wide (4 samples per symbol)
// centred on the carrier 1440 Hz above it. Each squitter (SPDU) and each LPDU of a good burst is one record (OnAir's
// messages), with the ground station, the aircraft (its address from the logon, registration and flight once heard),
// its position and the decoded layers; an LPDU with a bad check sequence and an ACARS block with a bad one are shown
// dimmed. A record with an aircraft position carries it for the aircraft map of the ADS-B tool. Bursts that fail are
// counted in the status line. The burst decoding is spread over the input blocks: at most 40 % of a block's duration
// (4 to 40 ms) each time.

import type { DigimodeDecoder, DigimodeSink } from '@/worker/decoders/digimode/types';
import { HFDL_RATE } from './front';
import { HFDL_CARRIER_HZ } from './phy';
import { HfdlReceiver } from './receiver';
import { HfdlBook, recordFields, recordPosition, recordText, signedHz } from './report';
import type { HfdlBurst, HfdlCounters } from './types';

export { HFDL_RATE, HFDL_CARRIER_HZ };
/** OnAir's channel filter: 3.4 kHz. */
export const HFDL_BANDWIDTH = 3400;
/** Share of each block's duration spent decoding, and its limits, ms. */
const SLICE_SHARE = 0.4;
const SLICE_MIN_MS = 4;
const SLICE_MAX_MS = 40;
/** "Decoding" while a good burst came within this time, "preambles" while a preamble did, s (OnAir). */
const GOOD_SEC = 120;
const PREAMBLE_SEC = 60;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export class HfdlDecoder implements DigimodeDecoder {
	readonly receiver = new HfdlReceiver((b) => this.report(b));
	private readonly book = new HfdlBook();
	private station: { lat: number; lon: number } | null = null;
	private last = '';
	private lastStatus = '';

	constructor(
		private readonly sink: DigimodeSink,
		private readonly sliceMs?: number,
	) {}

	get counters(): HfdlCounters {
		return this.receiver.counters;
	}

	/** The station location: distances to the aircraft and ground stations. */
	setStation(lat: number, lon: number): void {
		this.station = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
	}

	process(iq: Float32Array): void {
		const ms = (SLICE_SHARE * (iq.length >> 1) * 1000) / HFDL_RATE;
		this.receiver.process(iq, this.sliceMs ?? Math.min(SLICE_MAX_MS, Math.max(SLICE_MIN_MS, ms)));
		this.status();
	}

	/** Decodes everything waiting, at once (the tests). */
	flush(): void {
		this.receiver.work(Infinity);
		this.status();
	}

	/** A gap in the input: the search starts again; what was learnt about aircraft and stations stays. */
	reset(): void {
		this.receiver.reset();
	}

	private report(b: HfdlBurst): void {
		const now = this.receiver.now;
		for (const m of b.messages) {
			const a = this.book.note(m, now);
			const position = recordPosition(m, a);
			this.sink.record({
				text: recordText(m, a),
				fields: recordFields(m, a, b, this.station),
				damaged: m.bad || (m.acars ? !m.acars.crcOk : false),
				...(position ? { position } : {}),
			});
		}
		if (b.ok) this.last = `last ${b.rate.bps} bit/s, SNR ${b.snrDb.toFixed(1)} dB, carrier ${signedHz(b.cfoHz)} Hz`;
	}

	private status(): void {
		const r = this.receiver;
		const c = r.counters;
		const now = r.now;
		const state = now - r.lastGoodSec < GOOD_SEC ? 2 : now - r.lastBurstSec < PREAMBLE_SEC ? 1 : 0;
		let text: string;
		if (!c.good && !c.bad) text = r.busy ? 'Decoding a burst' : c.bursts ? 'Preambles heard' : 'Searching for bursts';
		else {
			const parts = [`${plural(c.good, 'PDU')}, ${c.bad} bad`];
			parts.push(`${plural(this.book.stations.size, 'ground station')}, ${this.book.aircraft.size} aircraft`);
			if (this.last) parts.push(this.last);
			if (r.busy) parts.push('decoding a burst');
			text = parts.join(' · ');
		}
		if (text === this.lastStatus) return;
		this.lastStatus = text;
		this.sink.status(text, state === 2);
	}
}
