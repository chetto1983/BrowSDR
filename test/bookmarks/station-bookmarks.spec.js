import { describe, expect, it } from 'vitest';
import { seedStationBookmarks } from '@/app/workspace/bookmark-data';
import { STATION_BOOKMARKS } from '@/app/workspace/station-bookmarks';

const station = (id, freq) => ({ id, type: 'individual', name: id, freq, mode: 'am' });

describe('station bookmarks', () => {
	it('ships a station file that passes the import validation', () => {
		expect(STATION_BOOKMARKS.length).toBeGreaterThan(0);
		expect(STATION_BOOKMARKS.every((bookmark) => bookmark.id?.startsWith('radiopi-'))).toBe(true);
	});

	it('adds station bookmarks the browser has never seen', () => {
		const mine = { id: 'mine', type: 'individual', name: 'Mine', freq: 99, mode: 'wfm' };
		const result = seedStationBookmarks([mine], [station('a', 120), station('b', 132)], []);
		expect(result.bookmarks.map((bookmark) => bookmark.id)).toEqual(['mine', 'a', 'b']);
		expect(result.seededIds).toEqual(['a', 'b']);
	});

	it('does not bring back a station bookmark the user deleted', () => {
		const result = seedStationBookmarks([], [station('a', 120), station('b', 132)], ['a', 'b']);
		expect(result.bookmarks).toEqual([]);
	});

	it('keeps the user edits of a station bookmark already present', () => {
		const edited = { ...station('a', 120), name: 'Renamed' };
		const result = seedStationBookmarks([edited], [station('a', 120), station('c', 144)], []);
		expect(result.bookmarks).toEqual([edited, station('c', 144)]);
		expect(result.seededIds).toEqual(['a', 'c']);
	});
});
