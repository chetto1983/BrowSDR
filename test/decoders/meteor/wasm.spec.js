import { readFileSync } from 'node:fs';
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

/**
 * 1 MB of soft symbols from the Meteor-M2 4 pass of 2026-11-16 (15:55:33 local, recorded through the relay at
 * 1.024 MS/s, demodulated by MeteorDemodulator in OQPSK mode): about 7 s of real downlink.
 */
const realPass = () => {
	const bytes = readFileSync(fileURLToPath(new URL('./real-pass.s', import.meta.url)));
	return new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
};

describe('meteor_decode on a real pass', () => {
	it('decodes the OQPSK pass once differentially decoded, into image rows', async () => {
		const decoder = await createMeteorDecoder(factory, 'oqpsk');
		decoder.push(realPass());
		expect(decoder.stats().mpdus).toBeGreaterThan(200);
		expect(decoder.rows()).toBeGreaterThanOrEqual(40);
		const apids = [0, 1, 2].map((c) => decoder.apid(c)).filter((apid) => apid >= 0);
		expect(apids.length).toBeGreaterThan(0);
		expect(apids.every((apid) => apid >= 64 && apid <= 69)).toBe(true);
	});
	it('finds nothing in the same symbols without differential decoding', async () => {
		const decoder = await createMeteorDecoder(factory, 'qpsk');
		decoder.push(realPass());
		expect(decoder.stats().mpdus).toBe(0);
	});
});

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
