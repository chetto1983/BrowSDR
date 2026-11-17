// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Based on OnAir core/src/orbcomm/orbcomm_rx.cpp; BrowSDR uses a streaming first-difference carrier estimator.
import { ORBCOMM_BAUD } from './protocol';

const RATE = 48000;
const SAMPLES_PER_SYMBOL = RATE / ORBCOMM_BAUD;
const ROLL_OFF = 0.4;
const FILTER_RADIUS = 4 * SAMPLES_PER_SYMBOL;
const TAPS = 2 * FILTER_RADIUS + 1;
const HISTORY = 256;

function rrc(t: number): number {
	const a = ROLL_OFF;
	if (Math.abs(t) < 1e-9) return 1 - a + (4 * a) / Math.PI;
	if (Math.abs(Math.abs(t) - 1 / (4 * a)) < 1e-9)
		return (a / Math.SQRT2) * ((1 + 2 / Math.PI) * Math.sin(Math.PI / (4 * a)) + (1 - 2 / Math.PI) * Math.cos(Math.PI / (4 * a)));
	return (Math.sin(Math.PI * t * (1 - a)) + 4 * a * t * Math.cos(Math.PI * t * (1 + a))) / (Math.PI * t * (1 - 16 * a * a * t * t));
}

const TAPS_RRC = Float32Array.from({ length: TAPS }, (_, i) => rrc((i - FILTER_RADIUS) / SAMPLES_PER_SYMBOL));

/** Matched-filtered SDPSK with Gardner symbol timing and a differential carrier loop. */
export class OrbcommDemodulator {
	private readonly firRe = new Float32Array(TAPS);
	private readonly firIm = new Float32Array(TAPS);
	private readonly historyRe = new Float32Array(HISTORY);
	private readonly historyIm = new Float32Array(HISTORY);
	private firPos = 0;
	private samples = 0;
	private nextSymbol = SAMPLES_PER_SYMBOL;
	private symbolPeriodError = 0;
	private previousRe = 0;
	private previousIm = 0;
	private havePrevious = false;
	private symbolPower = 1;
	private carrierRe = 0;
	private carrierIm = 0;
	private carrierSamples = 0;
	private carrierPhase = 0;
	private rawPreviousRe = 0;
	private rawPreviousIm = 0;
	private rawCorrelationRe = 0;
	private rawCorrelationIm = 0;
	private mixPhase = 0;

	constructor(private readonly onBit: (bit: number) => void) {}

	reset(): void {
		this.firRe.fill(0);
		this.firIm.fill(0);
		this.historyRe.fill(0);
		this.historyIm.fill(0);
		this.firPos = 0;
		this.samples = 0;
		this.nextSymbol = SAMPLES_PER_SYMBOL;
		this.symbolPeriodError = 0;
		this.previousRe = 0;
		this.previousIm = 0;
		this.havePrevious = false;
		this.symbolPower = 1;
		this.carrierRe = 0;
		this.carrierIm = 0;
		this.carrierSamples = 0;
		this.carrierPhase = 0;
		this.rawPreviousRe = 0;
		this.rawPreviousIm = 0;
		this.rawCorrelationRe = 0;
		this.rawCorrelationIm = 0;
		this.mixPhase = 0;
	}

