import { describe, expect, it } from 'vitest';
import { TRACKED_SATELLITES } from '@/satellites/catalog';
import { footprint, footprintAngle, groundTrack, orbitMinutes, orbitState, receivedMHz, transmittedMHz } from '@/satellites/orbit';
import { predictPasses } from '@/satellites/passes';
import { parseTle } from '@/satellites/tle';
import { AMATEUR_TLE, SITE } from './fixtures';

const tles = parseTle(AMATEUR_TLE);
const tle = (norad) => tles.find((item) => item.norad === norad);
const state = (norad, iso) => orbitState(tle(norad), SITE, new Date(iso));

describe('orbit state', () => {
	it.each([
		// norad, time, latitude, longitude, elevation, azimuth, range rate (km/s), sunlit — from skyfield 1.55
		[25544, '2026-11-16T21:40:00Z', 47.527, 4.075, 41.41, 324.22, -4.6054, false],
		[27607, '2026-11-16T22:51:00Z', 44.574, 5.258, 74.0, 276.43, -0.8889, false],
		[44909, '2026-11-18T11:57:00Z', 40.543, 6.773, 68.82, 187.37, -2.2414, true],
		[24278, '2026-11-18T04:14:00Z', 44.166, 20.86, 30.57, 86.8, -2.1086, true],
		[7530, '2026-11-17T06:58:00Z', 47.249, 8.473, 74.55, 14.07, -1.5884, true],
		[25544, '2026-11-17T15:30:00Z', -44.254, -78.614, -57.31, 233.6, -3.7157, true],
	])('matches skyfield for %i at %s', (norad, iso, lat, lon, elevation, azimuth, rangeRate, sunlit) => {
		const result = state(norad, iso);
		expect(Math.abs(result.latitude - lat)).toBeLessThan(0.05);
		expect(Math.abs(result.longitude - lon)).toBeLessThan(0.05);
		expect(Math.abs(result.look.elevation - elevation)).toBeLessThan(0.1);
		expect(Math.abs(result.look.azimuth - azimuth)).toBeLessThan(0.2);
		// 2 m/s is 1 Hz at 145 MHz and 3 Hz at 435 MHz.
		expect(Math.abs(result.look.rangeRateKmS - rangeRate)).toBeLessThan(0.002);
		expect(result.sunlit).toBe(sunlit);
	});
	it('reports position without a station', () => {
		const result = orbitState(tle(25544), null, new Date('2026-11-16T21:40:00Z'));
		expect(result.look).toBeNull();
		expect(result.altitudeKm).toBeCloseTo(422.3, 0);
	});
	it('keeps longitudes in -180..180', () => {
		for (let hour = 0; hour < 24; hour++) {
			const { longitude } = state(25544, new Date(Date.UTC(2026, 10, 17, hour)).toISOString());
			expect(longitude).toBeGreaterThanOrEqual(-180);
			expect(longitude).toBeLessThan(180);
		}
	});
});

describe('Doppler', () => {
	it('raises the frequency while the satellite approaches', () => {
		// ISS approaching at 7 km/s: 145.800 MHz is heard 3.4 kHz high.
		expect((receivedMHz(145.8, -7) - 145.8) * 1e6).toBeCloseTo(3404.4, 0);
		expect(receivedMHz(436.795, 5)).toBeLessThan(436.795);
	});
	it('inverts back to the frequency at the satellite', () => {
		expect(transmittedMHz(receivedMHz(435.64, -6.2), -6.2)).toBeCloseTo(435.64, 9);
	});
});

describe('map geometry', () => {
	it('gives the ISS a coverage circle about 2250 km in radius', () => {
		// acos(Re / (Re + h)) = 20.25° of arc, 2250 km; above 10° elevation it shrinks to 12.5°.
		expect(footprintAngle(420)).toBeCloseTo(20.246, 2);
		expect(footprintAngle(420, 10)).toBeCloseTo(12.485, 2);
	});
	it('draws a closed coverage ring away from the poles', () => {
		const ring = footprint(44, 7, 420);
		expect(ring[0][0]).toBeCloseTo(ring.at(-1)[0], 6);
		expect(ring[0][1]).toBeCloseTo(ring.at(-1)[1], 6);
	});
	it('closes a ring around the pole along the pole', () => {
		const ring = footprint(80, 30, 800);
		expect(ring.at(-1)[0]).toBe(90);
		expect(ring.at(-2)[0]).toBe(90);
		expect(Math.abs(ring.at(-3)[1] - ring[0][1])).toBeCloseTo(360, 6);
	});
	it('traces one orbit with continuous longitudes', () => {
		const iss = tle(25544);
		expect(orbitMinutes(iss)).toBeCloseTo(92.94, 1);
		const track = groundTrack(iss, new Date('2026-11-16T21:40:00Z'), orbitMinutes(iss));
		expect(track).toHaveLength(Math.floor((orbitMinutes(iss) * 60) / 30) + 1);
		for (let i = 1; i < track.length; i++) expect(Math.abs(track[i][1] - track[i - 1][1])).toBeLessThan(10);
		expect(Math.max(...track.map(([lat]) => Math.abs(lat)))).toBeLessThan(52);
	});
});

describe('tracked satellites', () => {
	it('has an orbit for every amateur satellite', () => {
		const amateur = TRACKED_SATELLITES.filter((item) => !item.downlinks.some((downlink) => downlink.decoder === 'meteor'));
		expect(amateur.map((item) => item.name)).toEqual(['ISS', 'SO-50', 'AO-123', 'RS-44', 'FO-29', 'AO-7', 'JO-97']);
		for (const item of amateur) expect(tle(item.norad)).toBeDefined();
	});
	it('tunes linear transponders inside their passband', () => {
		for (const item of TRACKED_SATELLITES)
			for (const downlink of item.downlinks)
				if (downlink.band) {
					expect(downlink.mode).toBe('usb');
					expect(downlink.freqMHz).toBeGreaterThan(downlink.band[0]);
					expect(downlink.freqMHz).toBeLessThan(downlink.band[1]);
				}
	});
	it('names passes with the short names', () => {
		const passes = predictPasses(tles, SITE, new Date('2026-11-16T21:00:00Z'), 3);
		expect(new Set(passes.map((pass) => pass.satellite))).toEqual(new Set(['ISS', 'SO-50', 'RS-44', 'JO-97', 'AO-123']));
	});
	it.each([
		// AOS and culmination from skyfield 1.55 (find_events at 10°).
		[25544, '2026-11-16T21:37:36Z', 63.5],
		[44909, '2026-11-18T11:49:45Z', 89.9],
		[7530, '2026-11-17T06:50:31Z', 88.3],
		[27607, '2026-11-16T22:46:29Z', 76.0],
	])('matches skyfield for the %i pass rising at %s', (norad, aos, peak) => {
		const passes = predictPasses([tle(norad)], SITE, new Date('2026-11-16T21:00:00Z'), 48);
		const pass = passes.find((item) => Math.abs(item.aos.getTime() - Date.parse(aos)) < 30_000);
		expect(pass).toBeDefined();
		expect(Math.abs(pass.maxElevation - peak)).toBeLessThanOrEqual(0.5);
	});
});
