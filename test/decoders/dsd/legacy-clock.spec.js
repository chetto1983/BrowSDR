import { describe, expect, it, vi } from 'vitest';

const codec = vi.hoisted(() => ({ frames: [] }));
vi.mock('@/worker/decoders/mbelib-init', () => ({
	ensureMbelibInitialized: async () => {},
	decodeAmbe: (frame) => {
		codec.frames.push(Array.from(frame));
		return new Float32Array(160);
	},
	decodeAmbe2400: () => new Float32Array(160),
	decodeImbe: () => new Float32Array(160),
	resetMbe: vi.fn(),
	getMbeErrors: () => 0,
}));

import { DSDStream } from '@/worker/decoders/dsd/dsd-stream';
import { ambeFrame } from '@/worker/decoders/dsd/ambe';
import { SYNC_WORDS } from '@/worker/decoders/dsd/constants';
import { channel, fmIq, randomBits } from './voice-fixtures.js';
import { nxdnSignal, tx } from './nxdn/fixtures.js';
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
		// Whole NXDN96 frames (FSW, the LICH of DSD's NXDN_MS_VOICE sync word, SACCH and four voice frames, PN9 on the
		// symbols' signs) as nxdn/ decodes them; the voice frames follow the SACCH.
		codec.frames.length = 0;
		const t = tx({ baud: 4800, durSec: 18 * 0.04, noHeader: true, noRelease: true });
		const { iq, voice } = nxdnSignal([t], { cnrDb: 30, cfoHz: 1000, validVoice: true, lich: { rfct: 2, fct: 2, opt: 3, dir: 0 } });
		const statuses = [];
		const stream = new DSDStream((status) => statuses.push(status));
		await stream.decoder.mbeInitPromise;
		for (let i = 0; i < iq.length; i += 1920) stream.process(iq.subarray(i, i + 1920));
		expect(statuses.filter((status) => status.mode === 'nxdn' && status.nxdnType === 'Voice').length).toBeGreaterThanOrEqual(14);
		expect(codec.frames.length).toBeGreaterThanOrEqual(14 * 4);
		// Every frame that reached the codec is one that was sent, in order (the very last one ends where the carrier stops).
		const sent = voice.map((bits) => Array.from(ambeFrame(bits)).join(''));
		const at = codec.frames.slice(0, -1).map((frame) => sent.indexOf(frame.join('')));
		expect(Math.min(...at)).toBeGreaterThanOrEqual(0);
		expect(at.every((k, i) => i === 0 || k === at[i - 1] + 1)).toBe(true);
	});
});
