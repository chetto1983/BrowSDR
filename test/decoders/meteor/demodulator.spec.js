import { describe, expect, it } from 'vitest';
import { MeteorDemodulator, METEOR_CHANNEL_RATE, METEOR_SYMBOL_RATE } from '@/worker/decoders/meteor/demodulator';
import { bestBitErrorRate, noiseOnly, qpskSignal } from './fixtures';

/** Runs the demodulator over `iq` in 10 ms blocks, sampling `locked` after each block. */
function demodulate(iq) {
	const chunks = [];
	const demodulator = new MeteorDemodulator((soft) => chunks.push(Int8Array.from(soft)), 'qpsk');
	const lockedAt = [];
	const block = (METEOR_CHANNEL_RATE / 100) * 2;
	for (let at = 0; at < iq.length; at += block) {
		demodulator.process(iq.subarray(at, at + block));
		lockedAt.push(demodulator.locked);
	}
	const soft = new Int8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		soft.set(chunk, offset);
		offset += chunk.length;
	}
	return { demodulator, soft, lockedAt };
}

describe('Meteor LRPT QPSK demodulator', () => {
	it('runs at two samples per 72 ksym/s symbol', () => {
		expect(METEOR_SYMBOL_RATE).toBe(72000);
		expect(METEOR_CHANNEL_RATE).toBe(144000);
	});
	it('locks on an offset carrier, measures the offset and recovers the bits', () => {
		const { iq, bits } = qpskSignal(72000 * 1.5, { offsetHz: 2500, timingOffset: 0.3, snrDb: 20 });
		const { demodulator, soft, lockedAt } = demodulate(iq);
		expect(lockedAt.slice(50).every(Boolean)).toBe(true); // locked from 0.5 s on
		expect(Math.abs(demodulator.freqOffsetHz - 2500)).toBeLessThan(100);
		expect(soft.length / 2).toBeGreaterThan(72000 * 1.4);
		expect(bestBitErrorRate(soft, bits, 72000)).toBeLessThan(1e-3);
	});
	it('holds lock through a Doppler ramp near the edge of the range', () => {
		const { iq } = qpskSignal(72000 * 10, { offsetHz: -3500, dopplerHzPerS: 60, snrDb: 15, seed: 3 });
		const { demodulator, lockedAt } = demodulate(iq);
		expect(lockedAt.slice(50).every(Boolean)).toBe(true);
		expect(Math.abs(demodulator.freqOffsetHz - (-3500 + 600))).toBeLessThan(150);
	}, 20_000); // 10 s of signal: slow when the whole suite runs in parallel
	it('does not lock on noise', () => {
		const { demodulator, lockedAt } = demodulate(noiseOnly(METEOR_CHANNEL_RATE * 2));
		expect(lockedAt.some(Boolean)).toBe(false);
		expect(demodulator.quality).toBeLessThan(0.3);
	});
	it('relocks quickly after a reset', () => {
		const { iq, bits } = qpskSignal(72000 * 2, { offsetHz: -1200, snrDb: 20, seed: 5 });
		const chunks = [];
		const demodulator = new MeteorDemodulator((soft) => chunks.push(Int8Array.from(soft)), 'qpsk');
		demodulator.process(iq.subarray(0, iq.length / 2));
		demodulator.reset();
		expect(demodulator.locked).toBe(false);
		chunks.length = 0;
		const half = iq.subarray(iq.length / 2);
		const block = (METEOR_CHANNEL_RATE / 100) * 2;
		let lockedAfter = -1;
		for (let at = 0, n = 0; at < half.length; at += block, n++) {
			demodulator.process(half.subarray(at, at + block));
			if (lockedAfter < 0 && demodulator.locked) lockedAfter = n;
		}
		expect(lockedAfter).toBeGreaterThanOrEqual(0);
		expect(lockedAfter).toBeLessThan(50);
		const soft = Int8Array.from(chunks.flatMap((chunk) => [...chunk]));
		expect(bestBitErrorRate(soft, bits.subarray(bits.length / 2), 36000)).toBeLessThan(1e-3);
	});
});
