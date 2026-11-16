// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/wmbus/wmbus_live.cpp (WmbusLiveReceiver: the 868 MHz channels,
// sample loop and frame bookkeeping), https://github.com/adswill/OnAir; see third_party/onair. Changes: the T1 / C1
// demodulator (868.95 MHz) and the S1 demodulator (868.3 MHz) run side by side on the one VFO channel in place of a
// channel per frequency of the capture; one record per telegram with a status line in place of the device table and
// telemetry; no R2 or 169 MHz channels, no decryption with user keys, no mode or manufacturer filters.

import type { DigimodeDecoder, DigimodeSink } from '@/worker/decoders/digimode/types';
import { parseFrame, phyName } from './proto';
import { WmbusChannel, WmbusFront } from './receiver';
import { telegramRecord } from './report';
import type { WmbusTelegram } from './types';

/** OnAir's working rate of the 100 and 32.768 kchip/s channels. */
export const WMBUS_RATE = 400000;
/** OnAir's channel filter of S and T / C: 84 kHz (±50 kHz deviation and a 17 kHz carrier error still pass). */
const CHANNEL_LPF_HZ = 84000;

export class WmbusDecoder implements DigimodeDecoder {
	private readonly front = new WmbusFront(WMBUS_RATE, CHANNEL_LPF_HZ);
	private readonly channels: WmbusChannel[];
	private telegrams = 0;
	private failed = 0;
	private last = '';
	private wasLocked = false;

	constructor(private readonly sink: DigimodeSink) {
		const onFrame = (telegram: WmbusTelegram) => this.report(telegram);
		this.channels = [new WmbusChannel(['T1', 'C1A'], WMBUS_RATE, onFrame), new WmbusChannel(['S1'], WMBUS_RATE, onFrame)];
	}

	process(iq: Float32Array): void {
		const channels = this.channels;
		const count = iq.length >> 1;
		for (let n = 0; n < count; n++) {
			let re = iq[2 * n];
			let im = iq[2 * n + 1];
			if (!Number.isFinite(re) || !Number.isFinite(im)) re = im = 0;
			const d = this.front.step(re, im);
			const p = this.front.power;
			for (let c = 0; c < channels.length; c++) channels[c].sample(d, p);
		}
		const locked = channels.some((channel) => channel.nColl > 0);
		if (locked !== this.wasLocked) {
			this.wasLocked = locked;
			this.sink.status(this.statusText(locked), locked);
		}
	}

	reset(): void {
		this.front.reset();
		for (const channel of this.channels) channel.reset();
		this.wasLocked = false;
	}

	private statusText(locked: boolean): string {
		if (locked) return 'Receiving a telegram';
		if (!this.telegrams && !this.failed) return 'Listening for T1 / C1 and S1 telegrams';
		return `${this.telegrams} telegram(s)${this.failed ? `, ${this.failed} failed CRC` : ''}, last ${this.last}`;
	}

	private report(telegram: WmbusTelegram): void {
		const frame = parseFrame(telegram.bytes, telegram.bytes.length, telegram.formatB);
		if (frame.ok) {
			this.telegrams++;
			this.last = `${phyName(telegram.phy)} ${frame.mfr} ${frame.id}`;
		} else this.failed++;
		this.sink.record(telegramRecord(telegram, frame));
		this.wasLocked = this.channels.some((channel) => channel.nColl > 0);
		this.sink.status(this.statusText(this.wasLocked), this.wasLocked);
	}
}
