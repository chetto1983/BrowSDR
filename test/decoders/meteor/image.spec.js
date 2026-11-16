import { describe, expect, it } from 'vitest';
import { MeteorImage } from '@/app/decoders/meteor/image';

const WIDTH = 1568;

/** Rows from..to-1 where channel c holds the value base + c in every pixel. */
function rows(from, to, base) {
	const make = (value) => new Uint8Array((to - from) * WIDTH).fill(value);
	return { from, to, width: WIDTH, channels: [make(base), make(base + 1), make(base + 2)] };
}

describe('Meteor image assembly', () => {
	it('grows by row ranges and fills skipped rows with grey', () => {
		const image = new MeteorImage();
		image.append(rows(0, 8, 10));
		image.append(rows(16, 24, 40));
		expect(image.rows).toBe(24);
		const rgba = image.rgba('rgb');
		expect(rgba).toHaveLength(24 * WIDTH * 4);
		const pixel = (row) => Array.from(rgba.subarray(row * WIDTH * 4, row * WIDTH * 4 + 4));
		expect(pixel(0)).toEqual([10, 11, 12, 255]);
		expect(pixel(10)).toEqual([128, 128, 128, 255]);
		expect(pixel(20)).toEqual([40, 41, 42, 255]);
	});
	it('shows one channel in grey levels', () => {
		const image = new MeteorImage();
		image.append(rows(0, 8, 10));
		expect(Array.from(image.rgba(1).subarray(0, 4))).toEqual([11, 11, 11, 255]);
	});
	it('puts a restarted decoder below the old picture, after a grey band', () => {
		const image = new MeteorImage();
		image.append(rows(0, 8, 10));
		image.append(rows(0, 8, 99)); // the decoder started over (stream restarted mid-pass)
		expect(image.rows).toBe(24);
		const rgba = image.rgba(0);
		expect(rgba[0]).toBe(10);
		expect(rgba[10 * WIDTH * 4]).toBe(128);
		expect(rgba[20 * WIDTH * 4]).toBe(99);
		image.append(rows(8, 16, 50)); // and its later rows follow on from there
		expect(image.rows).toBe(32);
		expect(image.rgba(0)[28 * WIDTH * 4]).toBe(50);
	});
	it('starts over after a reset', () => {
		const image = new MeteorImage();
		image.append(rows(0, 8, 10));
		image.reset();
		expect(image.rows).toBe(0);
		expect(image.rgba('rgb')).toHaveLength(0);
	});
});
