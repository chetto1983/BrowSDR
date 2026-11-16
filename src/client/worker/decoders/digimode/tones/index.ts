// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/tones/tones_rx.cpp (TonesReceiver: the FM path and the event
// list) and core/include/dect2/tones/tones_tel.h (toneKindName, tonesSummary), https://github.com/adswill/OnAir; see
// third_party/onair. Changes: an event becomes one record once it is complete (OnAir lists it while it lasts); a
// sub-audible tone or code back within 3 s continues its record, and a call heard again within 3 s is listed once; the
// status line names everything present at once.

import type { DigimodeDecoder, DigimodeSink } from '@/worker/decoders/digimode/types';
import { FmFront } from './front';
import { ctcssHz, dcsName, dtmfKind } from './proto';
import { TonesReceiver } from './receiver';
import type { ToneEvent } from './types';

export { TONES_RATE } from './front';

/** A sub-audible tone or code back within this time (a fade, a lost chunk) continues the same record, s. */
const MERGE_SEC = 3;
/** The same call heard again within this time is reported once, s. */
const DUPLICATE_SEC = 3;
const SYSTEMS: Record<ToneEvent['kind'], string> = {
	ctcss: 'CTCSS (sub-audible tone)',
	dcs: 'DCS (digital coded squelch)',
	dtmf: 'DTMF',
	seq: 'Five-tone sequential call',
	selcal: 'SELCAL (aviation)',
	twoTone: 'Two-tone sequential page',
};
const DTMF_KINDS = {
	code: 'code (ends in #)',
	star: 'feature or access code (starts with *)',
	number: 'number (7 digits or more)',
	short: 'short',
};

export class TonesDecoder implements DigimodeDecoder {
	private readonly front = new FmFront();
	private readonly receiver = new TonesReceiver({ begin: (event) => this.begin(event), end: (event) => this.end(event) });
	/** A sub-audible tone or code that went away, reported once it stays away. */
	private held: { event: ToneEvent; until: number } | null = null;
	private readonly recent = new Map<string, number>();
	private lastStatus = 'Listening for tones';

	constructor(private readonly sink: DigimodeSink) {}

	process(iq: Float32Array): void {
		this.receiver.process(this.front.process(iq));
		if (this.held && this.receiver.now() > this.held.until) this.release();
		this.updateStatus();
	}

	reset(): void {
		this.receiver.reset();
		this.front.reset();
		this.updateStatus();
	}

	private begin(event: ToneEvent): void {
		if (event.kind !== 'ctcss' && event.kind !== 'dcs') return;
		const held = this.held?.event;
		if (held && held.kind === event.kind && held.text === event.text) {
			event.timeSec = held.timeSec;
			this.held = null;
		} else this.release();
	}

	private end(event: ToneEvent): void {
		if (event.kind === 'ctcss' || event.kind === 'dcs') {
			this.release();
			this.held = { event, until: this.receiver.now() + MERGE_SEC };
			return;
		}
		if (event.kind === 'seq' || event.kind === 'selcal') {
			const key = `${event.system} ${event.text}`;
			const now = this.receiver.now();
			for (const [old, at] of this.recent) if (now - at > DUPLICATE_SEC) this.recent.delete(old);
			const repeated = this.recent.has(key);
			this.recent.set(key, now);
			if (repeated) return;
		}
		this.report(event);
	}

	private release(): void {
		if (this.held) this.report(this.held.event);
		this.held = null;
	}

	private report(event: ToneEvent): void {
		const fields: Array<[string, string]> = [
			['System', SYSTEMS[event.kind]],
			['Value', event.text],
		];
		if (event.detail) fields.push([event.kind === 'dtmf' ? 'First key' : 'Detail', event.detail]);
		if (event.measuredHz) fields.push(['Measured', `${event.measuredHz.toFixed(2)} Hz`]);
		if (event.kind === 'dtmf') fields.push(['Kind', DTMF_KINDS[dtmfKind(event.text)]]);
		if (event.levelDb > -150) fields.push(['Level', `${event.levelDb.toFixed(1)} dB (0 dB = 5 kHz deviation)`]);
		fields.push(['Duration', `${event.durSec.toFixed(1)} s`]);
		this.sink.record({ text: `${event.system} ${event.label}`, fields });
	}

	/** What is on the channel now: the sub-audible tone or code, the keys being sent, a page. */
	private updateStatus(): void {
		const { sub, voice, twoTone } = this.receiver;
		const parts: string[] = [];
		if (sub.ctcssIdx >= 0) parts.push(`CTCSS ${ctcssHz(sub.ctcssIdx).toFixed(1)} Hz`);
		if (sub.dcsCode >= 0) parts.push(`DCS ${dcsName(sub.dcsCode, sub.dcsInv)}`);
		if (voice.dtmfString) parts.push(`DTMF ${voice.dtmfString}`);
		if (twoTone.active().length) parts.push('Two-tone page');
		const status = parts.join(' · ') || 'Listening for tones';
		if (status === this.lastStatus) return;
		this.lastStatus = status;
		this.sink.status(status, parts.length > 0);
	}
}
