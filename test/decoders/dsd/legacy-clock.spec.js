import { describe, expect, it, vi } from 'vitest';

const codec = vi.hoisted(() => ({ frames: [] }));
vi.mock('@/worker/decoders/mbelib-init', () => ({
	ensureMbelibInitialized: async () => {},
	decodeAmbe: (frame) => {
		codec.frames.push(Array.from(frame));
		return new Float32Array(160);
	},
	decodeImbe: () => new Float32Array(160),
	resetMbe: vi.fn(),
	getMbeErrors: () => 0,
}));

import { DSDStream } from '@/worker/decoders/dsd/dsd-stream';
import { ambeFrame } from '@/worker/decoders/dsd/ambe';
import { NXDN_PR, SYNC_WORDS } from '@/worker/decoders/dsd/constants';
import { ambeEncode, channel, fmIq, randomBits } from './voice-fixtures.js';
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

async function receive(bits, cfoHz) {
	const iq = channel(fmIq(c4fmFrequency(bits, 48000, { cfoHz, idle: 80 })), { cnrDb: 30 });
	const statuses = [];
	const stream = new DSDStream((status) => statuses.push(status));
	await stream.decoder.mbeInitPromise;
	for (let i = 0; i < iq.length; i += 1920) stream.process(iq.subarray(i, i + 1920));
	return statuses.filter((status) => status.synced);
}

describe('shared DSD clock recovery with P25 and NXDN syncs', () => {
	it.each([-1500, 0, 1500])('acquires P25 Phase 1 at a %i Hz tuning error', async (cfoHz) => {
		const statuses = await receive(transmission(SYNC_WORDS.P25P1, 776, 18), cfoHz);
		expect(statuses.filter((status) => status.mode === 'p25').length).toBeGreaterThanOrEqual(15);
	});

	it.each([-1500, 0, 1500])('acquires NXDN on its 192 dibit grid at a %i Hz tuning error', async (cfoHz) => {
		const statuses = await receive(transmission(SYNC_WORDS.NXDN_MS_DATA, 192, 60), cfoHz);
		expect(statuses.filter((status) => status.mode === 'nxdn').length).toBeGreaterThanOrEqual(50);
	});

	it('delivers steady NXDN AMBE frames exactly through the DSD stream at a 1 kHz tuning error', async () => {
		codec.frames.length = 0;
		const channelBits = ambeEncode(randomBits(19, 49));
		const bits = transmission(SYNC_WORDS.NXDN_MS_VOICE, 192, 18);
		for (let frame = 0; frame < 18; frame++)
			for (let voice = 0; voice < 4; voice++)
				for (let i = 0; i < 36; i++) {
					const bitPos = 2 * (40 + frame * 192 + 18 + voice * 36 + i);
					const pr = NXDN_PR[voice * 36 + i];
					bits[bitPos] = channelBits[2 * i] ^ pr;
					bits[bitPos + 1] = channelBits[2 * i + 1] ^ pr;
				}
		const statuses = await receive(bits, 1000);
		expect(statuses.filter((status) => status.mode === 'nxdn' && status.nxdnType === 'Voice').length).toBeGreaterThanOrEqual(14);
		expect(codec.frames.length).toBeGreaterThanOrEqual(14 * 4);
		const expected = Array.from(ambeFrame(channelBits));
		const errors = codec.frames.map((frame) => frame.reduce((n, bit, i) => n + (bit !== expected[i]), 0));
		// The first two acquired frames train the slicer; every subsequent frame must match the transmitted channel bits.
		expect(Math.max(...errors.slice(0, 8))).toBeLessThanOrEqual(3);
		expect(Math.max(...errors.slice(8))).toBe(0);
	});
});
