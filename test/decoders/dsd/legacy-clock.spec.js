import { describe, expect, it, vi } from 'vitest';

vi.mock('@/worker/decoders/mbelib-init', () => ({
	ensureMbelibInitialized: async () => {},
	decodeAmbe: () => new Float32Array(160),
	decodeImbe: () => new Float32Array(160),
	resetMbe: vi.fn(),
	getMbeErrors: () => 0,
}));

import { DSDStream } from '@/worker/decoders/dsd/dsd-stream';
import { SYNC_WORDS } from '@/worker/decoders/dsd/constants';
import { channel, fmIq, randomBits } from './voice-fixtures.js';
import { c4fmFrequency } from './ysf/fixtures.js';

function transmission(sync, spacing, count) {
	const bits = randomBits(77, (count * spacing + 80) * 2);
	const lead = 40;
	for (let frame = 0; frame < count; frame++) {
		const start = (lead + frame * spacing) * 2;
		for (let i = 0; i < sync.length; i++) {
			const dibit = Number(sync[i]);
			bits[start + 2 * i] = dibit >> 1;
			bits[start + 2 * i + 1] = dibit & 1;
		}
	}
	return bits;
}

function receive(bits, cfoHz) {
	const iq = channel(fmIq(c4fmFrequency(bits, 48000, { cfoHz, idle: 80 })), { cnrDb: 30 });
	const statuses = [];
	const stream = new DSDStream((status) => statuses.push(status));
	for (let i = 0; i < iq.length; i += 1920) stream.process(iq.subarray(i, i + 1920));
	return statuses.filter((status) => status.synced);
}

describe('shared DSD clock recovery with P25 and NXDN syncs', () => {
	it.each([-1500, 0, 1500])('acquires P25 Phase 1 at a %i Hz tuning error', (cfoHz) => {
		const statuses = receive(transmission(SYNC_WORDS.P25P1, 776, 18), cfoHz);
		expect(statuses.filter((status) => status.mode === 'p25').length).toBeGreaterThanOrEqual(15);
	});

	it.each([-1500, 0, 1500])('acquires NXDN on its 192 dibit grid at a %i Hz tuning error', (cfoHz) => {
		const statuses = receive(transmission(SYNC_WORDS.NXDN_MS_DATA, 192, 60), cfoHz);
		expect(statuses.filter((status) => status.mode === 'nxdn').length).toBeGreaterThanOrEqual(50);
	});
});
