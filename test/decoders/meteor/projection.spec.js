import { describe, expect, it } from 'vitest';
import { groundPoint } from '@/app/decoders/meteor/projection';
import { orbitState } from '@/satellites/orbit';

const tle = {
	name: 'METEOR-M2 4',
	norad: 59051,
	line1: '1 59051U 24039A   26321.31719347  .00000031  00000+0  33785-4 0  9990',
	line2: '2 59051  98.7249 278.8456 0008152  86.9456 273.2654 14.22443647141030',
	epoch: new Date('2026-11-17T07:36:45Z'),
};

describe('Meteor map geometry', () => {
	it('puts the middle of a Meteor-M2 4 scan close to the sub-satellite point', () => {
		const time = new Date('2026-11-17T14:35:00Z');
		const orbit = orbitState(tle, null, new Date(time.getTime() + 1000));
		const middle = groundPoint(tle, time.getTime(), 784);
		expect(orbit).not.toBeNull();
		expect(middle).not.toBeNull();
		expect(Math.abs(middle.lat - orbit.latitude)).toBeLessThan(1);
		expect(Math.abs(middle.lon - orbit.longitude)).toBeLessThan(1);
	});
	it('places the two edges on opposite sides of the ground track', () => {
		const time = Date.parse('2026-11-17T14:35:00Z');
		const [left, center, right] = [0, 784, 1567].map((x) => groundPoint(tle, time, x));
		expect(left).not.toBeNull();
		expect(right).not.toBeNull();
		expect((left.lon - center.lon) * (right.lon - center.lon)).toBeLessThan(0);
	});
});
