import { describe, expect, it } from 'vitest';
import { decodeSyncBurst } from '@/worker/decoders/tetra/bursts';
import { REAL_SYNC_BURSTS } from './real-bursts';

const soft = (bits) => Float32Array.from(bits, (bit) => (bit === '1' ? 1 : -1));

describe('TETRA synchronisation burst decoding', () => {
	it.each(REAL_SYNC_BURSTS.cellA)('decodes the BSCH and SYSINFO of a live 391.000 MHz burst', (bits) => {
		const { sync, sysinfo } = decodeSyncBurst(soft(bits));
		expect(sync).toMatchObject({ mcc: 222, mnc: 55, colourCode: 31, systemCode: 2 });
		expect(sync.timeslot).toBeGreaterThanOrEqual(1);
		// This cell sends synchronisation bursts outside frame 18 too.
		expect(sync.frame).toBeGreaterThanOrEqual(1);
		expect(sync.frame).toBeLessThanOrEqual(18);
		expect(sysinfo).toMatchObject({ mainCarrier: 3640, band: 3, offset: 0, mainCarrierMHz: 391 });
	});
	it.each(REAL_SYNC_BURSTS.cellB)('separates a second live cell on 390.250 MHz', (bits) => {
		const { sync, sysinfo } = decodeSyncBurst(soft(bits));
		expect(sync).toMatchObject({ mcc: 222, mnc: 55, colourCode: 30 });
		expect(sysinfo?.mainCarrierMHz).toBe(390.25);
	});
	it('corrects scattered bit errors with the convolutional code', () => {
		const bits = soft(REAL_SYNC_BURSTS.cellA[0]);
		for (const position of [100, 131, 160, 190, 300, 350, 400, 450]) bits[position] = -bits[position];
		expect(decodeSyncBurst(bits).sync?.colourCode).toBe(31);
	});
	it('rejects a burst whose BSCH fails the CRC', () => {
		const bits = soft(REAL_SYNC_BURSTS.cellA[0]);
		for (let position = 94; position < 214; position += 3) bits[position] = -bits[position];
		expect(decodeSyncBurst(bits)).toEqual({});
	});
	it('treats erased (zero) soft bits as unknown instead of zeros', () => {
		const bits = soft(REAL_SYNC_BURSTS.cellA[1]);
		for (let position = 94; position < 214; position += 9) bits[position] = 0;
		expect(decodeSyncBurst(bits).sync?.mcc).toBe(222);
	});
});
