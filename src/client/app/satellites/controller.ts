import type { AppInstance } from '@/app/core/receiver.types';
import type { Pass, SatelliteTracking, Tle } from '@/satellites/types';
import { orbcommSatellites, TRACKED_SATELLITES } from '@/satellites/catalog';
import { predictPasses } from '@/satellites/passes';
import { cachedTleGroup, cachedTles, loadStation, saveStation, stationError } from '@/satellites/station';
import { errorMessage } from '@/platform/errors';
import { startTracking, stopTracking } from './tracking';

const TLE_KEY = 'browsdr.satelliteTles';
const ORBCOMM_TLE_KEY = 'browsdr.orbcommTles';

/** The receiver's satellite map state. */
export function satellitesPanelState() {
	return {
		panelOpen: false,
		tles: [] as Tle[],
		orbcomm: [] as ReturnType<typeof orbcommSatellites>,
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

export const satelliteMethods = {
	toggleSatellitesPanel(this: AppInstance): void {
		this.satellites.panelOpen = !this.satellites.panelOpen;
		if (this.satellites.panelOpen) void this.satellitesRefresh();
	},
	async satellitesRefresh(this: AppInstance, now = new Date()): Promise<void> {
		this.station ??= loadStation();
		try {
			const [standard, group] = await Promise.allSettled([
				cachedTles(
					TLE_KEY,
					TRACKED_SATELLITES.map((satellite) => satellite.norad),
					now,
				),
				cachedTleGroup(ORBCOMM_TLE_KEY, 'orbcomm', now),
			]);
			if (standard.status === 'rejected' && group.status === 'rejected') throw standard.reason;
			const orbcommTles = group.status === 'fulfilled' ? group.value.tles.filter((tle) => /^ORBCOMM\b/i.test(tle.name)) : [];
			this.satellites.orbcomm = orbcommSatellites(orbcommTles);
			this.satellites.tles = [...(standard.status === 'fulfilled' ? standard.value.tles : []), ...orbcommTles];
			this.satellites.tleNote = [standard, group]
				.filter((result) => result.status === 'fulfilled')
				.map((result) => result.value.note)
				.filter((note, index, notes) => notes.indexOf(note) === index)
				.join(' · ');
			if (![...TRACKED_SATELLITES, ...this.satellites.orbcomm].some((satellite) => satellite.norad === this.satellites.selected)) {
				this.satellites.selected = TRACKED_SATELLITES[0].norad;
				this.satellites.downlink = 0;
			}
			this.satellites.passes = this.station ? predictPasses(this.satellites.tles, this.station, now, this.satellites.hours) : [];
			this.satellites.message = !this.station
				? 'Set the station location for passes, pointing and Doppler.'
				: group.status === 'rejected'
					? 'ORBCOMM orbits unavailable; other satellite passes remain visible.'
					: '';
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
	satelliteSelect(this: AppInstance, norad: number): void {
		if (this.satellites.selected !== norad) this.satellites.downlink = 0;
		this.satellites.selected = norad;
	},
	/** Tunes the active VFO to the selected downlink with Doppler tracking; Meteor goes to its own panel. */
	async satelliteTrack(this: AppInstance, norad = this.satellites.selected, downlink = this.satellites.downlink): Promise<void> {
		const satellite = [...TRACKED_SATELLITES, ...this.satellites.orbcomm].find((item) => item.norad === norad);
		if (!satellite) return;
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
