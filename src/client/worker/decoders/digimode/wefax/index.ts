// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Weather fax for BrowSDR, after OnAir core/src/marine/marine_rx.cpp (the fax path: FaxAudio into the FaxDecoder at
// 12 kHz, one message per chart when the decoder stops), https://github.com/adswill/OnAir; see third_party/onair.
//
// The channel is complex baseband at 24 kHz centred 2 kHz above the dial (the USB band 50 .. 3950 Hz); shifting it back
// puts the dial at 0 Hz, as OnAir's FaxAudio takes it. Picture rows go out as they are decoded, except the last few of
// a picture still being received, which a stop or start tone can take back; rows changed in place (the slant of a
// picture joined midway, the roll that puts its margin at the edge) go out again at most every few seconds.

import type { DigimodeDecoder, DigimodeSink } from '@/worker/decoders/digimode/types';
import { FAX_AUDIO_RATE, FAX_INPUT_RATE, FaxAudio } from './audio';
import { FaxDecoder } from './decoder';
import { FAX_BLACK_HZ } from './front';
import type { FaxEnd, FaxStatus } from './types';

export const WEFAX_RATE = FAX_INPUT_RATE;
/** The channel is centred this far above the dial, 3.9 kHz wide (50 .. 3950 Hz audio). */
export const WEFAX_OFFSET_HZ = 2000;
/** Rows a stop or start tone can still remove (OnAir's truncateRows looks at the last six). */
const HOLD_ROWS = 6;
/** Rows changed in place are sent again at most this often, in audio samples. */
const RESEND_SAMPLES = 4 * FAX_AUDIO_RATE;
/** The oscillator that shifts the dial to 0 Hz: 2000 Hz at 24 kHz repeats every 12 samples. */
const SHIFT_PERIOD = WEFAX_RATE / WEFAX_OFFSET_HZ;
const SHIFT_COS = Float64Array.from({ length: SHIFT_PERIOD }, (_, n) => Math.cos((2 * Math.PI * n) / SHIFT_PERIOD));
const SHIFT_SIN = Float64Array.from({ length: SHIFT_PERIOD }, (_, n) => Math.sin((2 * Math.PI * n) / SHIFT_PERIOD));
const END_TEXT: Record<FaxEnd, string> = {
	stop: 'Stop tone',
	start: 'Cut short by a new start tone',
	limit: 'Line limit reached',
	reset: 'Reception interrupted',
};

/** Picture numbers stay unique across decoder runs, so the app never adds rows to an older picture. */
let nextPicture = 1;

const signed = (value: number, digits = 0) => `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(digits)}`;

export class WefaxDecoder implements DigimodeDecoder {
	readonly fax = new FaxDecoder();
	private readonly audio = new FaxAudio();
	private shifted = new Float32Array(0);
	private sound = new Float32Array(0);
	private n = 0;
	private samples = 0;
	private pictureId = -1;
	private number = 0;
	private sent = 0;
	private lastResend = 0;
	private prevState = 0;
	private lastStatus = '';
	/** The phasing's SNR of the picture (the tone detector overwrites the status value at the stop tone). */
	private snrDb = NaN;

	constructor(private readonly sink: DigimodeSink) {
		this.fax.configure(FAX_AUDIO_RATE);
	}

	process(iq: Float32Array): void {
		const count = iq.length >> 1;
		if (this.shifted.length < 2 * count) {
			this.shifted = new Float32Array(2 * count);
			this.sound = new Float32Array(count);
		}
		for (let i = 0; i < count; i++) {
			const [c, s] = [SHIFT_COS[this.n], SHIFT_SIN[this.n]];
			if (++this.n === SHIFT_PERIOD) this.n = 0;
			const [xr, xi] = [iq[2 * i], iq[2 * i + 1]];
			this.shifted[2 * i] = xr * c - xi * s;
			this.shifted[2 * i + 1] = xr * s + xi * c;
		}
		const audio = this.sound.subarray(0, this.audio.process(this.shifted.subarray(0, 2 * count), this.sound));
		this.fax.push(audio);
		this.samples += audio.length;
		this.report();
	}

	reset(): void {
		if (this.prevState === 2) this.finish('reset');
		this.fax.reset();
		this.audio.reset();
		this.n = 0;
		this.prevState = 0;
		this.lastStatus = '';
		this.report();
	}

