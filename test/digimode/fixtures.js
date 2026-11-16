/** Seeded uniform noise in [-0.5, 0.5), so failures reproduce. */
export function noise(seed) {
	let x = seed >>> 0;
	return () => {
		x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
		return x / 2 ** 32 - 0.5;
	};
}

/**
 * DSC on VHF channel 70 as a radio hears it: 1200 bd AFSK (Y = 1300 Hz, B = 2100 Hz) frequency-modulating the
 * carrier with ±3 kHz deviation, as complex samples at `rate`, `offsetHz` off tune, with noise of amplitude
 * `noiseLevel` and `lead` silent samples (at 24 kHz) before and after.
 */
export function vhfDscSignal(bits, { rate = 24000, offsetHz = 0, noiseLevel = 0, seed = 1, lead = 2400 } = {}) {
	const samplesPerBit = rate / 1200;
	const pad = Math.round((lead * rate) / 24000);
	const count = pad + bits.length * samplesPerBit + pad;
	const iq = new Float32Array(count * 2);
	const random = noise(seed);
	let tonePhase = 0;
	let carrierPhase = 0;
	for (let n = 0; n < count; n++) {
		const k = Math.floor((n - pad) / samplesPerBit);
		const on = k >= 0 && k < bits.length;
		tonePhase += (2 * Math.PI * (on ? (bits[k] ? 1300 : 2100) : 0)) / rate;
		carrierPhase += (2 * Math.PI * (offsetHz + (on ? 3000 * Math.sin(tonePhase) : 0))) / rate;
		iq[2 * n] = Math.cos(carrierPhase) + noiseLevel * random();
		iq[2 * n + 1] = Math.sin(carrierPhase) + noiseLevel * random();
	}
	return iq;
}
