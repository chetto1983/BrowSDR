import { CarrierAcquisition } from './acquire';
import { Agc, CostasLoop, RrcInterpolator, SymbolClock } from './loops';
import type { MeteorModulation } from './types';

export const METEOR_SYMBOL_RATE = 72000;
/** Two samples per symbol, the rate of the channel the DDC hands over. */
export const METEOR_CHANNEL_RATE = 144000;

const RRC_ORDER = 32;
const RRC_ALPHA = 0.6;
const INTERPOLATION = 5;
const SYMBOL_LOOP_BW = 0.00005;
const CARRIER_LOOP_BW_HZ = 1;
/**
 * Doppler (±3.5 kHz at 137.9 MHz) plus the receiver's own error: the 2026-11-16 M2-4 pass sat at -3.7 kHz
 * at closest approach and ran down to -4.9 kHz, out of the old ±4 kHz window.
 */
const MAX_OFFSET_HZ = 10000;
/** Unlocked this long after having locked: look for the carrier again (Doppler jump after a gap). */
const REACQUIRE_SYMBOLS = METEOR_SYMBOL_RATE;
const TWO_PI = 2 * Math.PI;
const WARMUP_SAMPLES = RRC_ORDER * 2 + 1;

/**
 * Meteor-M LRPT 72k demodulator, QPSK or OQPSK (meteor_demod's two modes): complex baseband at 144 kS/s in,
 * int8 soft symbols out (I then Q per symbol, as meteor_demod writes its .s files and meteor_decode reads
 * them). OQPSK is the default: Meteor-M2 3 and 4 send it, and QPSK tracking cannot recover it.
 */
export class MeteorDemodulator {
	private readonly filter = new RrcInterpolator(RRC_ORDER, METEOR_CHANNEL_RATE / METEOR_SYMBOL_RATE, RRC_ALPHA, INTERPOLATION);
	private readonly agc = new Agc();
	private readonly carrier: CostasLoop;
	private readonly clock = new SymbolClock(
		TWO_PI * (METEOR_SYMBOL_RATE / (METEOR_CHANNEL_RATE * INTERPOLATION)),
		SYMBOL_LOOP_BW / INTERPOLATION,
	);
	private readonly acquisition = new CarrierAcquisition(METEOR_CHANNEL_RATE, MAX_OFFSET_HZ);
	/** Carrier mixing steps per symbol: OQPSK mixes at the half-symbol point too. */
	private readonly steps: number;
	private readonly sample = new Float64Array(2);
	/** OQPSK: the in-phase value taken half a symbol before the current one. */
	private inphase = 0;
	private acquired = false;
	/** Input samples still needed before the matched filter holds real signal (it starts out zeroed). */
	private warmup = WARMUP_SAMPLES;
	private unlockedSymbols = 0;
	private out = new Int8Array(0);

	constructor(
		private readonly onSymbols: (soft: Int8Array) => void,
		readonly modulation: MeteorModulation = 'oqpsk',
	) {
		this.steps = modulation === 'oqpsk' ? 2 : 1;
		// Upstream: loop bandwidth 2*pi*PLL_BW/(multiplier*symrate) with multiplier 2 for QPSK, 1 for OQPSK,
		// and the frequency range halved for OQPSK because the oscillator steps twice per symbol.
		this.carrier = new CostasLoop(
			(TWO_PI * CARRIER_LOOP_BW_HZ) / ((3 - this.steps) * METEOR_SYMBOL_RATE),
			(TWO_PI * MAX_OFFSET_HZ) / (this.steps * METEOR_SYMBOL_RATE),
		);
	}

	get locked(): boolean {
		return this.carrier.locked;
	}

	get freqOffsetHz(): number {
		return (this.carrier.freq * this.steps * METEOR_SYMBOL_RATE) / TWO_PI;
	}

	/**
	 * 0 for noise, towards 1 for a clean constellation, from the Costas loop's mean error: about 105 on
	 * noise (the mean gap between |I| and |Q|), about 10 on a strong signal; lock is declared below 85.
	 */
	get quality(): number {
		return Math.max(0, Math.min(1, (105 - this.carrier.error) / 90));
	}

	/** Interleaved I/Q at METEOR_CHANNEL_RATE; emits this block's soft symbols, if any. */
	process(iq: Float32Array): void {
		const capacity = Math.ceil(iq.length / 2 / ((METEOR_CHANNEL_RATE / METEOR_SYMBOL_RATE) * 0.99)) * 2 + 4;
		if (this.out.length < capacity) this.out = new Int8Array(capacity);
		let count = 0;
		for (let n = 0; n + 1 < iq.length; n += 2) {
			if (!this.acquired) this.acquire(iq[n], iq[n + 1]);
			this.filter.push(iq[n], iq[n + 1]);
			if (this.warmup > 0) {
				this.warmup--;
				continue;
			}
			for (let phase = 0; phase < INTERPOLATION; phase++) {
				if (!(this.steps === 2 ? this.oqpskSlot(phase) : this.qpskSlot(phase))) continue;
				this.out[count++] = Math.max(-127, Math.min(127, Math.round(this.sample[0] / 2)));
				this.out[count++] = Math.max(-127, Math.min(127, Math.round(this.sample[1] / 2)));
			}
		}
		if (count) this.onSymbols(this.out.subarray(0, count));
	}

	/** Forget all loop state, as after a gap in the input. */
	reset(): void {
		this.filter.reset();
		this.agc.reset();
		this.carrier.reset();
		this.clock.reset();
		this.acquisition.reset();
		this.acquired = false;
		this.unlockedSymbols = 0;
		this.inphase = 0;
		this.warmup = WARMUP_SAMPLES;
	}

	private acquire(i: number, q: number): void {
		const offsetHz = this.acquisition.push(i, q);
		if (offsetHz === null) return;
		this.carrier.setFrequency((TWO_PI * offsetHz) / (this.steps * METEOR_SYMBOL_RATE));
		this.acquired = true;
		this.unlockedSymbols = 0;
	}

	/** QPSK: true when a symbol is due in this slot; it is then in `sample`. */
	private qpskSlot(phase: number): boolean {
		if (!this.clock.advance()) return false;
		this.filter.output(phase, this.sample);
		this.agc.apply(this.sample);
		this.carrier.mix(this.sample);
		this.track();
		return true;
	}

	/** OQPSK (upstream demod_oqpsk): I at the half-symbol point, Q at the symbol point; true on a symbol. */
	private oqpskSlot(phase: number): boolean {
		const slot = this.clock.advanceDual();
		if (slot === 0) return false;
		this.filter.output(phase, this.sample);
		this.agc.apply(this.sample);
		if (slot === 1) {
			this.inphase = this.carrier.mixI(this.sample);
			return false;
		}
		this.sample[1] = this.carrier.mixQ(this.sample);
		this.sample[0] = this.inphase;
		this.track();
		return true;
	}

	/** Updates the symbol clock and carrier from the symbol in `sample`, and restarts acquisition if lost. */
	private track(): void {
		this.clock.retime(this.sample[1]);
		this.carrier.update(this.sample[0], this.sample[1]);
		if (this.carrier.locked) this.unlockedSymbols = 0;
		else if (this.acquired && ++this.unlockedSymbols > REACQUIRE_SYMBOLS) {
			this.acquired = false;
			this.acquisition.reset();
		}
	}
}
