import type { AppInstance } from '@/app/core/receiver.types';
import type { Pass, SatelliteTracking, Tle, TrackedSatellite } from '@/satellites/types';
import { orbcommSatellites, TRACKED_SATELLITES } from '@/satellites/catalog';
import { predictPasses } from '@/satellites/passes';
import { cachedTinygsTles, cachedTleGroup, cachedTles, loadStation, saveStation, stationError } from '@/satellites/station';
import { tinygsSatellites } from '@/satellites/tinygs';
import { errorMessage } from '@/platform/errors';
import { startTracking, stopTracking } from './tracking';

const TLE_KEY = 'browsdr.satelliteTles';
const ORBCOMM_TLE_KEY = 'browsdr.orbcommTles';
const TINYGS_TLE_KEY = 'browsdr.tinygsTles';

/** Every satellite of the panel: the catalog, the ORBCOMM group and, when shown, TinyGS's LoRa satellites. */
export function allSatellites(state: { orbcomm: TrackedSatellite[]; lora: TrackedSatellite[]; showLora: boolean }): TrackedSatellite[] {
	return [...TRACKED_SATELLITES, ...state.orbcomm, ...(state.showLora ? state.lora : [])];
}

/** TinyGS's satellites and their orbits when the panel shows them (fetched only then). */
async function loraGroup(show: boolean, now: Date): Promise<{ tles: Tle[]; satellites: TrackedSatellite[]; note: string } | null> {
	if (!show) return null;
	const { tles, note } = await cachedTinygsTles(TINYGS_TLE_KEY, now);
	const skip = new Set(TRACKED_SATELLITES.map((satellite) => satellite.norad));
	return { ...tinygsSatellites(tles, skip), note: `TinyGS ${note.charAt(0).toLowerCase()}${note.slice(1)}` };
}

/** The receiver's satellite map state. */
export function satellitesPanelState() {
	return {
		panelOpen: false,
		tles: [] as Tle[],
		orbcomm: [] as ReturnType<typeof orbcommSatellites>,
		/** TinyGS's LoRa satellites, listed only while showLora is on. */
		lora: [] as TrackedSatellite[],
		showLora: false,
		passes: [] as Pass[],
		/** Hours of passes to predict. */
		hours: 48,
		/** Lowest culmination worth listing, in degrees. */
		minPeak: 20,
		selected: TRACKED_SATELLITES[0].norad,
		downlink: 0,
		tracking: null as SatelliteTracking | null,
		tleNote: '',
		message: '',
		notice: '',
	};
}

function refreshMessage(station: boolean, orbcommFailed: boolean, loraFailed: boolean): string {
	if (!station) return 'Set the station location for passes, pointing and Doppler.';
	if (orbcommFailed) return 'ORBCOMM orbits unavailable; other satellite passes remain visible.';
	return loraFailed ? "TinyGS's satellite list is unavailable (BrowSDR's server could not fetch it); other satellites remain visible." : '';
}

