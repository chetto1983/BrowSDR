import { describe, expect, it } from 'vitest';
import { DabReceiver } from '@/worker/decoders/dab/receiver';
import { DabSignal } from './transmitter.js';
import { DLS, ENSEMBLE, feed, recorder, skip } from './fixtures.js';

describe('DAB receiver after lost samples', () => {
	it('finds the ensemble again after a gap, after reset() and stops on select(null)', () => {
		const signal = new DabSignal(ENSEMBLE, { snrDb: 15, cfoHz: -1800, seed: 4 });
		const r = recorder();
		const receiver = new DabReceiver(r.events);
		receiver.select(3);
		feed(receiver, signal, 1.2);
		const before = r.aus.length;
		expect(before).toBeGreaterThan(20);
		expect(r.status.at(-1).state).toBe('synced');

		// 250 ms of samples lost on the way: the phase reference is not where it should be
		skip(signal, 0.25);
		const mark = r.status.length;
		feed(receiver, signal, 1.5);
		const after = r.status.slice(mark).map((s) => s.state);
		expect(after).toContain('searching');
		expect(after.at(-1)).toBe('synced');
		const resumed = r.aus.slice(before);
		expect(resumed.filter((a) => a.ok).length).toBeGreaterThan(30);
		expect(resumed.slice(-12).every((a) => a.ok)).toBe(true);

		// a reset (the stream does it after an input gap) learns the ensemble again and keeps the selection
		const ensembles = r.ensembles.length,
			labels = r.labels.length,
			aus = r.aus.length;
		receiver.reset();
		feed(receiver, signal, 1.2);
		expect(r.ensembles.length).toBeGreaterThan(ensembles);
		expect(r.ensembles.at(-1).services.map((s) => s.label)).toEqual(['BrowSDR Plus', 'BrowSDR MP2']);
		expect(r.aus.slice(aus).filter((a) => a.ok).length).toBeGreaterThan(20);
		expect(r.labels.slice(labels)).toContain(DLS);

		receiver.select(null);
		const stopped = r.aus.length;
		feed(receiver, signal, 0.4);
		expect(r.aus.length).toBe(stopped);
		expect(r.status.at(-1).state).toBe('synced');
	});
});