	process(iq: Float32Array): void {
		for (let offset = 0; offset + 1 < iq.length; offset += 2) {
			const rawRe = iq[offset];
			const rawIm = iq[offset + 1];
			if (this.samples) {
				const correlationRe = rawRe * this.rawPreviousRe + rawIm * this.rawPreviousIm;
				const correlationIm = rawIm * this.rawPreviousRe - rawRe * this.rawPreviousIm;
				this.rawCorrelationRe = 0.999 * this.rawCorrelationRe + 0.001 * correlationRe;
				this.rawCorrelationIm = 0.999 * this.rawCorrelationIm + 0.001 * correlationIm;
			}
			this.rawPreviousRe = rawRe;
			this.rawPreviousIm = rawIm;
			this.mixPhase += Math.atan2(this.rawCorrelationIm, this.rawCorrelationRe);
			if (this.mixPhase > Math.PI || this.mixPhase < -Math.PI) this.mixPhase %= 2 * Math.PI;
			const cosine = Math.cos(this.mixPhase);
			const sine = Math.sin(this.mixPhase);
			this.firRe[this.firPos] = rawRe * cosine + rawIm * sine;
			this.firIm[this.firPos] = rawIm * cosine - rawRe * sine;
			let re = 0;
			let im = 0;
			let cursor = this.firPos;
			for (let i = 0; i < TAPS; i++) {
				re += TAPS_RRC[i] * this.firRe[cursor];
				im += TAPS_RRC[i] * this.firIm[cursor];
				if (--cursor < 0) cursor = TAPS - 1;
			}
			if (++this.firPos === TAPS) this.firPos = 0;
			const index = this.samples % HISTORY;
			this.historyRe[index] = re;
			this.historyIm[index] = im;
			this.samples++;
			while (this.nextSymbol <= this.samples - 2) this.symbol();
		}
	}

	private interpolate(t: number): [number, number] {
		const index = Math.floor(t);
		const fraction = t - index;
		const a = ((index % HISTORY) + HISTORY) % HISTORY;
		const b = (a + 1) % HISTORY;
		return [
			this.historyRe[a] + fraction * (this.historyRe[b] - this.historyRe[a]),
			this.historyIm[a] + fraction * (this.historyIm[b] - this.historyIm[a]),
		];
	}

	private symbol(): void {
		const t = this.nextSymbol;
		const [re, im] = this.interpolate(t);
		const [midRe, midIm] = this.interpolate(t - SAMPLES_PER_SYMBOL / 2);
		this.symbolPower = 0.99 * this.symbolPower + 0.01 * (re * re + im * im);
		if (!this.havePrevious) {
			this.previousRe = re;
			this.previousIm = im;
			this.havePrevious = true;
			this.nextSymbol += SAMPLES_PER_SYMBOL;
			return;
		}
		const error = Math.max(
			-1,
			Math.min(1, ((re - this.previousRe) * midRe + (im - this.previousIm) * midIm) / Math.max(1e-9, this.symbolPower)),
		);
		this.symbolPeriodError = Math.max(-0.1, Math.min(0.1, this.symbolPeriodError - 0.002 * error));
		this.nextSymbol += SAMPLES_PER_SYMBOL + this.symbolPeriodError - 0.2 * error;
		if (this.nextSymbol <= t) this.nextSymbol = t + SAMPLES_PER_SYMBOL;

		const diffRe = re * this.previousRe + im * this.previousIm;
		const diffIm = im * this.previousRe - re * this.previousIm;
		this.previousRe = re;
		this.previousIm = im;
		const magnitude = Math.hypot(diffRe, diffIm);
		if (magnitude < 1e-9) return;
		const unitRe = diffRe / magnitude;
		const unitIm = diffIm / magnitude;
		const estimateRe = unitIm * unitIm - unitRe * unitRe;
		const estimateIm = -2 * unitRe * unitIm;
		this.carrierRe = 0.98 * this.carrierRe + 0.02 * estimateRe;
		this.carrierIm = 0.98 * this.carrierIm + 0.02 * estimateIm;
		if (++this.carrierSamples < 80) return;
		let phase = 0.5 * Math.atan2(this.carrierIm, this.carrierRe);
		if (this.carrierSamples > 80) {
			while (phase - this.carrierPhase > Math.PI / 2) phase -= Math.PI;
			while (phase - this.carrierPhase < -Math.PI / 2) phase += Math.PI;
		}
		this.carrierPhase = phase;
		this.onBit(unitIm * Math.cos(phase) - unitRe * Math.sin(phase) >= 0 ? 1 : 0);
	}
}
