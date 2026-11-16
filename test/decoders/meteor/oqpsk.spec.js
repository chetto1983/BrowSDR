import { describe, expect, it } from 'vitest';
import { MeteorDemodulator, METEOR_CHANNEL_RATE } from '@/worker/decoders/meteor/demodulator';
import { bestRailErrorRate, noiseOnly, qpskSignal } from './fixtures';

/** Runs the demodulator in `mode` over `iq` in 10 ms blocks, sampling `locked` after each block. */
function demodulate(iq, mode) {
	const chunks = [];
	const demodulator = new MeteorDemodulator((soft) => chunks.push(Int8Array.from(soft)), mode);
	const lockedAt = [];
	const block = (METEOR_CHANNEL_RATE / 100) * 2;
	for (let at = 0; at < iq.length; at += block) {
		demodulator.process(iq.subarray(at, at + block));
		lockedAt.push(demodulator.locked);
	}
	const soft = Int8Array.from(chunks.flatMap((chunk) => [...chunk]));
	return { demodulator, soft, lockedAt };
}

describe('Meteor LRPT OQPSK demodulator (Meteor-M2 3 and 4)', () => {
	it('locks on an offset OQPSK carrier, measures the offset and recovers both rails', () => {
		const { iq, bits } = qpskSignal(72000 * 1.5, { offsetHz: 2500, timingOffset: 0.3, snrDb: 20, oqpsk: true });
		const { demodulator, soft, lockedAt } = demodulate(iq, 'oqpsk');
		expect(lockedAt.slice(50).every(Boolean)).toBe(true); // locked from 0.5 s on
		expect(Math.abs(demodulator.freqOffsetHz - 2500)).toBeLessThan(100);
		expect(soft.length / 2).toBeGreaterThan(72000 * 1.4);
		expect(bestRailErrorRate(soft, bits, 72000)).toBeLessThan(1e-3);
	}, 20_000);
	it('is the default mode, since every Meteor in orbit sends OQPSK', () => {
		const { iq, bits } = qpskSignal(72000, { offsetHz: -1500, snrDb: 20, seed: 7, oqpsk: true });
		const { soft } = demodulate(iq, undefined);
		expect(bestRailErrorRate(soft, bits, 36000)).toBeLessThan(1e-3);
	}, 20_000);
	it('cannot recover OQPSK in QPSK mode (why the 2026-11-16 pass gave no image)', () => {
		const { iq, bits } = qpskSignal(72000, { offsetHz: -1500, snrDb: 20, seed: 7, oqpsk: true });
		const { soft } = demodulate(iq, 'qpsk');
		expect(bestRailErrorRate(soft, bits, 36000)).toBeGreaterThan(0.05);
	}, 20_000);
	it('holds lock through a Doppler ramp near the edge of the range', () => {
		const { iq } = qpskSignal(72000 * 6, { offsetHz: -3500, dopplerHzPerS: 60, snrDb: 15, seed: 3, oqpsk: true });
		const { demodulator, lockedAt } = demodulate(iq, 'oqpsk');
		expect(lockedAt.slice(50).every(Boolean)).toBe(true);
		expect(Math.abs(demodulator.freqOffsetHz - (-3500 + 360))).toBeLessThan(150);
	}, 30_000);
	it('finds a carrier 6.5 kHz off: Doppler plus the receiver error measured on the 2026-11-16 pass', () => {
		// That pass ran from -2.5 to -4.9 kHz, about -3.7 kHz at closest approach; a +-4 kHz window lost it.
		const { iq, bits } = qpskSignal(72000 * 1.5, { offsetHz: -6500, snrDb: 15, seed: 11, oqpsk: true });
		const { demodulator, soft, lockedAt } = demodulate(iq, 'oqpsk');
		expect(lockedAt.slice(50).every(Boolean)).toBe(true);
		expect(Math.abs(demodulator.freqOffsetHz + 6500)).toBeLessThan(100);
		expect(bestRailErrorRate(soft, bits, 72000)).toBeLessThan(1e-3);
	}, 20_000);
	it('does not lock on noise', () => {
		const { demodulator, lockedAt } = demodulate(noiseOnly(METEOR_CHANNEL_RATE * 2), 'oqpsk');
		expect(lockedAt.some(Boolean)).toBe(false);
		expect(demodulator.quality).toBeLessThan(0.3);
	});
});
