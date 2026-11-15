import { REAL_SYNC_BURSTS } from './real-bursts';

const SYMBOL_RATE = 18000;
const PHASE_STEP = { '00': Math.PI / 4, '01': (3 * Math.PI) / 4, 11: (-3 * Math.PI) / 4, 10: -Math.PI / 4 };

function rrc(t, alpha = 0.35) {
	if (Math.abs(t) < 1e-9) return 1 - alpha + (4 * alpha) / Math.PI;
	if (Math.abs(Math.abs(t) - 1 / (4 * alpha)) < 1e-9)
		return (
			(alpha / Math.SQRT2) * ((1 + 2 / Math.PI) * Math.sin(Math.PI / (4 * alpha)) + (1 - 2 / Math.PI) * Math.cos(Math.PI / (4 * alpha)))
		);
	return (
		(Math.sin(Math.PI * t * (1 - alpha)) + 4 * alpha * t * Math.cos(Math.PI * t * (1 + alpha))) / (Math.PI * t * (1 - (4 * alpha * t) ** 2))
	);
}

/** Deterministic pseudo-random bits for filler bursts. */
export function fillerBits(count, seed = 1) {
	let state = seed;
	return Array.from({ length: count }, () => {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		return (state >> 16) & 1 ? '1' : '0';
	}).join('');
}

/** A continuous downlink: each live synchronisation burst followed by `fillers` random bursts. */
export function downlinkBits(bursts = REAL_SYNC_BURSTS.cellA, fillers = 3) {
	let bits = fillerBits(510 * 2, 7);
	bursts.forEach((burst, index) => {
		bits += burst;
		for (let i = 0; i < fillers; i++) bits += fillerBits(510, index * 10 + i + 2);
	});
	return bits;
}

function gaussian(random) {
	return Math.sqrt(-2 * Math.log(random() || 1e-12)) * Math.cos(2 * Math.PI * random());
}

/**
 * pi/4-DQPSK with root-raised-cosine pulses, rendered directly at `rate` as interleaved I/Q,
 * shifted by `offsetHz`, delayed by `delaySymbols` and with complex noise of `noise` RMS.
 */
export function tetraSignal(bits, { rate = 72000, offsetHz = 0, delaySymbols = 0.37, noise = 0, amplitude = 0.3, clockError = 0 } = {}) {
	const symbols = [];
	let phase = 0;
	for (let i = 0; i + 1 < bits.length; i += 2) {
		phase += PHASE_STEP[bits.slice(i, i + 2)];
		symbols.push([Math.cos(phase), Math.sin(phase)]);
	}
	const symbolRate = SYMBOL_RATE * (1 + clockError);
	const count = Math.ceil(((symbols.length + 8) * rate) / symbolRate);
	const out = new Float32Array(count * 2);
	let seed = 12345;
	const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
	for (let n = 0; n < count; n++) {
		const t = (n * symbolRate) / rate - delaySymbols;
		let i = 0,
			q = 0;
		for (let k = Math.max(0, Math.ceil(t - 4)); k <= Math.min(symbols.length - 1, Math.floor(t + 4)); k++) {
			const weight = rrc(t - k);
			i += symbols[k][0] * weight;
			q += symbols[k][1] * weight;
		}
		const carrier = (2 * Math.PI * offsetHz * n) / rate;
		const c = Math.cos(carrier),
			s = Math.sin(carrier);
		out[2 * n] = amplitude * (i * c - q * s) + noise * gaussian(random);
		out[2 * n + 1] = amplitude * (i * s + q * c) + noise * gaussian(random);
	}
	return out;
}
