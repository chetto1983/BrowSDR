// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/psk/psk_rx.cpp (PskReceiver: feed, the report of every signal
// with its lines of text and callsigns, pskPresets) and core/include/dect2/psk/psk_tel.h (the modulations, pskSummary),
// https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the channel is complex baseband at 24 kHz centred 2 kHz above the dial; shifting it back puts the dial at
// 0 Hz, as OnAir's front end hands the band to its receiver. The band goes to the receiver in blocks of one spectrum
// hop, so signals are found and replayed at the same samples whatever the size of the blocks the worker hands over.
// One record per line of a signal: at a line end, at 80 characters, after 2 s without a character or when the
// signal's DCD drops; the line being received by the latest signal is in the status. Not ported: Auto (OnAir tries
// every modulation on the last 8 s of the band on a thread of its own; here each modulation is its own catalog entry),
// 8PSK125 / 8PSK250, the focus, the waterfall, whole span, Listen and PSK Reporter.

import { TextLines } from '@/worker/decoders/digimode/lines';
import { callsigns } from '@/worker/decoders/digimode/cw/morse';
import type { DigimodeDecoder, DigimodeSink } from '@/worker/decoders/digimode/types';
import { PSK_BASE, type PskChannel } from './channel';
import { PSK_BLOCK, PSK_HI_HZ, PSK_LO_HZ, PskReceiver } from './receiver';
import type { PskMode, PskSignalInfo } from './types';

/** OnAir's modulations (mode numbers of psk_tel.h); 7 and 8, fldigi's 8PSK, are not ported. */
export const PSK_MODES: readonly PskMode[] = [
	{ id: 0, name: 'BPSK31', baud: 31.25, qpsk: false },
	{ id: 1, name: 'BPSK63', baud: 62.5, qpsk: false },
	{ id: 2, name: 'QPSK31', baud: 31.25, qpsk: true },
	{ id: 3, name: 'QPSK63', baud: 62.5, qpsk: true },
	{ id: 4, name: 'BPSK125', baud: 125, qpsk: false },
	{ id: 5, name: 'BPSK250', baud: 250, qpsk: false },
	{ id: 6, name: 'QPSK125', baud: 125, qpsk: true },
];
export const PSK_RATE = PSK_BASE;
/** The channel is centred this far above the dial, 4 kHz wide (0 .. 4000 Hz audio). */
export const PSK_OFFSET_HZ = 2000;
export const PSK_BANDWIDTH = 4000;
const PAUSE_SEC = 2;
/** exp(j 2 pi 2000 n / 24000): the dial back to 0 Hz. */
const SHIFT = Array.from({ length: 12 }, (_, n) => [Math.cos((Math.PI * n) / 6), Math.sin((Math.PI * n) / 6)]);

const signedHz = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)} Hz`;

/** Every signal of one PSK modulation in the upper sideband, dial + 100 Hz .. dial + 3.9 kHz. */
export class PskDecoder implements DigimodeDecoder {
	private rx: PskReceiver;
	private readonly lines = new Map<PskChannel, TextLines>();
	private readonly last = new Map<PskChannel, PskSignalInfo>();
	private readonly block = new Float64Array(2 * PSK_BLOCK);
	private fill = 0;
	private n = 0;
	private lastStatus = '';

	constructor(
		private readonly sink: DigimodeSink,
		readonly mode: PskMode = PSK_MODES[0],
	) {
		this.rx = this.receiver();
	}

	process(iq: Float32Array): void {
		const count = iq.length >> 1;
		for (let i = 0; i < count; i++) {
			const [c, s] = SHIFT[this.n];
			if (++this.n === SHIFT.length) this.n = 0;
			const [re, im] = [iq[2 * i], iq[2 * i + 1]];
			this.block[2 * this.fill] = re * c - im * s;
			this.block[2 * this.fill + 1] = re * s + im * c;
			if (++this.fill < PSK_BLOCK) continue;
			this.fill = 0;
			this.rx.process(this.block);
			for (const lines of this.lines.values()) lines.tick(this.rx.now);
			this.updateStatus();
		}
	}

	/** A gap in the audio: the signals are looked for again (their lines end). */
	reset(): void {
		for (const lines of this.lines.values()) lines.flush();
		this.lines.clear();
		this.last.clear();
		this.rx = this.receiver();
		this.fill = this.n = 0;
		this.lastStatus = '';
	}

	/** The signals followed now. */
	get signals(): PskSignalInfo[] {
		return this.rx.chans.map((c) => c.info());
	}

	private receiver(): PskReceiver {
		return new PskReceiver(this.mode, {
			onChar: (c, ch) => this.onChar(c, ch),
			onDcdLost: (c) => this.lines.get(c)?.flush(),
			onRemoved: (c) => {
				this.lines.get(c)?.flush();
				this.lines.delete(c);
				this.last.delete(c);
			},
		});
	}

	private onChar(c: PskChannel, ch: number): void {
		if (ch < 0) return;
		let lines = this.lines.get(c);
		if (!lines) {
			lines = new TextLines((line) => this.record(c, line), PAUSE_SEC);
			this.lines.set(c, lines);
		}
		this.last.set(c, c.info());
		if (ch === 13 || ch === 10) lines.put('\n', this.rx.now);
		else if (ch === 9) lines.put(' ', this.rx.now);
		else if (ch >= 32 && ch <= 126) lines.put(String.fromCharCode(ch), this.rx.now);
	}

	private record(c: PskChannel, line: string): void {
		const info = this.last.get(c) ?? c.info();
		const hz = Math.round(info.hz);
		const fields: Array<[string, string]> = [
			['Mode', this.mode.name],
			['Audio frequency', `${info.hz.toFixed(1)} Hz`],
			['SNR', `${Math.round(info.snrDb)} dB (in ${this.mode.baud} Hz)`],
			['Quality', `${Math.round(100 * info.quality)} %`],
			['AFC', signedHz(info.afcHz)],
		];
		const calls = callsigns(line);
		if (calls.length) fields.push(['Callsigns', calls.join(' ')]);
		this.sink.record({ text: `${hz} Hz: ${line}`, fields });
	}

	private statusText(): string {
		const chans = this.rx.chans;
		const name = this.mode.name;
		if (!chans.length) return `Looking for ${name} signals ${PSK_LO_HZ} .. ${PSK_HI_HZ} Hz above the dial`;
		const decoding = chans.filter((c) => c.dcd).length;
		let text = `${name}: ${chans.length} signal${chans.length > 1 ? 's' : ''}, ${decoding} decoding`;
		let live: PskChannel | undefined;
		for (const c of chans) if (this.lines.get(c)?.line && (!live || c.lastActive > live.lastActive)) live = c;
		if (live) text += ` · ${Math.round(live.f)} Hz: ${this.lines.get(live)?.tail(80)}`;
		return text;
	}

	private updateStatus(): void {
		const message = this.statusText();
		if (message === this.lastStatus) return;
		this.lastStatus = message;
		this.sink.status(
			message,
			this.rx.chans.some((c) => c.dcd),
		);
	}
}
