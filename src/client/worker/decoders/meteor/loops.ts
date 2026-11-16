/*
 * The tracking loops of a Meteor LRPT QPSK/OQPSK demodulator, ported from meteor_demod by dbdexter-dev
 * (https://github.com/dbdexter-dev/meteor_demod, MIT): a polyphase RRC interpolating filter, an AGC,
 * a Costas loop for the carrier and a Mueller & Müller symbol clock. Gains and thresholds are upstream's.
 */

/** Second-order loop gains for damping `damp` and normalised bandwidth `bw`. */
function loopGains(damp: number, bw: number): [number, number] {
	const denom = 1 + 2 * damp * bw + bw * bw;
	return [(4 * damp * bw) / denom, (4 * bw * bw) / denom];
}

const sign = (x: number) => (x < 0 ? -1 : 1);

/** Hamming-windowed RRC coefficient (upstream rrc_coeff, after michael-joost.de/rrcfilter.pdf). */
function rrcCoefficient(stage: number, taps: number, osf: number, alpha: number): number {
	const norm = 2 / 5;
	const order = (taps - 1) / 2;
	if (stage === order) return norm * (1 - alpha + (4 * alpha) / Math.PI);
	const t = Math.abs(order - stage) / osf;
	let coefficient = Math.sin(Math.PI * t * (1 - alpha)) + 4 * alpha * t * Math.cos(Math.PI * t * (1 + alpha));
	const denominator = Math.PI * t * (1 - (4 * alpha * t) ** 2);
	coefficient *= 0.42 - 0.5 * Math.cos((2 * Math.PI * stage) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * stage) / (taps - 1));
	return (coefficient / denominator) * norm;
}

/** Matched filter that also interpolates by `factor`, so the symbol clock can pick any of factor phases. */
export class RrcInterpolator {
	private readonly size: number;
	private readonly coefficients: Float64Array;
	private readonly memI: Float64Array;
	private readonly memQ: Float64Array;
	private index = 0;

	constructor(
		order: number,
		osf: number,
		alpha: number,
		readonly factor: number,
	) {
		this.size = order * 2 + 1;
		this.coefficients = new Float64Array(this.size * factor);
		for (let phase = 0; phase < factor; phase++) {
			for (let i = 0; i < this.size; i++) {
				this.coefficients[phase * this.size + i] = rrcCoefficient(i * factor + phase, this.size * factor, osf * factor, alpha);
			}
		}
		this.memI = new Float64Array(this.size);
		this.memQ = new Float64Array(this.size);
	}

	push(i: number, q: number): void {
		this.memI[this.index] = i;
		this.memQ[this.index] = q;
		this.index = (this.index + 1) % this.size;
	}

	/** Filter output at interpolation phase `phase` (0..factor-1), written to `out`. */
	output(phase: number, out: Float64Array): void {
		let j = (this.factor - phase - 1) * this.size;
		let i = 0;
		let q = 0;
		for (let k = this.index; k < this.size; k++, j++) {
			i += this.memI[k] * this.coefficients[j];
			q += this.memQ[k] * this.coefficients[j];
		}
		for (let k = 0; k < this.index; k++, j++) {
			i += this.memI[k] * this.coefficients[j];
			q += this.memQ[k] * this.coefficients[j];
		}
		out[0] = i;
		out[1] = q;
	}

	reset(): void {
		this.memI.fill(0);
		this.memQ.fill(0);
		this.index = 0;
	}
}

const AGC_TARGET = 190;
const AGC_BIAS_POLE = 0.001;
const AGC_GAIN_POLE = 0.0001;

/** Symbols over which the AGC sets its gain from the mean magnitude before its slow loop takes over. */
const AGC_PRIME_SYMBOLS = 64;

/** Removes DC and scales symbols towards a magnitude of 190. */
export class Agc {
	gain = 0;
	private biasI = 0;
	private biasQ = 0;
	private primeSum = 0;
	private primeCount = 0;

	/** In place on [i, q]. */
	apply(sample: Float64Array): void {
		this.biasI = this.biasI * (1 - AGC_BIAS_POLE) + AGC_BIAS_POLE * sample[0];
		this.biasQ = this.biasQ * (1 - AGC_BIAS_POLE) + AGC_BIAS_POLE * sample[1];
		const i = sample[0] - this.biasI;
		const q = sample[1] - this.biasQ;
		if (this.primeCount < AGC_PRIME_SYMBOLS) {
			// Upstream starts at gain 1 for int16 input; floats need a gain from the signal itself, and a
			// mean (not one sample) so a filter's start-up transient cannot set it.
			this.primeSum += Math.hypot(i, q);
			this.primeCount++;
			this.gain = this.primeSum > 0 ? (AGC_TARGET * this.primeCount) / this.primeSum : 0;
		}
		sample[0] = i * this.gain;
		sample[1] = q * this.gain;
		this.gain = Math.max(0, this.gain + AGC_GAIN_POLE * (AGC_TARGET - Math.hypot(sample[0], sample[1])));
		if (!Number.isFinite(this.gain)) this.reset();
	}

