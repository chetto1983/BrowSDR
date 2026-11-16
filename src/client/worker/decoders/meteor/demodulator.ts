import { CarrierAcquisition } from './acquire';
import { Agc, CostasLoop, RrcInterpolator, SymbolClock } from './loops';

export const METEOR_SYMBOL_RATE = 72000;
/** Two samples per symbol, the rate of the channel the DDC hands over. */
export const METEOR_CHANNEL_RATE = 144000;

const RRC_ORDER = 32;
const RRC_ALPHA = 0.6;
const INTERPOLATION = 5;
const SYMBOL_LOOP_BW = 0.00005;
const CARRIER_LOOP_BW_HZ = 1;
/** Doppler (±3.5 kHz at 137.9 MHz) plus the dongle's own error. */
const MAX_OFFSET_HZ = 4000;
/** Unlocked this long after having locked: look for the carrier again (Doppler jump after a gap). */
const REACQUIRE_SYMBOLS = METEOR_SYMBOL_RATE;
const TWO_PI = 2 * Math.PI;
const WARMUP_SAMPLES = RRC_ORDER * 2 + 1;

/**
 * Meteor-M LRPT 72k QPSK demodulator: complex baseband at 144 kS/s in, int8 soft symbols out (I then Q
 * per symbol, as meteor_demod writes its .s files and meteor_decode reads them).
 */
export class MeteorDemodulator {
	private readonly filter = new RrcInterpolator(RRC_ORDER, METEOR_CHANNEL_RATE / METEOR_SYMBOL_RATE, RRC_ALPHA, INTERPOLATION);
	private readonly agc = new Agc();
	private readonly carrier = new CostasLoop(
		(TWO_PI * CARRIER_LOOP_BW_HZ) / (2 * METEOR_SYMBOL_RATE),
		(TWO_PI * MAX_OFFSET_HZ) / METEOR_SYMBOL_RATE,
	);
	private readonly clock = new SymbolClock(
		TWO_PI * (METEOR_SYMBOL_RATE / (METEOR_CHANNEL_RATE * INTERPOLATION)),
		SYMBOL_LOOP_BW / INTERPOLATION,
	);
	private readonly acquisition = new CarrierAcquisition(METEOR_CHANNEL_RATE, MAX_OFFSET_HZ);
	private readonly sample = new Float64Array(2);
	private acquired = false;
	/** Input samples still needed before the matched filter holds real signal (it starts out zeroed). */
	private warmup = WARMUP_SAMPLES;
	private unlockedSymbols = 0;
	private out = new Int8Array(0);

	constructor(private readonly onSymbols: (soft: Int8Array) => void) {}

	get locked(): boolean {
		return this.carrier.locked;
	}

	get freqOffsetHz(): number {
		return (this.carrier.freq * METEOR_SYMBOL_RATE) / TWO_PI;
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
				if (!this.clock.advance()) continue;
				this.symbol(phase);
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
		this.warmup = WARMUP_SAMPLES;
	}

	private acquire(i: number, q: number): void {
		const offsetHz = this.acquisition.push(i, q);
		if (offsetHz === null) return;
		this.carrier.setFrequency((TWO_PI * offsetHz) / METEOR_SYMBOL_RATE);
		this.acquired = true;
		this.unlockedSymbols = 0;
	}

	private symbol(phase: number): void {
		this.filter.output(phase, this.sample);
		this.agc.apply(this.sample);
		this.carrier.mix(this.sample);
		this.clock.retime(this.sample[1]);
		this.carrier.update(this.sample[0], this.sample[1]);
		if (this.carrier.locked) this.unlockedSymbols = 0;
		else if (this.acquired && ++this.unlockedSymbols > REACQUIRE_SYMBOLS) {
			this.acquired = false;
			this.acquisition.reset();
		}
	}
}
