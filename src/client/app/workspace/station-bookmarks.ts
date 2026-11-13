import stationFile from '../../../../stations/radiopi.json';
import { parseBookmarks } from './bookmark-data';
import type { Bookmark } from './types';

/** The radiopi station's bookmarks, shared with browsdr-cli; validated like an imported file. */
export const STATION_BOOKMARKS: Bookmark[] = parseBookmarks(JSON.stringify(stationFile));
