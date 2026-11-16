// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// SSTV for BrowSDR: OnAir's decoder (core/src/hfdig/hfdig_sstv.cpp, ported in this folder) fed with 8 kHz audio from
// an FM channel (ISS events on 145.800 MHz) or the upper sideband (HF), https://github.com/adswill/OnAir;
// see third_party/onair.

import type { DigimodeDecoder, DigimodeSink } from '@/worker/decoders/digimode/types';
import { kaiserLowpass, SSTV_AUDIO_RATE } from './phase';
import { SstvReceiver, type SstvRows } from './receiver';

/** Channel of the FM path; three channel samples per audio sample. */
export const SSTV_FM_RATE = 24000;
/** The USB channel is centred this far above the dial, 3.2 kHz wide (100 .. 3300 Hz audio). */
export const SSTV_USB_OFFSET_HZ = 1700;
const AUDIO_TAPS = kaiserLowpass(31, 3300 / SSTV_FM_RATE, 6);

abstract class SstvDecoder implements DigimodeDecoder {
	protected readonly receiver: SstvReceiver;
	protected audio = new Float32Array(0);
	private lastLine = -1;

	constructor(private readonly sink: DigimodeSink) {
		this.receiver = new SstvReceiver((rows) => this.rows(rows));
	}

	abstract process(iq: Float32Array): void;

	reset(): void {
		this.receiver.reset();
		this.lastLine = -1;
	}

	protected feed(count: number): void {
		this.receiver.process(this.audio.subarray(0, count));
		const rx = this.receiver.receiving;
		const line = rx ? rx.extract : -1;
		if (line === this.lastLine) return;
		this.lastLine = line;
		if (rx) this.sink.status(`Receiving ${rx.spec.name}, line ${rx.extract} of ${rx.spec.totalLines}`, true);
		else this.sink.status('Waiting for a VIS header or sync pulses', false);
	}

	protected ensure(count: number): void {
		if (this.audio.length < count) this.audio = new Float32Array(count);
	}

	private rows(rows: SstvRows): void {
		const { spec } = rows;
		this.sink.image?.({
			picture: rows.picture,
			title: `${spec.name} ${spec.width}×${spec.height}`,
			width: spec.width,
			from: rows.from,
			to: rows.to,
			rgb: rows.rgb,
		});
		if (!rows.final) return;
		this.sink.record({
			text: `SSTV ${spec.name} picture ${rows.complete ? 'received' : `cut off after ${rows.to} rows`}`,
			fields: [
				['Mode', spec.name],
				['Size', `${spec.width} × ${spec.height}`],
				['Rows', String(rows.to)],
			],
			damaged: !rows.complete,
		});
	}
}

/** SSTV through an FM receiver: discriminator, low-pass, every third sample. */
export class SstvFmDecoder extends SstvDecoder {
	private prevR = 1;
	private prevI = 0;
	private readonly history = new Float64Array(AUDIO_TAPS.length * 2);
	private head = 0;
	private phase = 0;

	process(iq: Float32Array): void {
		const count = iq.length >> 1;
		this.ensure(Math.ceil(count / 3) + 1);
		let out = 0;
		const taps = AUDIO_TAPS.length;
		for (let n = 0; n < count; n++) {
			const [xr, xi] = [iq[2 * n], iq[2 * n + 1]];
			const disc = Math.atan2(xi * this.prevR - xr * this.prevI, xr * this.prevR + xi * this.prevI);
			this.prevR = xr;
			this.prevI = xi;
			this.history[this.head] = this.history[this.head + taps] = disc;
			this.head = (this.head + 1) % taps;
			if (++this.phase < 3) continue;
			this.phase = 0;
			let y = 0;
			for (let k = 0; k < taps; k++) y += AUDIO_TAPS[k] * this.history[this.head + k];
			this.audio[out++] = y;
		}
		this.feed(out);
	}

	override reset(): void {
		super.reset();
		this.prevR = 1;
		this.prevI = 0;
		this.history.fill(0);
		this.head = this.phase = 0;
	}
}

/** SSTV in the upper sideband: the channel sits 1.7 kHz above the dial; shifting it back gives the audio. */
export class SstvUsbDecoder extends SstvDecoder {
	private n = 0;

	process(iq: Float32Array): void {
		const count = iq.length >> 1;
		this.ensure(count);
		const w = (2 * Math.PI * SSTV_USB_OFFSET_HZ) / SSTV_AUDIO_RATE;
		for (let i = 0; i < count; i++) {
			const a = w * (this.n++ % SSTV_AUDIO_RATE);
			this.audio[i] = iq[2 * i] * Math.cos(a) - iq[2 * i + 1] * Math.sin(a);
		}
		this.feed(count);
	}

	override reset(): void {
		super.reset();
		this.n = 0;
	}
}
