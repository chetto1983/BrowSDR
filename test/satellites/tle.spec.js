import { describe, expect, it } from 'vitest';
import { fetchTles, parseTle, TleCache } from '@/satellites/tle';
import { METEOR_TLE } from './fixtures';

function memoryStorage() {
	const data = new Map();
	return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)) };
}

describe('TLEs', () => {
	it('parses three-line sets', () => {
		const tles = parseTle(METEOR_TLE);
		expect(tles.map((tle) => [tle.name, tle.norad])).toEqual([
			['METEOR-M2 3', 57166],
			['METEOR-M2 4', 59051],
		]);
		expect(tles[0].epoch.toISOString().slice(0, 10)).toBe('2026-11-15');
	});
	it('fetches each satellite from Celestrak', async () => {
		const urls = [];
		const blocks = METEOR_TLE.trim().split('\n');
		const fetchFn = async (url) => {
			urls.push(url);
			const lines = url.includes('57166') ? blocks.slice(0, 3) : blocks.slice(3);
			return new Response(lines.join('\n'));
		};
		const tles = await fetchTles([57166, 59051], fetchFn);
		expect(tles.map((tle) => tle.norad)).toEqual([57166, 59051]);
		expect(urls[0]).toBe('https://celestrak.org/NORAD/elements/gp.php?CATNR=57166&FORMAT=TLE');
	});
	it('rejects when Celestrak cannot be reached', async () => {
		await expect(fetchTles([57166], async () => Promise.reject(new TypeError('offline')))).rejects.toThrow();
	});
	it('caches TLEs and goes stale after two days', () => {
		const cache = new TleCache(memoryStorage());
		const at = new Date('2026-11-16T07:00:00Z');
		expect(cache.get()).toBeNull();
		cache.put(parseTle(METEOR_TLE), at);
		const cached = cache.get();
		expect(cached.tles).toHaveLength(2);
		expect(cached.tles[1].epoch).toBeInstanceOf(Date);
		expect(cached.fetchedAt.toISOString()).toBe(at.toISOString());
		expect(cache.stale(new Date(at.getTime() + 47 * 3600e3))).toBe(false);
		expect(cache.stale(new Date(at.getTime() + 49 * 3600e3))).toBe(true);
	});
	it('works without storage', () => {
		const cache = new TleCache(null);
		expect(() => cache.put(parseTle(METEOR_TLE), new Date())).not.toThrow();
		expect(cache.get()).toBeNull();
		expect(cache.stale(new Date())).toBe(true);
	});
});
