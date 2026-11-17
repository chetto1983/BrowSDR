// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/mpt1327/mpt1327_engine.cpp (MptReceiver: the FM discriminator
// audio of the control channel into the decoder, the message rows, mpt1327Summary), https://github.com/adswill/OnAir;
// see third_party/onair. Changes: the channel comes from BrowSDR's DDC as a 16 kHz NFM voice channel and the
// discriminator is the tone decoders' FM front (8 kHz audio; OnAir averages down to about 24 kHz, with a narrow 4.5 kHz
// filter behind a spectral carrier finder for weak signals, not ported); the calls inside the capture are not
// followed (no traffic channel slices, recording or audio) and there is no channel table; a message becomes a record
// (go-to-channel calls, ahoys, acknowledgements, data headers, broadcasts) with a repeat of the same codeword within
// 10 s (60 s for broadcasts) listed once; the Aloha invitations and markers, sent in nearly every slot, only feed the
// status line.

import type { DigimodeDecoder, DigimodeSink } from '@/worker/decoders/digimode/types';
import { AUDIO_RATE, FmFront, TONES_RATE } from '@/worker/decoders/digimode/tones/front';
import { addressText } from './proto';
import { MptReceiver } from './rx';
import type { MptMessage, MptSyncMode } from './types';

/** Complex rate of the NFM channel. */
export const MPT1327_RATE = TONES_RATE;
/** Discriminator Hz to audio units (any scale works: the detector uses signs). */
const AUDIO_SCALE = 1 / 3000;
/** The same codeword within this time is listed once, s. */
const REPEAT_SEC = 10;
const BROADCAST_REPEAT_SEC = 60;
/** Messages of nearly every slot: status line only. */
const QUIET = /^(ALH|MARK$)/;

const hex16 = (cw: bigint): string => cw.toString(16).toUpperCase().padStart(16, '0');

function messageFields(m: MptMessage, sys: number): Array<[string, string]> {
	const fields: Array<[string, string]> = [
		['Message', m.type],
		['Called', addressText(m.called)],
	];
	if (m.caller.ident >= 0) fields.push(['Caller', addressText(m.caller)]);
	if (m.type === 'GTC') fields.push(['Traffic channel', String(m.channel)]);
	else if (m.channel >= 0) fields.push(['Channel', String(m.channel)]);
	if (m.sys >= 0 || sys >= 0) fields.push(['System', String(m.sys >= 0 ? m.sys : sys)]);
	fields.push(['Detail', m.detail], ['Codeword', hex16(m.cw)]);
	return fields;
}

function messageText(m: MptMessage): string {
	const caller = m.caller.ident >= 0 ? addressText(m.caller) : '-';
	if (m.type === 'GTC')
		return `Call ${caller} → ${addressText(m.called)} · traffic channel ${m.channel} · ${m.detail.endsWith('speech') ? 'speech' : 'data'}`;
	const parties = m.called.ident >= 0 ? ` ${addressText(m.called)}${m.caller.ident >= 0 ? ` ← ${caller}` : ''}` : '';
	return `${m.type}${parties} · ${m.detail}`;
}

/** The control channel of an MPT 1327 trunked network on an NFM channel: calls and other messages as records. */
export class Mpt1327Decoder implements DigimodeDecoder {
	readonly rx = new MptReceiver();
	private readonly front = new FmFront();
	private scaled = new Float32Array(0);
	private readonly seen = new Map<string, number>();
	private calls = 0;
	private lastAloha = '';
	private lastStatus = '';

	constructor(
		private readonly sink: DigimodeSink,
		mode: MptSyncMode = 'auto',
	) {
		this.rx.setSyncMode(mode);
		this.rx.reset();
	}

	process(iq: Float32Array): void {
		const audio = this.front.process(iq);
		if (this.scaled.length < audio.length) this.scaled = new Float32Array(audio.length);
		for (let i = 0; i < audio.length; i++) this.scaled[i] = audio[i] * AUDIO_SCALE;
		this.rx.process(this.scaled.subarray(0, audio.length), AUDIO_RATE);
		for (const e of this.rx.takeEvents()) this.onMessage(e.msg, e.t, e.sys);
		this.updateStatus();
	}

	/** The demodulator and decoder start again (a gap in the input). */
	reset(): void {
		this.front.reset();
		this.rx.reset();
		this.seen.clear();
		this.updateStatus();
	}

	private onMessage(m: MptMessage, t: number, sys: number): void {
		if (QUIET.test(m.type)) {
			this.lastAloha = m.type === 'MARK' ? this.lastAloha : m.type;
			return;
		}
		const key = hex16(m.cw);
		for (const [k, at] of this.seen) if (t - at > BROADCAST_REPEAT_SEC) this.seen.delete(k);
		const last = this.seen.get(key);
		if (last !== undefined && t - last < (m.type === 'BCAST' ? BROADCAST_REPEAT_SEC : REPEAT_SEC)) return;
		this.seen.set(key, t);
		if (m.type === 'GTC') this.calls++;
		this.sink.record({ text: messageText(m), fields: messageFields(m, sys) });
	}

	private updateStatus(): void {
		const s = this.rx.stats;
		let text: string;
		if (!s.good && !s.messages)
			text = s.tolerant ? 'Searching for a control channel (sync word not checked)' : 'Searching for a control channel';
		else {
			const parts = [s.sys >= 0 ? `System ${s.sys}` : 'System unknown', `${s.messages} messages`, `${this.calls} calls`];
			if (this.lastAloha) parts.push(this.lastAloha);
			if (s.tolerant) parts.push('sync word not checked');
			if (!s.locked) parts.push('signal lost');
			text = parts.join(' · ');
		}
		if (text === this.lastStatus) return;
		this.lastStatus = text;
		this.sink.status(text, s.locked);
	}
}
