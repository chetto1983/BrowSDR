import {
	degreesToRadians,
	ecfToLookAngles,
	eciToEcf,
	eciToGeodetic,
	geodeticToEcf,
	gstime,
	jday,
	propagate,
	sunPos,
	twoline2satrec,
} from 'satellite.js';
import type { EcfVec3, EciVec3, GeodeticLocation, Kilometer, SatRec } from 'satellite.js';
import type { LatLon, OrbitState, Site, Tle } from './types';

const DEGREES = 180 / Math.PI;
const EARTH_RADIUS_KM = 6378.137;
const LIGHT_KM_S = 299_792.458;
const MAX_CACHED_ORBITS = 64;

const satrecs = new Map<string, SatRec>();

/** Parsed orbit for a TLE, reused while the TLE stays the same and kept outside Vue reactivity. */
export function satrecFor(tle: Tle): SatRec {
	const key = tle.line1 + tle.line2;
	let satrec = satrecs.get(key);
	if (!satrec) {
		if (satrecs.size >= MAX_CACHED_ORBITS) satrecs.clear();
		satrec = twoline2satrec(tle.line1, tle.line2);
		satrecs.set(key, satrec);
	}
	return satrec;
}

function eciAt(satrec: SatRec, time: Date): EciVec3<Kilometer> | null {
	const state = propagate(satrec, time);
	return state && typeof state.position === 'object' ? state.position : null;
}

const observerOf = (site: Site): GeodeticLocation => ({
	latitude: degreesToRadians(site.lat),
	longitude: degreesToRadians(site.lon),
	height: site.altM / 1000,
});

const normalizeLongitude = (longitude: number) => ((((longitude + 180) % 360) + 360) % 360) - 180;
/** `longitude` moved by whole turns to within 180° of `previous`, so lines do not jump across the map at ±180°. */
const unwrap = (longitude: number, previous: number) => longitude + 360 * Math.round((previous - longitude) / 360);

function rangeKm(satrec: SatRec, observer: EcfVec3<Kilometer>, ms: number): number | null {
	const time = new Date(ms);
	const position = eciAt(satrec, time);
	if (!position) return null;
	const satellite = eciToEcf(position, gstime(time));
	return Math.hypot(satellite.x - observer.x, satellite.y - observer.y, satellite.z - observer.z);
}

/** Direction, distance and range rate (positive while receding) seen from the station. */
function lookFrom(satrec: SatRec, site: Site, position: EciVec3<Kilometer>, time: Date): NonNullable<OrbitState['look']> {
	const observer = observerOf(site);
	const look = ecfToLookAngles(observer, eciToEcf(position, gstime(time)));
	const ecf = geodeticToEcf(observer);
	// Central difference over one second: within a few mm/s of the analytic rate, far below what tuning resolves.
	const before = rangeKm(satrec, ecf, time.getTime() - 500);
	const after = rangeKm(satrec, ecf, time.getTime() + 500);
	return {
		elevation: look.elevation * DEGREES,
		azimuth: (((look.azimuth * DEGREES) % 360) + 360) % 360,
		rangeKm: look.rangeSat,
		rangeRateKmS: before !== null && after !== null ? after - before : 0,
	};
}

/** Whether the satellite is outside Earth's shadow (cylindrical shadow; the penumbra lasts only seconds in LEO). */
export function isSunlit(position: EciVec3<Kilometer>, time: Date): boolean {
	const sun = sunPos(jday(time)).rsun;
	const length = Math.hypot(sun[0], sun[1], sun[2]);
	const [x, y, z] = [sun[0] / length, sun[1] / length, sun[2] / length];
	const along = position.x * x + position.y * y + position.z * z;
	if (along > 0) return true;
	return Math.hypot(position.x - along * x, position.y - along * y, position.z - along * z) > EARTH_RADIUS_KM;
}

/** Where the satellite is at `time`, and how it looks from `site` when one is set. */
export function orbitState(tle: Tle, site: Site | null, time: Date): OrbitState | null {
	const satrec = satrecFor(tle);
	const position = eciAt(satrec, time);
	if (!position) return null;
	const ground = eciToGeodetic(position, gstime(time));
	return {
		norad: tle.norad,
		latitude: ground.latitude * DEGREES,
		longitude: normalizeLongitude(ground.longitude * DEGREES),
		altitudeKm: ground.height,
		sunlit: isSunlit(position, time),
		look: site ? lookFrom(satrec, site, position, time) : null,
	};
}

/** Frequency heard on the ground for a downlink sent on `freqMHz` by a satellite receding at `rangeRateKmS`. */
export const receivedMHz = (freqMHz: number, rangeRateKmS: number): number => freqMHz * (1 - rangeRateKmS / LIGHT_KM_S);

/** The inverse of `receivedMHz`: the frequency at the satellite for one heard on the ground. */
export const transmittedMHz = (heardMHz: number, rangeRateKmS: number): number => heardMHz / (1 - rangeRateKmS / LIGHT_KM_S);

/** Orbital period in minutes (SGP4 keeps the mean motion in radians per minute). */
export const orbitMinutes = (tle: Tle): number => (2 * Math.PI) / satrecFor(tle).no;

/** Sub-satellite points from `from` for `minutes`, with continuous longitudes. */
export function groundTrack(tle: Tle, from: Date, minutes: number, stepSeconds = 30): LatLon[] {
	const satrec = satrecFor(tle);
	const points: LatLon[] = [];
	for (let seconds = 0; seconds <= minutes * 60; seconds += stepSeconds) {
		const time = new Date(from.getTime() + seconds * 1000);
		const position = eciAt(satrec, time);
		if (!position) break;
		const ground = eciToGeodetic(position, gstime(time));
		const longitude = ground.longitude * DEGREES;
		points.push([ground.latitude * DEGREES, points.length ? unwrap(longitude, points[points.length - 1][1]) : longitude]);
	}
	return points;
}

/** Earth central angle, in degrees, from the sub-satellite point to where the satellite stands at `minElevation`. */
export function footprintAngle(altitudeKm: number, minElevation = 0): number {
	const elevation = minElevation / DEGREES;
	return (Math.acos((EARTH_RADIUS_KM / (EARTH_RADIUS_KM + altitudeKm)) * Math.cos(elevation)) - elevation) * DEGREES;
}

/**
 * The area that sees the satellite above `minElevation`, as a ring with continuous longitudes. A ring around a
 * pole is closed along the pole so the map fills the polar cap.
 */
export function footprint(latitude: number, longitude: number, altitudeKm: number, minElevation = 0, steps = 90): LatLon[] {
	const angle = footprintAngle(altitudeKm, minElevation) / DEGREES;
	const lat1 = latitude / DEGREES;
	const ring: LatLon[] = [];
	for (let i = 0; i <= steps; i++) {
		const bearing = (2 * Math.PI * i) / steps;
		const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angle) + Math.cos(lat1) * Math.sin(angle) * Math.cos(bearing));
		const dLon = Math.atan2(Math.sin(bearing) * Math.sin(angle) * Math.cos(lat1), Math.cos(angle) - Math.sin(lat1) * Math.sin(lat2));
		const lon2 = longitude + dLon * DEGREES;
		ring.push([lat2 * DEGREES, ring.length ? unwrap(lon2, ring[ring.length - 1][1]) : lon2]);
	}
	const [first, last] = [ring[0], ring[ring.length - 1]];
	if (Math.abs(last[1] - first[1]) > 180) {
		const pole = latitude > 0 ? 90 : -90;
		ring.push([pole, last[1]], [pole, first[1]]);
	}
	return ring;
}
