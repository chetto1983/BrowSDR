// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/cw/cw_rx.cpp (CwReceiver: feed, the report of every signal,
// cwTuning and cwBands for the presets) and core/include/dect2/cw/cw_tel.h (cwSummary), https://github.com/adswill/OnAir;
// see third_party/onair.
// Changes: the channel is complex baseband at 24 kHz centred on the dial, as OnAir's front end hands the band to its
// skimmer (no front end of its own); a signal is heard at dial + its offset. The band goes to the skimmer in blocks of
// one spectrum hop, so signals are found at the same samples whatever the size of the blocks the worker hands over.
// Instead of OnAir's text per signal, one record per line of a signal: at 80 characters (cut at a word) or after 3 s
// with the key up (the decoder holds characters back for a better reading, so the pause is not counted from the last
// character); the line being received by the latest signal is in the status. The presets tune where OnAir's band
// buttons do: 7 kHz into each IARU Region 1 CW segment (cwBands). No whole span, focus, sidetone, results file or PSK
// Reporter.

import { TextLines } from '@/worker/decoders/digimode/lines';
import type { DigimodeDecoder, DigimodeSink } from '@/worker/decoders/digimode/types';
import { callsigns } from './morse';
import { CW_BASE, CW_BLOCK, CW_WINDOW_HZ, CwSkimmer, type CwChannel } from './skimmer';
import type { CwSignalInfo, DecTok } from './types';

export const CW_RATE = CW_BASE;
/** The front end passes 8 kHz each side of the dial. */
export const CW_BANDWIDTH = 16000;
const PAUSE_SEC = 3;

const signedHz = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v))} Hz`;

/** Every CW signal within +-7 kHz of the dial. */
export class CwDecoder implements DigimodeDecoder {
	private sk: CwSkimmer;
	private readonly lines = new Map<CwChannel, TextLines>();
	private readonly last = new Map<CwChannel, CwSignalInfo>();
	private readonly block = new Float64Array(2 * CW_BLOCK);
	private fill = 0;
	private lastStatus = '';

	constructor(private readonly sink: DigimodeSink) {
		this.sk = this.skimmer();
	}

	process(iq: Float32Array): void {
		const count = iq.length >> 1;
		for (let i = 0; i < count; i++) {
			this.block[2 * this.fill] = iq[2 * i];
			this.block[2 * this.fill + 1] = iq[2 * i + 1];
			if (++this.fill < CW_BLOCK) continue;
			this.fill = 0;
			this.sk.process(this.block);
			for (const [c, lines] of this.lines) lines.tick(this.sk.now, c.lastActive);
			this.updateStatus();
		}
	}

	/** A gap in the audio: the signals are looked for again (their lines end). */
	reset(): void {
		for (const lines of this.lines.values()) lines.flush();
		this.lines.clear();
		this.last.clear();
		this.sk = this.skimmer();
		this.fill = 0;
		this.lastStatus = '';
	}

	/** The signals followed now. */
	get signals(): CwSignalInfo[] {
		return this.sk.chans.map((c) => c.info());
	}

	private skimmer(): CwSkimmer {
		return new CwSkimmer({
			onText: (c, toks) => this.onText(c, toks),
			onRemoved: (c) => {
				this.lines.get(c)?.flush();
				this.lines.delete(c);
				this.last.delete(c);
			},
		});
	}

	private onText(c: CwChannel, toks: DecTok[]): void {
		let lines = this.lines.get(c);
		if (!lines) {
			lines = new TextLines((line) => this.record(c, line), PAUSE_SEC);
			this.lines.set(c, lines);
		}
		this.last.set(c, c.info());
		for (const t of toks) lines.put(t.text, this.sk.now);
	}

	private record(c: CwChannel, line: string): void {
		const info = this.last.get(c) ?? c.info();
		const fields: Array<[string, string]> = [
			['Offset', `${signedHz(info.hz)} from the dial`],
			['Speed', info.wpm > 0 ? `${Math.round(info.wpm)} WPM` : 'not known yet'],
			['SNR', `${Math.round(info.snrDb)} dB (in 100 Hz)`],
		];
		if (info.farnsworth) fields.push(['Spacing', 'Farnsworth (longer gaps than the speed of the characters)']);
		const calls = callsigns(line);
		if (calls.length) fields.push(['Callsigns', calls.join(' ')]);
		this.sink.record({ text: `${signedHz(info.hz)}: ${line}`, fields });
	}

	private statusText(decoding: number): string {
		const chans = this.sk.chans;
		if (!chans.length) return `Looking for CW signals within ±${CW_WINDOW_HZ / 1000} kHz of the dial`;
		let text = `CW: ${chans.length} signal${chans.length > 1 ? 's' : ''}, ${decoding} decoding`;
		let live: CwChannel | undefined;
		for (const c of chans) if (this.lines.get(c)?.line && (!live || c.lastActive > live.lastActive)) live = c;
		if (live) {
			const wpm = live.fist.wpm;
			text += ` · ${signedHz(live.f)}${wpm > 0 ? ` ${Math.round(wpm)} WPM` : ''}: ${this.lines.get(live)?.tail(80)}`;
		}
		return text;
	}

	private updateStatus(): void {
		const now = this.sk.now;
		const decoding = this.sk.chans.filter((c) => c.fist.locked && now - c.lastActive < 5).length;
		const message = this.statusText(decoding);
		if (message === this.lastStatus) return;
		this.lastStatus = message;
		this.sink.status(message, decoding > 0);
	}
}
