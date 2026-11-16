import { describe, expect, it } from 'vitest';
import { bptc19696, decodeDmrLinkControl, rs129Parity, slotType } from '@/worker/decoders/dsd/dmr-lc';

const BS_DATA_SYNC = 0xdff57d75df5dn; // 48-bit base station data sync
const H15113 = [
	[0, 1, 2, 3, 5, 7, 8],
	[1, 2, 3, 4, 6, 8, 9],
	[2, 3, 4, 5, 7, 9, 10],
	[0, 1, 2, 4, 6, 7, 10],
];
const H1393 = [
	[0, 1, 3, 5, 6],
	[0, 1, 2, 4, 6, 7],
	[0, 1, 2, 3, 5, 7, 8],
	[0, 2, 4, 5, 8],
];

/** Builds the 132 dibits of a data burst carrying `lc` (9 bytes) with the given slot type, plus 12 leading CACH dibits. */
function dataBurst(lc, { dataType = 1, colourCode = 5, crcMask = 0x96, corrupt = -1 } = {}) {
	const parity = rs129Parity(lc);
	const bytes = [...lc, ...parity.map((p) => p ^ crcMask)];
	const data = [];
	for (const byte of bytes) for (let b = 7; b >= 0; b--) data.push((byte >> b) & 1);
	// Place the 96 data bits into the BPTC matrix, then add row (15,11) and column (13,9) Hamming parity.
	const matrix = new Uint8Array(196);
	let pos = 0;
	for (let a = 4; a <= 11; a++) matrix[a] = data[pos++];
	for (let row = 1; row < 9; row++) for (let a = row * 15 + 1; a <= row * 15 + 11; a++) matrix[a] = data[pos++];
	for (let row = 0; row < 9; row++) {
		const base = row * 15 + 1;
		H15113.forEach((bits, k) => (matrix[base + 11 + k] = bits.reduce((acc, i) => acc ^ matrix[base + i], 0)));
	}
	for (let c = 0; c < 15; c++) {
		H1393.forEach((bits, k) => (matrix[c + 1 + (9 + k) * 15] = bits.reduce((acc, i) => acc ^ matrix[c + 1 + i * 15], 0)));
	}
	const raw = new Uint8Array(196);
	for (let a = 0; a < 196; a++) raw[(a * 181) % 196] = matrix[a];
	for (const bit of [].concat(corrupt)) if (bit >= 0) raw[bit] ^= 1;
	const slot = ((colourCode << 4) | dataType) << 12; // Golay parity left at 0
	const bits = new Uint8Array(264);
	bits.set(raw.subarray(0, 98), 0);
	for (let i = 0; i < 10; i++) bits[98 + i] = (slot >> (19 - i)) & 1;
	for (let i = 0; i < 48; i++) bits[108 + i] = Number((BS_DATA_SYNC >> BigInt(47 - i)) & 1n);
	for (let i = 0; i < 10; i++) bits[156 + i] = (slot >> (9 - i)) & 1;
	bits.set(raw.subarray(98), 166);
	const dibits = new Uint8Array(12 + 132);
	for (let i = 0; i < 132; i++) dibits[12 + i] = (bits[2 * i] << 1) | bits[2 * i + 1];
	return { dibits, afterSync: 12 + 78 };
}

// Group call to talkgroup 2222 from radio 2220001: FLCO 0, FID 0, service options 0.
const GROUP_CALL = [0x00, 0x00, 0x00, 0x00, 0x08, 0xae, 0x21, 0xdf, 0xe1];

describe('DMR Full Link Control', () => {
	it('reads the colour code and data type from the slot type', () => {
		const { dibits, afterSync } = dataBurst(GROUP_CALL, { colourCode: 5, dataType: 9 });
		expect(slotType(dibits, afterSync - 78, 0xffff)).toEqual({ colourCode: 5, dataType: 9 });
	});
	it('decodes a Voice LC Header group call', () => {
		const { dibits, afterSync } = dataBurst(GROUP_CALL);
		expect(decodeDmrLinkControl(dibits, afterSync, 0xffff)).toEqual({
			colourCode: 5,
			terminator: false,
			group: true,
			featureSet: 0,
			emergency: false,
			privacy: false,
			target: 2222,
			source: 2220001,
		});
	});
	it('decodes a Terminator with LC using its own CRC mask', () => {
		const lc = [0x03, 0x10, 0x40, 0x21, 0xdf, 0xe2, 0x21, 0xdf, 0xe1];
		const { dibits, afterSync } = dataBurst(lc, { dataType: 2, crcMask: 0x99 });
		expect(decodeDmrLinkControl(dibits, afterSync, 0xffff)).toMatchObject({
			terminator: true,
			group: false,
			featureSet: 0x10,
			privacy: true,
			target: 2220002,
			source: 2220001,
		});
	});
	it('corrects scattered bit errors with the BPTC row and column Hamming codes', () => {
		const { dibits, afterSync } = dataBurst(GROUP_CALL, { corrupt: [3, 40, 77, 120, 150, 190] });
		expect(decodeDmrLinkControl(dibits, afterSync, 0xffff)?.source).toBe(2220001);
	});
	it('rejects a header checked with the terminator mask, a heavily damaged block and idle bursts', () => {
		const damaged = Array.from({ length: 40 }, (_, i) => i * 4);
		expect(decodeDmrLinkControl(...Object.values(dataBurst(GROUP_CALL, { crcMask: 0x99 })), 0xffff)).toBeNull();
		expect(decodeDmrLinkControl(...Object.values(dataBurst(GROUP_CALL, { corrupt: damaged })), 0xffff)).toBeNull();
		expect(decodeDmrLinkControl(...Object.values(dataBurst(GROUP_CALL, { dataType: 9 })), 0xffff)).toBeNull();
	});
	it('reads across the circular buffer boundary', () => {
		const { dibits } = dataBurst(GROUP_CALL);
		const ring = new Uint8Array(65536);
		const base = 65536 - 50;
		dibits.forEach((d, i) => (ring[(base + i) & 0xffff] = d));
		expect(decodeDmrLinkControl(ring, (base + 12 + 78) & 0xffff, 0xffff)?.source).toBe(2220001);
		expect(bptc19696(ring, base + 12, 0xffff)).toHaveLength(12);
	});
});
