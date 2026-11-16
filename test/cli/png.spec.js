import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { encodePng } from '../../src/cli/png';

describe('PNG encoder', () => {
	it('writes an RGB image any decoder can read back', () => {
		const png = encodePng(2, 1, Uint8Array.of(255, 0, 0, 0, 255, 0));
		expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
		expect(png.toString('latin1', 12, 16)).toBe('IHDR');
		expect(png.readUInt32BE(16)).toBe(2);
		expect(png.readUInt32BE(20)).toBe(1);
		const idat = png.indexOf('IDAT', 0, 'latin1');
		const length = png.readUInt32BE(idat - 4);
		const raw = inflateSync(png.subarray(idat + 4, idat + 4 + length));
		expect([...raw]).toEqual([0, 255, 0, 0, 0, 255, 0]);
		expect(png.toString('latin1', png.length - 8, png.length - 4)).toBe('IEND');
	});
});