	reset(): void {
		this.gain = this.biasI = this.biasQ = this.primeSum = this.primeCount = 0;
	}
}

const ERR_POLE = 0.001;
const LOCK_BELOW = 85;
const UNLOCK_ABOVE = 105;
const SWEEP_STEP = 0.000001;

/**
 * QPSK Costas loop; frequency and phase are in radians per mixing step (a symbol for QPSK, half a symbol for
 * OQPSK). Sweeps the range while unlocked.
 */
export class CostasLoop {
	freq = 0;
	locked = false;
	error = 1000;
	private phase = 0;
	private sweep = 1;
	private readonly alpha: number;
	private readonly beta: number;

	constructor(
		bandwidth: number,
		private readonly maxFreq: number,
	) {
		[this.alpha, this.beta] = loopGains(Math.SQRT1_2, bandwidth);
	}

	/** Mixes [i, q] in place with the local oscillator, then advances it. */
	mix(sample: Float64Array): void {
		const c = Math.cos(-this.phase);
		const s = Math.sin(-this.phase);
		const [i, q] = [sample[0], sample[1]];
		sample[0] = i * c - q * s;
		sample[1] = i * s + q * c;
		this.advancePhase();
	}

	/** OQPSK half-symbol: mixes and returns only the in-phase part, advancing the oscillator. */
	mixI(sample: Float64Array): number {
		const c = Math.cos(-this.phase);
		const s = Math.sin(-this.phase);
		this.advancePhase();
		return sample[0] * c - sample[1] * s;
	}

	/** OQPSK full symbol: mixes and returns only the quadrature part, advancing the oscillator. */
	mixQ(sample: Float64Array): number {
		const c = Math.cos(-this.phase);
		const s = Math.sin(-this.phase);
		this.advancePhase();
		return sample[0] * s + sample[1] * c;
	}

	update(i: number, q: number): void {
		const error = Math.tanh(i) * q - Math.tanh(q) * i;
		this.phase = (this.phase + this.alpha * error) % (2 * Math.PI);
		this.freq += this.beta * error;
		this.error = this.error * (1 - ERR_POLE) + Math.abs(error) * ERR_POLE;
		if (this.error < LOCK_BELOW) this.locked = true;
		else if (this.error > UNLOCK_ABOVE) this.locked = false;
		if (!this.locked) this.freq += SWEEP_STEP * this.sweep;
		if (this.freq >= this.maxFreq) this.sweep = -1;
		else if (this.freq <= -this.maxFreq) this.sweep = 1;
		this.freq = Math.max(-this.maxFreq, Math.min(this.maxFreq, this.freq));
	}

	/** Starts tracking from an externally estimated frequency (radians per symbol). */
	setFrequency(freq: number): void {
		this.freq = Math.max(-this.maxFreq, Math.min(this.maxFreq, freq));
	}

	private advancePhase(): void {
		this.phase += this.freq;
		if (this.phase >= 2 * Math.PI) this.phase -= 2 * Math.PI;
	}

	reset(): void {
		this.freq = this.phase = 0;
		this.error = 1000;
		this.locked = false;
		this.sweep = 1;
	}
}

/** Mueller & Müller symbol clock over the interpolated sample slots. */
export class SymbolClock {
	private phase = 0;
	private freq: number;
	private previous = 0;
	private dualState: 1 | 2 = 1;
	private readonly maxDeviation: number;
	private readonly alpha: number;
	private readonly beta: number;

	constructor(
		private readonly centerFreq: number,
		bandwidth: number,
	) {
		this.freq = centerFreq;
		this.maxDeviation = centerFreq / 4096;
		[this.alpha, this.beta] = loopGains(1, bandwidth);
	}

	/** Advances one interpolated slot; true when a symbol is due. */
	advance(): boolean {
		this.phase += this.freq;
		return this.phase >= 2 * Math.PI;
	}

	/**
	 * OQPSK: advances one interpolated slot; 1 at the half-symbol point (take I), 2 at the symbol point
	 * (take Q, a symbol is due), else 0. Upstream advance_timeslot_dual.
	 */
	advanceDual(): 0 | 1 | 2 {
		this.phase += this.freq;
		if (this.phase < this.dualState * Math.PI) return 0;
		const slot = this.dualState;
		this.dualState = slot === 1 ? 2 : 1;
		return slot;
	}

	retime(q: number): void {
		const error = sign(this.previous) * q - sign(q) * this.previous;
		this.previous = q;
		this.phase -= 2 * Math.PI + this.alpha * error;
		const delta = Math.max(-this.maxDeviation, Math.min(this.maxDeviation, this.freq - this.centerFreq - this.beta * error));
		this.freq = this.centerFreq + delta;
	}

	reset(): void {
		this.phase = this.previous = 0;
		this.dualState = 1;
		this.freq = this.centerFreq;
	}
}
