/** Synthetic Meteor LRPT downlinks: QPSK at 72 ksym/s with a root-raised-cosine pulse (alpha 0.6). */

const SYMBOL_RATE = 72000;
const ALPHA = 0.6;
const SPAN = 8; // pulse length each side, in symbols

/** Root-raised-cosine impulse response at t (in symbol periods), unit energy per symbol. */
function rrc(t) {
	if (Math.abs(t) < 1e-9) return 1 - ALPHA + (4 * ALPHA) / Math.PI;
	if (Math.abs(Math.abs(t) - 1 / (4 * ALPHA)) < 1e-9) {
		return (
			(ALPHA / Math.SQRT2) * ((1 + 2 / Math.PI) * Math.sin(Math.PI / (4 * ALPHA)) + (1 - 2 / Math.PI) * Math.cos(Math.PI / (4 * ALPHA)))
		);
	}
	const numerator = Math.sin(Math.PI * t * (1 - ALPHA)) + 4 * ALPHA * t * Math.cos(Math.PI * t * (1 + ALPHA));
	return numerator / (Math.PI * t * (1 - (4 * ALPHA * t) ** 2));
}

/** Deterministic PRNG so failures reproduce. */
export function prng(seed) {
	let state = seed >>> 0 || 1;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 2 ** 32;
	};
}

/**
 * `symbols` random QPSK symbols as interleaved float I/Q at `rate`. `bits` holds two bits per symbol
 * (I sign, then Q sign; 1 means negative). Offsets: carrier `offsetHz` plus `dopplerHzPerS` drift,
 * symbol timing shifted by `timingOffset` symbol periods, white noise for `snrDb` (per sample).
 */
export function qpskSignal(symbols, { rate = 144000, offsetHz = 0, dopplerHzPerS = 0, timingOffset = 0, snrDb = 20, seed = 1 } = {}) {
	const random = prng(seed);
	const bits = new Uint8Array(symbols * 2);
	for (let i = 0; i < bits.length; i++) bits[i] = random() < 0.5 ? 1 : 0;
	const perSymbol = rate / SYMBOL_RATE;
	const count = Math.floor(symbols * perSymbol);
	const iq = new Float32Array(count * 2);
	const noise = Math.sqrt(10 ** (-snrDb / 10) / 2);
	const gaussian = () => Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random());
	let phase = 0;
	for (let n = 0; n < count; n++) {
		const t = n / perSymbol - timingOffset; // in symbols
		let i = 0;
		let q = 0;
		for (let k = Math.max(0, Math.ceil(t - SPAN)); k <= Math.min(symbols - 1, Math.floor(t + SPAN)); k++) {
			const h = rrc(t - k);
			i += h * (bits[2 * k] ? -1 : 1);
			q += h * (bits[2 * k + 1] ? -1 : 1);
		}
		i *= Math.SQRT1_2;
		q *= Math.SQRT1_2;
		const seconds = n / rate;
		const c = Math.cos(phase);
		const s = Math.sin(phase);
		iq[2 * n] = 0.3 * (i * c - q * s) + 0.3 * noise * gaussian();
		iq[2 * n + 1] = 0.3 * (i * s + q * c) + 0.3 * noise * gaussian();
		phase += (2 * Math.PI * (offsetHz + dopplerHzPerS * seconds)) / rate;
	}
	return { iq, bits };
}

/** Band-limited noise only, same scale as qpskSignal. */
export function noiseOnly(samples, seed = 9) {
	const random = prng(seed);
	const gaussian = () => Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random());
	return Float32Array.from({ length: samples * 2 }, () => 0.3 * gaussian());
}

/**
 * Lowest bit error rate of hard decisions from int8 soft symbols (I, Q pairs) against `bits`, over the
 * four QPSK phase rotations and any alignment within `maxLag` symbols, using `count` symbols.
 */
export function bestBitErrorRate(soft, bits, count, maxLag = 64) {
	const symbolsOut = soft.length / 2;
	let best = 1;
	for (let lag = -maxLag; lag <= maxLag; lag++) {
		for (let rotation = 0; rotation < 4; rotation++) {
			let errors = 0;
			let total = 0;
			const start = Math.max(0, symbolsOut - count);
			for (let s = start; s < symbolsOut; s++) {
				const k = s + lag;
				if (k < 0 || 2 * k + 1 >= bits.length) continue;
				let [i, q] = [soft[2 * s], soft[2 * s + 1]];
				for (let r = 0; r < rotation; r++) [i, q] = [-q, i];
				errors += (i < 0 ? 1 : 0) !== bits[2 * k] ? 1 : 0;
				errors += (q < 0 ? 1 : 0) !== bits[2 * k + 1] ? 1 : 0;
				total += 2;
			}
			if (total > count) best = Math.min(best, errors / total);
		}
	}
	return best;
}