	private report(): void {
		const st = this.fax.st;
		const picture = this.fax.picture;
		if (picture.id !== this.pictureId) {
			this.pictureId = picture.id;
			this.number = nextPicture++;
			this.sent = 0;
			this.snrDb = st.phasingLines > 0 ? st.snrDb : NaN;
		}
		if (this.prevState === 2 && st.state !== 2) {
			const reason = st.state === 1 ? 'start' : st.lines >= this.fax.lineLimit ? 'limit' : 'stop';
			this.finish(reason);
		} else this.sendRows(st.state === 2 ? picture.rows - HOLD_ROWS : picture.rows, false);
		this.prevState = st.state;
		this.updateStatus(st);
	}

	/** The chart ended: its last rows, then one record. */
	private finish(reason: FaxEnd): void {
		const st = this.fax.status();
		this.sendRows(this.fax.picture.rows, true);
		if (st.lines <= 0) return;
		const mistune = st.blackHz - FAX_BLACK_HZ;
		const snr: Array<[string, string]> = Number.isNaN(this.snrDb) ? [] : [['SNR (phasing)', `${this.snrDb.toFixed(1)} dB`]];
		this.sink.record({
			text: `Weather fax chart, ${st.lines} lines (${st.lpm} lpm, IOC ${st.ioc})${reason === 'stop' ? '' : ` · ${END_TEXT[reason].toLowerCase()}`}`,
			fields: [
				['Lines', String(st.lines)],
				['Size', `${st.width} × ${st.lines}`],
				['Line rate', `${st.lpm} lpm`],
				['IOC', String(st.ioc)],
				['Start', st.phasingLines > 0 ? `Phasing, ${st.phasingLines} lines` : 'Joined midway (line rate from the picture)'],
				['Slant', `${signed(st.slantPpm, 1)} ppm`],
				['Tuning', `${signed(mistune)} Hz (black at ${st.blackHz.toFixed(0)} Hz)`],
				...snr,
				['End', END_TEXT[reason]],
			],
			damaged: reason === 'start' || reason === 'reset',
		});
	}

	/** New rows up to `upTo`, and the rows changed in place when it is time (or `flush`). */
	private sendRows(upTo: number, flush: boolean): void {
		const picture = this.fax.picture;
		const w = picture.width;
		if (!w || !this.sink.image) return;
		let from = this.sent;
		if (picture.dirtyFrom >= this.sent) picture.dirtyFrom = Infinity;
		else if (flush || this.samples - this.lastResend >= RESEND_SAMPLES) {
			from = picture.dirtyFrom;
			picture.dirtyFrom = Infinity;
			this.lastResend = this.samples;
		}
		const to = Math.min(picture.rows, Math.max(upTo, this.sent));
		if (to <= from) return;
		const rgb = new Uint8Array((to - from) * w * 3);
		for (let r = from, o = 0; r < to; r++) {
			const row = picture.row(r);
			for (let x = 0; x < w; x++, o += 3) rgb[o] = rgb[o + 1] = rgb[o + 2] = row[x];
		}
		const st = this.fax.st;
		this.sink.image({ picture: this.number, title: `Weather fax ${st.lpm} lpm, IOC ${st.ioc}`, width: w, from, to, rgb });
		this.sent = Math.max(this.sent, to);
	}

	private updateStatus(st: FaxStatus): void {
		let message = 'Waiting for a start tone or phasing lines';
		const mistune = `tuning ${signed(st.blackHz - FAX_BLACK_HZ)} Hz`;
		if (st.state === 1 && st.phasingLines > 0) message = `Phasing, ${st.lpm} lpm, IOC ${st.ioc}, ${mistune}`;
		else if (st.state === 1) message = `Start tone heard (IOC ${st.ioc}), waiting for phasing`;
		else if (st.state === 2)
			message = `Receiving line ${st.lines}, ${st.lpm} lpm, IOC ${st.ioc}, ${mistune}, slant ${signed(st.slantPpm)} ppm`;
		else if (st.state === 3) message = `Chart ended after ${st.lines} lines; waiting for the next one`;
		if (message === this.lastStatus) return;
		this.lastStatus = message;
		this.sink.status(message, st.state === 2 || (st.state === 1 && st.phasingLines > 0));
	}
}
