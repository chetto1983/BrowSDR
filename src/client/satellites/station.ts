import type { Site, Tle } from './types';
import { fetchTleGroup, fetchTles, TleCache } from './tle';
import { errorMessage } from '@/platform/errors';

const STATION_KEY = 'browsdr.station';

export const browserStorage = (): Storage | null => {
	try {
		return globalThis.localStorage ?? null;
	} catch {
		return null;
	}
};

/** The station location saved in this browser, if any; Meteor and the satellite map share it. */
export function loadStation(): Site | null {
	try {
		const raw = browserStorage()?.getItem(STATION_KEY);
		const value: unknown = raw ? JSON.parse(raw) : null;
		if (!value || typeof value !== 'object') return null;
		const { lat, lon, altM } = value as Record<string, unknown>;
		if (typeof lat !== 'number' || typeof lon !== 'number' || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
		return { lat, lon, altM: typeof altM === 'number' ? altM : 0 };
	} catch {
		return null;
	}
}

export function saveStation(site: Site): void {
	try {
		browserStorage()?.setItem(STATION_KEY, JSON.stringify(site));
	} catch {
		/* Storage may be blocked; the location still applies to this session. */
	}
}

/** A valid latitude/longitude pair in degrees, or the message to show for it. */
export function stationError(lat: number, lon: number): string {
	return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
		? ''
		: 'Enter latitude (-90 to 90) and longitude (-180 to 180) in degrees.';
}

/**
 * Orbits for a set of satellites: the cached TLEs, refreshed from Celestrak when they are two days old (or a
 * satellite is missing) and the network allows. In the field without internet the cache keeps working; TLEs
 * stay usable for about a week.
 */
export async function cachedTles(
	storageKey: string,
	norads: readonly number[],
	now: Date,
	fetchFn: typeof fetch = fetch,
): Promise<{ tles: Tle[]; note: string }> {
	const cache = new TleCache(browserStorage(), storageKey);
	const cached = cache.get();
	const complete = !!cached && norads.every((norad) => cached.tles.some((tle) => tle.norad === norad));
	if (cached && complete && !cache.stale(now)) return { tles: cached.tles, note: `Orbits from ${cached.fetchedAt.toLocaleDateString()}` };
	try {
		const tles = await fetchTles(norads, fetchFn);
		cache.put(tles, now);
		return { tles, note: `Orbits from ${now.toLocaleDateString()}` };
	} catch (error) {
		if (cached) return { tles: cached.tles, note: `Orbits from ${cached.fetchedAt.toLocaleDateString()} (offline)` };
		throw new Error(`No orbit data yet: connect to the internet once. (${errorMessage(error)})`, { cause: error });
	}
}

/** One Celestrak constellation, cached separately from the fixed satellite catalog. */
export async function cachedTleGroup(
	storageKey: string,
	group: string,
	now: Date,
	fetchFn: typeof fetch = fetch,
): Promise<{ tles: Tle[]; note: string }> {
	const cache = new TleCache(browserStorage(), storageKey);
	const cached = cache.get();
	if (cached && !cache.stale(now)) return { tles: cached.tles, note: `Orbits from ${cached.fetchedAt.toLocaleDateString()}` };
	try {
		const tles = await fetchTleGroup(group, fetchFn);
		cache.put(tles, now);
		return { tles, note: `Orbits from ${now.toLocaleDateString()}` };
	} catch (error) {
		if (cached) return { tles: cached.tles, note: `Orbits from ${cached.fetchedAt.toLocaleDateString()} (offline)` };
		throw error;
	}
}
