// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/tones/tones_rx.cpp (the audio history of TonesReceiver::Impl:
// the 8 kHz and 1 kHz rings, the signal clock, the audio level, the DTMF hold-off), https://github.com/adswill/OnAir;
// see third_party/onair. Changes: the clock keeps running across reset(), so events stay in order.

import type { ToneEvent, ToneKind } from './types';

export const RATE = 8000;
/** Audio units are Hz of deviation; 5 kHz is "0 dB". */
export const FULL = 5000;
const RING = 4096;
const RING_1K = 2048;

/** What every detector reads: the newest audio at 8 kHz and, low-passed to 300 Hz, at 1 kHz. */
export class ToneAudio {
	readonly ring = new Float32Array(RING);
	readonly ring1k = new Float32Array(RING_1K);
	/** Samples at 8 kHz since reset(). */
	n8 = 0;
	/** Samples at 1 kHz since reset(). */
	n1k = 0;
	/** Audio rms, 0 dB = 5 kHz deviation. */
	audioDb = -200;
	/** Signal seconds: a DTMF key was heard lately (the other voice band detectors stand aside). */
	dtmfOtherUntil = -1e9;
	private t0 = 0;

	/** Signal seconds. */
	now(): number {
		return this.t0 + this.n8 / RATE;
	}

	reset(): void {
		this.t0 = this.now();
		this.ring.fill(0);
		this.ring1k.fill(0);
		this.n8 = this.n1k = 0;
		this.audioDb = -200;
		this.dtmfOtherUntil = -1e9;
	}

	/** The newest n samples of the 8 kHz ring. */
	tail(n: number, dst: Float64Array): void {
		const mask = RING - 1;
		for (let i = 0; i < n; i++) dst[i] = this.ring[(this.n8 - n + i) & mask];
	}

	/** The newest n samples of the 1 kHz ring. */
	tail1k(n: number, dst: Float64Array): void {
		const mask = RING_1K - 1;
		for (let i = 0; i < n; i++) dst[i] = this.ring1k[(this.n1k - n + i) & mask];
	}
}

/** A new event as the detectors make it: begun now, nothing measured yet. */
export function newEvent(
	audio: ToneAudio,
	kind: ToneKind,
	fields: Pick<ToneEvent, 'system' | 'text' | 'label' | 'detail' | 'levelDb'>,
): ToneEvent {
	return { kind, ...fields, timeSec: audio.now(), durSec: 0, active: true };
}
