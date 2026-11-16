import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import MeteorModule from '../../../wasm/meteor/pkg/meteor.js';
import { createMeteorDecoder } from '@/worker/decoders/meteor-init';

const pkg = (file) => fileURLToPath(new URL(`../../../wasm/meteor/pkg/${file}`, import.meta.url));
const factory = (options) => MeteorModule({ ...options, locateFile: pkg });

/** Seeded Gaussian-ish int8 noise, as a demodulator outputs with no signal. */
function noise(count, seed = 7) {
	const out = new Int8Array(count);
	let state = seed;
	const uniform = () => (state = (state * 1103515245 + 12345) >>> 0) / 2 ** 32 - 0.5;
	for (let i = 0; i < count; i++) out[i] = Math.max(-127, Math.min(127, Math.round((uniform() + uniform() + uniform()) * 60)));
	return out;
}

describe('meteor_decode WASM', () => {
	let decoder;
	beforeAll(async () => {
		decoder = await createMeteorDecoder(factory);
	});

	it('reports the AVHRR image width', () => {
		expect(decoder.width()).toBe(1568);
		expect(decoder.rows()).toBe(0);
	});
	it('decodes nothing from noise and does not fail', () => {
		decoder.reset();
		expect(decoder.push(noise(72000 * 2))).toBe(0);
		expect(decoder.stats().mpdus).toBe(0);
		expect(decoder.rows()).toBe(0);
	});
	it('gives the same result however the symbols are split', () => {
		const symbols = noise(72000 * 2, 11);
		decoder.reset();
		decoder.push(symbols);
		const whole = decoder.stats();
		decoder.reset();
		for (let i = 0; i < symbols.length; i += 7) decoder.push(symbols.subarray(i, i + 7));
		expect(decoder.stats()).toEqual(whole);
	});
	it('accepts blocks larger than its input buffer', () => {
		decoder.reset();
		expect(() => decoder.push(noise(400000, 3))).not.toThrow();
	});
	it('starts over after a reset', () => {
		decoder.reset();
		expect(decoder.rows()).toBe(0);
		expect(decoder.stats().mpdus).toBe(0);
	});
});
