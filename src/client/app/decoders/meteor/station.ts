import type { Pass, Tle } from '@/satellites/types';
import type { MeteorStatus } from '@/worker/decoders/meteor/types';
import { METEOR_SATELLITES } from '@/satellites/catalog';
import { cachedTles } from '@/satellites/station';

/** Orbits for the Meteor pass list (see `cachedTles`). */
export function meteorTles(now: Date, fetchFn: typeof fetch = fetch): Promise<{ tles: Tle[]; note: string }> {
	return cachedTles(
		'browsdr.meteorTles',
		METEOR_SATELLITES.map((satellite) => satellite.norad),
		now,
		fetchFn,
	);
}

/** The receiver's Meteor panel state; the station location is the receiver's shared `station`. */
export function meteorPanelState() {
	return {
		panelOpen: false,
		status: [] as Array<MeteorStatus | null>,
		sources: [] as Array<{ freq: number } | null>,
		/** Bumped when image rows arrive; the pixels themselves stay outside reactivity. */
		imageVersion: 0,
		view: 'rgb' as 'rgb' | 0 | 1 | 2,
		passes: [] as Pass[],
		passMessage: '',
		tleNote: '',
		notice: '',
		armed: null as { key: string; norad: number; aos: number; los: number } | null,
		/** NORAD id of the satellite last tuned for, used to name saved images. */
		norad: 0,
	};
}
