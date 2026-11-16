import { degreesToRadians, ecfToLookAngles, eciToEcf, gstime, propagate, twoline2satrec } from 'satellite.js';
import type { SatRec } from 'satellite.js';
import { METEOR_SATELLITES } from './catalog';
import type { Look, Pass, Site, Tle } from './types';

const STEP_MS = 30_000;
/** A Meteor pass lasts at most ~16 minutes, so a pass that is up at `from` rose less than 20 minutes earlier. */
const LOOKBACK_MS = 20 * 60_000;
const POOR_ELEVATION = 20;
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const DEGREES = 180 / Math.PI;

function lookAt(satrec: SatRec, site: Site, ms: number): Look | null {
	const time = new Date(ms);
	const state = propagate(satrec, time);
	if (!state || typeof state.position !== 'object') return null;
	const observer = { latitude: degreesToRadians(site.lat), longitude: degreesToRadians(site.lon), height: site.altM / 1000 };
	const look = ecfToLookAngles(observer, eciToEcf(state.position, gstime(time)));
	return { elevation: look.elevation * DEGREES, azimuth: (((look.azimuth * DEGREES) % 360) + 360) % 360 };
}

const elevationAt = (satrec: SatRec, site: Site, ms: number) => lookAt(satrec, site, ms)?.elevation ?? -90;

/** The instant (to 1 s) between `below` and `above` where the elevation crosses `limit`. */
function crossing(satrec: SatRec, site: Site, below: number, above: number, limit: number): number {
	let [lo, hi] = [below, above];
	while (Math.abs(hi - lo) > 1000) {
		const mid = (lo + hi) / 2;
		if (elevationAt(satrec, site, mid) >= limit) hi = mid;
		else lo = mid;
	}
	return Math.round(hi / 1000) * 1000;
}

/** Highest point between AOS and LOS (the elevation curve has a single maximum there). */
function culmination(satrec: SatRec, site: Site, aos: number, los: number): number {
	const ratio = (Math.sqrt(5) - 1) / 2;
	let [a, b] = [aos, los];
	while (b - a > 1000) {
		const c = b - ratio * (b - a);
		const d = a + ratio * (b - a);
		if (elevationAt(satrec, site, c) > elevationAt(satrec, site, d)) b = d;
		else a = c;
	}
	return Math.round((a + b) / 2000) * 1000;
}

function buildPass(tle: Tle, satrec: SatRec, site: Site, aos: number, los: number, from: number): Pass {
	const tca = culmination(satrec, site, aos, los);
	const maxElevation = elevationAt(satrec, site, tca);
	const known = METEOR_SATELLITES.find((satellite) => satellite.norad === tle.norad);
	return {
		satellite: known?.name ?? tle.name,
		norad: tle.norad,
		aos: new Date(aos),
		tca: new Date(tca),
		los: new Date(los),
		maxElevation,
		aosAzimuth: lookAt(satrec, site, aos)?.azimuth ?? 0,
		losAzimuth: lookAt(satrec, site, los)?.azimuth ?? 0,
		inProgress: aos < from && los > from,
		poor: maxElevation < POOR_ELEVATION,
	};
}

function satellitePasses(tle: Tle, site: Site, from: number, until: number, minElevation: number): Pass[] {
	const satrec = twoline2satrec(tle.line1, tle.line2);
	const passes: Pass[] = [];
	let previous = from - LOOKBACK_MS;
	let up = elevationAt(satrec, site, previous) >= minElevation;
	let aos: number | null = null; // a pass already up at the lookback start has no known AOS and is skipped
	for (let t = previous + STEP_MS; t <= until + LOOKBACK_MS; t += STEP_MS) {
		const nowUp = elevationAt(satrec, site, t) >= minElevation;
		if (nowUp && !up) {
			if (previous > until) break;
			aos = crossing(satrec, site, previous, t, minElevation);
		} else if (!nowUp && up && aos !== null) {
			const los = crossing(satrec, site, t, previous, minElevation);
			if (los > from) passes.push(buildPass(tle, satrec, site, aos, los, from));
			aos = null;
		}
		up = nowUp;
		previous = t;
	}
	return passes;
}

/** Passes of every TLE over `site` that are up at `from` or rise within `hours` of it, sorted by AOS. */
export function predictPasses(tles: readonly Tle[], site: Site | null, from: Date, hours: number, minElevation = 10): Pass[] {
	if (!site) throw new Error('Set the station location first.');
	const start = from.getTime();
	return tles
		.flatMap((tle) => satellitePasses(tle, site, start, start + hours * 3600e3, minElevation))
		.sort((a, b) => a.aos.getTime() - b.aos.getTime());
}

export function azimuthName(degrees: number): string {
	return COMPASS[Math.floor((((degrees % 360) + 360 + 22.5) % 360) / 45)];
}
