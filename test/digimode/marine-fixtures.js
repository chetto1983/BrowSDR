import { noise } from './fixtures';
import { codesToBits, navtexEncode, sitorBSlots } from '@/worker/decoders/digimode/navtex/code';

/**
 * The bits of a NAVTEX transmission (SITOR-B FEC, as OnAir's marine_gen.cpp builds them): `idle` DX places of the
 * phasing signal, the message, then 12 idle places.
 */
export function navtexBits(text, { idle = 40 } = {}) {
	const tokens = [...new Array(idle).fill(-1), ...navtexEncode(text), ...new Array(12).fill(-1)];
	return codesToBits(sitorBSlots(tokens));
}

/**
 * NAVTEX as a radio tuned to the assigned frequency hears it: 100 bd continuous-phase FSK, ±85 Hz (bit 1 = B = the
 * higher tone, or the lower with `invert`), as complex baseband at `rate` with the FSK centre `offsetHz` from 0 Hz,
 * noise of amplitude `noiseLevel` (uniform per component; SNR in 3 kHz = 48 / noiseLevel² at 24 kHz) and `lead`
 * seconds of noise alone before and after.
 */
export function navtexSignal(bits, { rate = 24000, offsetHz = 0, noiseLevel = 0, seed = 1, lead = 1, invert = false } = {}) {
	const samplesPerBit = rate / 100;
	const pad = Math.round(lead * rate);
	const count = pad + Math.ceil(bits.length * samplesPerBit) + pad;
	const iq = new Float32Array(count * 2);
	const random = noise(seed);
	let phase = 0;
	for (let n = 0; n < count; n++) {
		const k = Math.floor((n - pad) / samplesPerBit);
		const on = k >= 0 && k < bits.length;
		if (on) phase += (2 * Math.PI * (offsetHz + (bits[k] ^ (invert ? 1 : 0) ? 85 : -85))) / rate;
		iq[2 * n] = (on ? Math.cos(phase) : 0) + noiseLevel * random();
		iq[2 * n + 1] = (on ? Math.sin(phase) : 0) + noiseLevel * random();
	}
	return iq;
}
