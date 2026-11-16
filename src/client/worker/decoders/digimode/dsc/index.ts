// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// VHF DSC receiver for BrowSDR, after OnAir core/src/marine/marine_rx.cpp (the VHF path: one slicer, decoders of
// both polarities), https://github.com/adswill/OnAir; see third_party/onair.

import type { DigimodeDecoder, DigimodeSink } from '@/worker/decoders/digimode/types';
import { dscCallFields, type DscCall } from './call';
import { DscDecoder } from './decoder';
import { VhfSlicer } from './slicers';

/** The same call decoded by both polarities within this time is reported once. */
const DUPLICATE_MS = 3000;

export class DscVhfDecoder implements DigimodeDecoder {
	private readonly slicer = new VhfSlicer();
	private readonly decoders = [new DscDecoder((call) => this.report(call), false), new DscDecoder((call) => this.report(call), true)];
	private last = { text: '', at: 0 };
	private wasLocked = false;

	constructor(private readonly sink: DigimodeSink) {}

	process(iq: Float32Array): void {
		this.slicer.process(iq, (soft) => {
			for (const decoder of this.decoders) decoder.pushBit(soft); // 1300 Hz = Y = 1
		});
		const locked = this.decoders.some((decoder) => decoder.locked);
		if (locked !== this.wasLocked) {
			this.wasLocked = locked;
			this.sink.status(locked ? 'Receiving a call' : 'Listening for calls', locked);
		}
	}

	reset(): void {
		this.slicer.reset();
		for (const decoder of this.decoders) decoder.reset();
		this.last = { text: '', at: 0 };
		this.wasLocked = false;
	}

	private report(call: DscCall): void {
		const now = Date.now();
		if (call.text === this.last.text && now - this.last.at < DUPLICATE_MS) return;
		this.last = { text: call.text, at: now };
		const nature = call.nature >= 0 ? ` - ${call.natureName}` : '';
		const position = call.position ? ` at ${call.position.text}` : '';
		this.sink.record({
			text: `${call.kind}: ${call.from || '?'} → ${call.to || '?'}${nature}${position}${call.eccOk ? '' : ' (check failed)'}`,
			fields: dscCallFields(call),
			damaged: !call.eccOk,
			alert: call.distress || call.category === 110,
		});
	}
}