export const satelliteMethods = {
	toggleSatellitesPanel(this: AppInstance): void {
		this.satellites.panelOpen = !this.satellites.panelOpen;
		if (this.satellites.panelOpen) void this.satellitesRefresh();
	},
	async satellitesRefresh(this: AppInstance, now = new Date()): Promise<void> {
		this.station ??= loadStation();
		try {
			const [standard, group, lora] = await Promise.allSettled([
				cachedTles(
					TLE_KEY,
					TRACKED_SATELLITES.map((satellite) => satellite.norad),
					now,
				),
				cachedTleGroup(ORBCOMM_TLE_KEY, 'orbcomm', now),
				loraGroup(this.satellites.showLora, now),
			]);
			if (standard.status === 'rejected' && group.status === 'rejected') throw standard.reason;
			const orbcommTles = group.status === 'fulfilled' ? group.value.tles.filter((tle) => /^ORBCOMM\b/i.test(tle.name)) : [];
			this.satellites.orbcomm = orbcommSatellites(orbcommTles);
			const loraSet = lora.status === 'fulfilled' ? lora.value : null;
			// hidden, the list stays known: a LoRa pass being decoded keeps its name and its orbit
			if (loraSet) this.satellites.lora = loraSet.satellites;
			const decoding = this.satellites.tracking?.decode ? this.satellites.tracking.norad : NaN;
			const loraTles = loraSet?.tles ?? this.satellites.tles.filter((tle) => tle.norad === decoding);
			const known = new Set([...TRACKED_SATELLITES, ...this.satellites.orbcomm].map((satellite) => satellite.norad));
			this.satellites.tles = [
				...(standard.status === 'fulfilled' ? standard.value.tles : []),
				...orbcommTles,
				...loraTles.filter((tle) => !known.has(tle.norad)),
			];
			this.satellites.tleNote = [standard, group, lora]
				.flatMap((result) => (result.status === 'fulfilled' && result.value ? [result.value.note] : []))
				.filter((note, index, notes) => notes.indexOf(note) === index)
				.join(' · ');
			if (!allSatellites(this.satellites).some((satellite) => satellite.norad === this.satellites.selected)) {
				this.satellites.selected = TRACKED_SATELLITES[0].norad;
				this.satellites.downlink = 0;
			}
			this.satellites.passes = this.station ? predictPasses(this.satellites.tles, this.station, now, this.satellites.hours) : [];
			this.satellites.message = refreshMessage(!!this.station, group.status === 'rejected', lora.status === 'rejected');
		} catch (error) {
			this.satellites.message = errorMessage(error);
		}
	},
	/** Saves the station shared by the Meteor and satellite panels; returns the problem to show, or ''. */
	setStationLocation(this: AppInstance, lat: number, lon: number): string {
		const problem = stationError(lat, lon);
		if (problem) return problem;
		this.station = { lat, lon, altM: this.station?.altM ?? 0 };
		saveStation(this.station);
		// Digital Modes decoders that use the station (FLARM) take it with the VFO parameters
		for (const [index, vfo] of this.vfos.entries()) if (vfo.digimode) this.updateBackendVfoParams(index);
		if (this.meteor.panelOpen) void this.meteorRefreshPasses();
		if (this.satellites.panelOpen) void this.satellitesRefresh();
		return '';
	},
	locateStation(this: AppInstance): Promise<string> {
		if (!navigator.geolocation) return Promise.resolve('This browser cannot report its position; enter it by hand.');
		return new Promise((resolve) =>
			navigator.geolocation.getCurrentPosition(
				(position) => resolve(this.setStationLocation(+position.coords.latitude.toFixed(3), +position.coords.longitude.toFixed(3))),
				(error) => resolve(`Position unavailable: ${error.message}`),
			),
		);
	},
	satelliteSetLocation(this: AppInstance, lat: number, lon: number): void {
		this.satellites.notice = this.setStationLocation(lat, lon);
	},
	satelliteUseMyPosition(this: AppInstance): void {
		void this.locateStation().then((notice) => (this.satellites.notice = notice));
	},
	/** Lists TinyGS's LoRa satellites (their orbits are fetched the first time) or hides them again. */
	satelliteShowLora(this: AppInstance, show: boolean): Promise<void> {
		this.satellites.showLora = show;
		return this.satellitesRefresh();
	},
	satelliteSelect(this: AppInstance, norad: number): void {
		if (this.satellites.selected !== norad) this.satellites.downlink = 0;
		this.satellites.selected = norad;
	},
	/** Tunes the active VFO to the selected downlink with Doppler tracking; Meteor goes to its own panel. */
	async satelliteTrack(this: AppInstance, norad = this.satellites.selected, downlink = this.satellites.downlink): Promise<void> {
		const satellite = allSatellites(this.satellites).find((item) => item.norad === norad);
		if (!satellite?.downlinks[downlink]) return;
		if (satellite.downlinks[downlink]?.decoder === 'meteor') {
			stopTracking(this);
			if (await this.meteorTune()) {
				this.meteor.norad = norad;
				this.meteor.panelOpen = true;
			}
			this.satellites.notice = this.meteor.notice;
			return;
		}
		this.satellites.notice = startTracking(this, satellite, downlink, this.activeVfoIndex);
	},
	satelliteStopTracking(this: AppInstance): void {
		stopTracking(this);
		this.satellites.notice = '';
	},
};
