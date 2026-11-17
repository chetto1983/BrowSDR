import type { StoredTles, Tle } from './types';

const CELESTRAK = 'https://celestrak.org/NORAD/elements/gp.php';
const METEOR_STORAGE_KEY = 'browsdr.meteorTles';
const STALE_MS = 2 * 24 * 3600e3;

/** TLE epoch field (line 1, columns 19-32): two-digit year, then day of year with its fraction. */
function tleEpoch(line1: string): Date {
	const year = Number(line1.slice(18, 20));
	const day = Number(line1.slice(20, 32));
	const start = Date.UTC(year < 57 ? 2000 + year : 1900 + year, 0, 1);
	return new Date(start + (day - 1) * 86400e3);
}

/** Parses three-line element sets (name, line 1, line 2); anything else is skipped. */
export function parseTle(text: string): Tle[] {
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter(Boolean);
	const tles: Tle[] = [];
	for (let i = 0; i + 2 < lines.length; i++) {
		const [name, line1, line2] = [lines[i], lines[i + 1], lines[i + 2]];
		if (/^[12] /.test(name) || !line1.startsWith('1 ') || !line2.startsWith('2 ')) continue;
		tles.push({ name: name.trim(), norad: Number(line1.slice(2, 7)), line1, line2, epoch: tleEpoch(line1) });
		i += 2;
	}
	return tles;
}

/** Current TLEs for each NORAD id from Celestrak (it allows cross-origin requests). */
export async function fetchTles(norads: readonly number[], fetchFn: typeof fetch = fetch): Promise<Tle[]> {
	const sets = await Promise.all(
		norads.map(async (norad) => {
			const response = await fetchFn(`${CELESTRAK}?CATNR=${norad}&FORMAT=TLE`);
			if (!response.ok) throw new Error(`Celestrak returned HTTP ${response.status} for ${norad}.`);
			const tles = parseTle(await response.text());
			if (!tles.length) throw new Error(`Celestrak sent no orbit for ${norad}.`);
			return tles;
		}),
	);
	return sets.flat();
}

/** Current members of a Celestrak satellite group, fetched in one request. */
export async function fetchTleGroup(group: string, fetchFn: typeof fetch = fetch): Promise<Tle[]> {
	const response = await fetchFn(`${CELESTRAK}?GROUP=${encodeURIComponent(group)}&FORMAT=TLE`);
	if (!response.ok) throw new Error(`Celestrak returned HTTP ${response.status} for ${group}.`);
	const tles = parseTle(await response.text());
	if (!tles.length) throw new Error(`Celestrak sent no orbits for ${group}.`);
	return tles;
}

/** TLEs kept per browser so predictions also work offline in the field; refetched after two days. */
export class TleCache {
	constructor(
		private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null,
		private readonly key = METEOR_STORAGE_KEY,
	) {}

	get(): { tles: Tle[]; fetchedAt: Date } | null {
		try {
			const raw = this.storage?.getItem(this.key);
			if (!raw) return null;
			const stored = JSON.parse(raw) as StoredTles;
			return { fetchedAt: new Date(stored.fetchedAt), tles: stored.tles.map((tle) => ({ ...tle, epoch: new Date(tle.epoch) })) };
		} catch {
			return null;
		}
	}

	put(tles: Tle[], at: Date): void {
		const stored: StoredTles = { fetchedAt: at.toISOString(), tles: tles.map((tle) => ({ ...tle, epoch: tle.epoch.toISOString() })) };
		try {
			this.storage?.setItem(this.key, JSON.stringify(stored));
		} catch {
			/* Storage may be full or blocked; the fresh TLEs still serve this session. */
		}
	}

	stale(now: Date): boolean {
		const cached = this.get();
		return !cached || now.getTime() - cached.fetchedAt.getTime() > STALE_MS;
	}
}
