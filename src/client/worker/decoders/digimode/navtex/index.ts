// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// NAVTEX receiver for BrowSDR, after OnAir core/src/marine/marine_rx.cpp (the NAVTEX path: spectrum and FSK centre
// finder, FSK slicer, decoders of both polarities, repeats listed once), https://github.com/adswill/OnAir;
// see third_party/onair.
//
// The channel is complex baseband at 24 kHz centred on the tuned frequency, as OnAir takes HF signals: the dial is the
// carrier (the FSK centre), the tones sit at ±85 Hz. The centre is looked for within ±600 Hz of the dial.

import type { DigimodeDecoder, DigimodeSink } from '@/worker/decoders/digimode/types';
import { FskSlicer } from '@/worker/decoders/digimode/dsc/slicers';
import { NavtexDecoder } from './decoder';
import { FskSpectrum } from './spectrum';
import type { FskInfo, NavtexMessage } from './types';

export const NAVTEX_RATE = FskSlicer.RATE;
/** Messages remembered so that a repeat of the same text is listed once. */
const REMEMBER = 100;
/** Longest text in a record field (the panel's limit). */
const MAX_TEXT = 4000;
const MAX_LINE = 200;

const signed = (hz: number) => `${hz >= 0 ? '+' : '−'}${Math.abs(Math.round(hz))}`;

export class NavtexReceiver implements DigimodeDecoder {
	private readonly spectrum = new FskSpectrum();
	private readonly fsk = new FskSlicer();
	private readonly decoders = [new NavtexDecoder((m) => this.report(m), false), new NavtexDecoder((m) => this.report(m), true)];
	private fskInfo?: FskInfo;
	private frames = 0;
	private heard: string[] = [];
	private lastStatus = '';

	constructor(private readonly sink: DigimodeSink) {}

	process(iq: Float32Array): void {
		if (this.spectrum.push(iq)) {
			this.frames++;
			const info = this.spectrum.findFsk(170, 600);
			if (info.found) this.fsk.setCentreHz(info.centreHz);
			if (this.frames % 4 === 1) this.fskInfo = info; // the status line moves about every 1.4 s
		}
		this.fsk.process(iq, (soft) => {
			for (const decoder of this.decoders) decoder.pushBit(soft); // B = 1 = the higher tone
		});
		this.updateStatus();
	}

	reset(): void {
		for (const decoder of this.decoders) decoder.reset();
		this.spectrum.reset();
		this.fsk.reset();
		this.fskInfo = undefined;
		this.frames = 0;
		this.lastStatus = '';
	}

	private updateStatus(): void {
		const locked = this.decoders.some((decoder) => decoder.locked);
		const header = this.decoders.map((decoder) => decoder.header).find((value) => value !== null);
		const info = this.fskInfo;
		let message = 'Looking for the FSK tones within ±600 Hz';
		if (header !== undefined) message = `Receiving message ${header || '…'}`;
		else if (locked) message = 'Locked, waiting for ZCZC';
		else if (info?.found) message = `FSK signal ${signed(info.centreHz)} Hz from the dial, ${Math.round(info.snrDb)} dB`;
		if (message === this.lastStatus) return;
		this.lastStatus = message;
		this.sink.status(message, locked);
	}

	private report(m: NavtexMessage): void {
		const key = `${m.header}\n${m.complete}\n${m.text}`;
		if (this.heard.includes(key)) return;
		this.heard.push(key);
		if (this.heard.length > REMEMBER) this.heard.shift();
		const number = m.number >= 0 ? String(m.number).padStart(2, '0') : '??';
		const first = (m.text.split('\n').find((line) => line.trim()) ?? '').trim();
		const line = first.length > MAX_LINE ? `${first.slice(0, MAX_LINE - 1)}…` : first;
		const text = m.text.length > MAX_TEXT ? `${m.text.slice(0, MAX_TEXT - 1)}…` : m.text;
		this.sink.record({
			text: `NAVTEX ${m.station} ${m.subjectName} ${number}: ${line}${m.complete ? '' : ' (cut short)'}`,
			fields: [
				['Station', m.station],
				['Subject', `${m.subject} - ${m.subjectName}`],
				['Number', number],
				['Header', m.header],
				['Characters', String(m.chars)],
				['Unreadable', `${m.errors} (${(100 * m.cer).toFixed(1)} %)`],
				['End', m.complete ? 'NNNN received' : 'Cut short (no NNNN)'],
				['Text', text],
			],
			damaged: !m.complete,
			alert: m.subject === 'D' || m.number === 0,
		});
	}
}
