import { describe, expect, it } from 'vitest';
import { ISCH_WORDS, DUID_LOOKUP } from '@/worker/decoders/dsd/p25p2/data';
import {
	P25P2_SYNC,
	ischValue,
	ischDecode,
	ischSyncDistance,
	p25p2Duid,
	p25p2Scramble,
	p25p2Descramble,
	p25p2AmbeFrame,
} from '@/worker/decoders/dsd/p25p2/protocol';

function dibits(word) {
	return Uint8Array.from({ length: 20 }, (_, index) => Number((word >> BigInt(38 - 2 * index)) & 3n));
}

describe('P25 Phase 2 burst primitives', () => {
	it('distinguishes S-ISCH from I-ISCH and corrects seven I-ISCH bits', () => {
		expect(ischValue(dibits(P25P2_SYNC))).toBe(P25P2_SYNC);
		expect(ischSyncDistance(dibits(P25P2_SYNC))).toBe(0);
		expect(ischDecode(dibits(P25P2_SYNC))).toBeNull();
		const word = ISCH_WORDS[51];
		expect(ischDecode(dibits(word))).toEqual({ channel: 1, location: 2, first: 0, ultraframe: 3, errors: 0 });
		expect(ischDecode(dibits(word ^ 0x7fn))).toEqual({ channel: 1, location: 2, first: 0, ultraframe: 3, errors: 7 });
	});

	it('identifies the coded burst type after a one-bit error', () => {
		expect(DUID_LOOKUP[0x65]).toBe(6);
		const burst = new Uint8Array(180);
		for (const [index, position] of [20, 57, 142, 179].entries()) burst[position] = (0x65 >> (6 - 2 * index)) & 3;
		expect(p25p2Duid(burst)).toBe(6);
		burst[57] ^= 2;
		expect(p25p2Duid(burst)).toBe(6);
	});

	it('matches the reference superframe scrambler for WACN BEE00 / system 2D1', () => {
		const sequence = p25p2Scramble(0xbee00, 0x2d1, 0x2d1);
		expect(Array.from(sequence.subarray(0, 80)).join('')).toBe(
			'00000000002332320000023101023101232102230022203012122321213202121201322031002330',
		);
		expect(Array.from(sequence.subarray(2090, 2170)).join('')).toBe(
			'11120110303310123033122021310212001311323333203313033111121210301131000021021322',
		);
		expect(p25p2Scramble(0, 0, 0).every((value) => value === 0)).toBe(true);
		const burst = Uint8Array.from({ length: 180 }, (_, index) => index & 3);
		const once = p25p2Descramble(burst, sequence, 4);
		expect(p25p2Descramble(once, sequence, 4)).toEqual(burst);
	});

	it('places a 4V AMBE+2 air bit into the mbelib word', () => {
		const burst = new Uint8Array(180);
		burst[21] = 2;
		const frame = p25p2AmbeFrame(burst, 2);
		expect(frame.length).toBe(96);
		expect(frame[23]).toBe(1);
		expect(frame.reduce((sum, bit) => sum + bit, 0)).toBe(1);
	});
});
