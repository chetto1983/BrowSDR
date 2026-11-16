import type { Pass, Site, Tle } from '@/satellites/types';
import type { MeteorStatus } from '@/worker/decoders/meteor/types';
import { METEOR_SATELLITES } from '@/satellites/catalog';
import { fetchTles, TleCache } from '@/satellites/tle';
import { errorMessage } from '@/platform/errors';

const STATION_KEY = 'browsdr.station';

const storage = (): Storage | null => {
	try {
		return globalThis.localStorage ?? null;
	} catch {
		return null;
	}
};

/** The station location saved in this browser, if any. */
export function loadStation(): Site | null {
	try {
		const raw = storage()?.getItem(STATION_KEY);
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
		storage()?.setItem(STATION_KEY, JSON.stringify(site));
	} catch {
		/* Storage may be blocked; the location still applies to this session. */
	}
}

/**
 * Orbits for the pass list: the cached TLEs, refreshed from Celestrak when they are two days old and the
 * network allows. In the field without internet the cache keeps working (TLEs are good for about a week).
 */
export async function meteorTles(now: Date, fetchFn: typeof fetch = fetch): Promise<{ tles: Tle[]; note: string }> {
	const cache = new TleCache(storage());
	const cached = cache.get();
	if (cached && !cache.stale(now)) return { tles: cached.tles, note: `Orbits from ${cached.fetchedAt.toLocaleDateString()}` };
	try {
		const tles = await fetchTles(
			METEOR_SATELLITES.map((satellite) => satellite.norad),
			fetchFn,
		);
		cache.put(tles, now);
		return { tles, note: `Orbits from ${now.toLocaleDateString()}` };
	} catch (error) {
		if (cached) return { tles: cached.tles, note: `Orbits from ${cached.fetchedAt.toLocaleDateString()} (offline)` };
		throw new Error(`No orbit data yet: connect to the internet once. (${errorMessage(error)})`, { cause: error });
	}
}

/** The receiver's Meteor panel state. */
export function meteorPanelState() {
	return {
		panelOpen: false,
		status: [] as Array<MeteorStatus | null>,
		sources: [] as Array<{ freq: number } | null>,
		/** Bumped when image rows arrive; the pixels themselves stay outside reactivity. */
		imageVersion: 0,
		view: 'rgb' as 'rgb' | 0 | 1 | 2,
		site: loadStation(),
		passes: [] as Pass[],
		passMessage: '',
		tleNote: '',
		notice: '',
		armed: null as { key: string; norad: number; aos: number; los: number } | null,
		/** NORAD id of the satellite last tuned for, used to name saved images. */
		norad: 0,
	};
}
