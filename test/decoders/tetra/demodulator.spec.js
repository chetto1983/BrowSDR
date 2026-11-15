import { describe, expect, it } from 'vitest';
import { TetraDemodulator } from '@/worker/decoders/tetra/demodulator';
import { SyncBurstFinder } from '@/worker/decoders/tetra/bursts';
import { REAL_SYNC_BURSTS } from './real-bursts';
import { downlinkBits, tetraSignal } from './fixtures';

function receive(signal, chunk = 4096) {
	const bursts = [];
	const finder = new SyncBurstFinder((burst) => bursts.push(burst));
	const demodulator = new TetraDemodulator((a, b) => finder.pushSymbol(a, b));
	for (let i = 0; i < signal.length; i += chunk) demodulator.process(signal.subarray(i, i + chunk));
	return { bursts, demodulator, finder };
}

describe('TETRA pi/4-DQPSK demodulator', () => {
	it('recovers live synchronisation bursts from a clean 72 kS/s channel', () => {
		const { bursts, demodulator } = receive(tetraSignal(downlinkBits()));
		expect(bursts.map((burst) => burst.sync?.colourCode)).toEqual([31, 31]);
		expect(bursts[0].sysinfo?.mainCarrierMHz).toBe(391);
		expect(demodulator.quality).toBeGreaterThan(0.9);
	});
	it.each([
		['frequency offset', { offsetHz: 900 }],
		['negative offset and odd timing', { offsetHz: -1400, delaySymbols: 2.81 }],
		['20 ppm symbol clock error', { clockError: 20e-6 }],
		['noise near 13 dB SNR', { noise: 0.067 }],
	])('decodes with %s', (_, options) => {
		const { bursts, demodulator } = receive(tetraSignal(downlinkBits(REAL_SYNC_BURSTS.cellB, 6), options), 1000);
		expect(bursts.filter((burst) => burst.sync?.colourCode === 30)).toHaveLength(2);
		if (options.offsetHz) expect(demodulator.freqOffsetHz).toBeCloseTo(options.offsetHz, -2);
	});
	it('stays silent on noise', () => {
		const noise = tetraSignal('00'.repeat(4000), { amplitude: 0, noise: 0.2 });
		const { bursts, finder, demodulator } = receive(noise);
		expect(bursts).toEqual([]);
		expect(finder.bursts).toBe(0);
		expect(demodulator.quality).toBeLessThan(0.35);
	});
	it('restarts cleanly after reset', () => {
		const signal = tetraSignal(downlinkBits());
		const { bursts, demodulator } = receive(signal.subarray(0, 20000));
		demodulator.reset();
		for (let i = 0; i < signal.length; i += 4096) demodulator.process(signal.subarray(i, i + 4096));
		expect(bursts.filter((burst) => burst.sync).length).toBeGreaterThanOrEqual(2);
	});
});
