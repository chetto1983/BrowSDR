import { describe, expect, it } from 'vitest';
import { azimuthName, predictPasses } from '@/satellites/passes';
import { parseTle } from '@/satellites/tle';
import { METEOR_TLE, SITE } from './fixtures';

const tles = parseTle(METEOR_TLE);
const FROM = new Date('2026-11-16T07:00:00Z');
const near = (date, iso, seconds = 30) => expect(Math.abs(date.getTime() - Date.parse(iso)) / 1000).toBeLessThanOrEqual(seconds);
const find = (passes, iso) => passes.find((pass) => Math.abs(pass.aos.getTime() - Date.parse(iso)) < 120_000);

describe('Meteor pass prediction', () => {
	const passes = predictPasses(tles, SITE, FROM, 24);

	it('finds the ten passes above 10° in 24 hours, in time order', () => {
		expect(passes).toHaveLength(10);
		expect(passes.map((pass) => pass.aos.getTime())).toEqual([...passes].map((pass) => pass.aos.getTime()).sort((a, b) => a - b));
	});
	it('matches skyfield for the overhead M2 3 pass', () => {
		const pass = find(passes, '2026-11-16T09:05:38Z');
		expect(pass.satellite).toBe('Meteor-M2 3');
		near(pass.aos, '2026-11-16T09:05:38Z');
		near(pass.los, '2026-11-16T09:16:17Z');
		expect(pass.maxElevation).toBeCloseTo(89.5, 0);
		expect(azimuthName(pass.aosAzimuth)).toBe('N');
		expect(azimuthName(pass.losAzimuth)).toBe('S');
		expect(pass.poor).toBe(false);
	});
	it.each([
		['2026-11-16T13:10:31Z', 'Meteor-M2 4', 50.4],
		['2026-11-16T20:28:29Z', 'Meteor-M2 3', 49.1],
		['2026-11-17T03:05:17Z', 'Meteor-M2 4', 66.7],
	])('matches skyfield for the pass rising at %s', (aos, satellite, elevation) => {
		const pass = find(passes, aos);
		expect(pass.satellite).toBe(satellite);
		near(pass.aos, aos);
		expect(Math.abs(pass.maxElevation - elevation)).toBeLessThanOrEqual(1.5);
	});
	it('marks low passes as poor', () => {
		const pass = find(passes, '2026-11-16T07:28:21Z');
		expect(pass.maxElevation).toBeLessThan(20);
		expect(pass.poor).toBe(true);
	});
	it('returns a pass already in progress with its real start', () => {
		const [first] = predictPasses(tles, SITE, new Date('2026-11-16T09:10:00Z'), 6);
		expect(first.inProgress).toBe(true);
		near(first.aos, '2026-11-16T09:05:38Z');
	});
	it('needs the station location', () => {
		expect(() => predictPasses(tles, null, FROM, 24)).toThrow('Set the station location first.');
	});
	it('names compass directions', () => {
		expect([0, 44, 46, 90, 180, 270, 337, 359].map(azimuthName)).toEqual(['N', 'NE', 'NE', 'E', 'S', 'W', 'NW', 'N']);
	});
});
