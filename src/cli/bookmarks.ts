import type { Bookmark } from '@/app/workspace/types';
import type { BookmarkDecode, BookmarkSummary, DecoderName } from './types';

const DECODER_FLAGS: DecoderName[] = ['adsb', 'rtl433', 'radiosonde', 'meteor'];

function decoderOf(vfo: Partial<Record<DecoderName, unknown>> | undefined): DecoderName | undefined {
	return DECODER_FLAGS.find((flag) => vfo?.[flag] === true);
}

/** Exact id or name first, then a case-insensitive substring of either; anything else is an error. */
function findBookmark(bookmarks: Bookmark[], query: string): Bookmark {
	const exact = bookmarks.filter((bookmark) => bookmark.id === query || bookmark.name === query);
	const needle = query.toLowerCase();
	const matches = exact.length
		? exact
		: bookmarks.filter((bookmark) => `${bookmark.id ?? ''}\n${bookmark.name}`.toLowerCase().includes(needle));
	if (matches.length === 1) return matches[0];
	if (!matches.length) throw new Error(`No bookmark matches "${query}". List them with: bookmarks`);
	throw new Error(`"${query}" matches ${matches.map((bookmark) => bookmark.id ?? bookmark.name).join(', ')}; be more specific.`);
}

/** Resolves a station bookmark to the decoder it runs and the tuning it stores. */
export function bookmarkDecode(bookmarks: Bookmark[], query: string): BookmarkDecode {
	const bookmark = findBookmark(bookmarks, query);
	const vfo = bookmark.type === 'group' ? bookmark.vfos?.[bookmark.activeVfoIndex ?? 0] : undefined;
	const decoder = decoderOf(vfo);
	if (!vfo || !decoder) throw new Error(`Bookmark "${bookmark.name}" has no decoder; it is for listening in the app.`);
	return {
		decoder,
		options: {
			freq: vfo.freq,
			...(bookmark.centerFreq !== undefined ? { center: bookmark.centerFreq } : {}),
			...(bookmark.sampleRate !== undefined ? { rate: bookmark.sampleRate } : {}),
			...(decoder === 'rtl433' && vfo.rtl433Protocols ? { protocols: vfo.rtl433Protocols } : {}),
		},
	};
}

/** One row of `bookmarks`: what Claude needs to pick one. */
export function describeBookmark(bookmark: Bookmark): BookmarkSummary {
	const vfo = bookmark.type === 'group' ? bookmark.vfos?.[bookmark.activeVfoIndex ?? 0] : undefined;
	const decoder = decoderOf(vfo);
	return {
		id: bookmark.id ?? '',
		name: bookmark.name,
		freq_mhz: (vfo ? vfo.freq : bookmark.freq) ?? 0,
		use: decoder ? `decode ${decoder}` : (vfo?.mode ?? bookmark.mode ?? ''),
	};
}
