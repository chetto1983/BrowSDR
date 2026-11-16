import { computed, type Ref } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import type { OrbitState } from '@/satellites/types';
import { TRACKED_SATELLITES } from '@/satellites/catalog';
import { passRows } from '@/satellites/format';
import { azimuthName } from '@/satellites/passes';
import { footprint, groundTrack, orbitMinutes, orbitState, receivedMHz } from '@/satellites/orbit';
import type { MapSatellite, SatelliteRow } from './types';

export const formatMHz = (mhz: number) => `${mhz.toFixed(4)} MHz`;
export const formatKHz = (hz: number) => `${hz >= 0 ? '+' : '−'}${Math.abs(hz / 1000).toFixed(1)} kHz`;

/** Azimuth and elevation from the station, e.g. "312° NW · 41°". */
export function pointing(state: OrbitState | null): string {
	const look = state?.look;
	if (!look) return '—';
	return `${Math.round(look.azimuth)}° ${azimuthName(look.azimuth)} · ${Math.round(look.elevation)}°`;
}

/** The tracking summary line, or '' while nothing is tracked. */
function trackingText(receiver: AppInstance): string {
	const active = receiver.satellites.tracking;
	const satellite = TRACKED_SATELLITES.find((item) => item.norad === active?.norad);
	const vfo = active ? receiver.vfos[active.vfoIndex] : undefined;
	if (!active || !satellite || !vfo) return '';
	const label = satellite.downlinks[active.downlink]?.label ?? '';
	return `Tracking ${satellite.name} ${label} on VFO ${active.vfoIndex + 1} · ${formatMHz(vfo.freq)} · Doppler ${formatKHz(active.dopplerHz)}`;
}

/**
 * Positions, pointing and Doppler of every satellite at `now`, and the selected satellite's next orbit from
 * `trackFrom` (refreshed less often: the marker moves along it).
 */
export function useSatelliteLive(receiver: AppInstance, now: Ref<Date>, trackFrom: Ref<Date>) {
	const state = receiver.satellites;
	const states = computed(() => {
		if (!state.panelOpen) return new Map<number, OrbitState>();
		const entries = state.tles.map((tle) => [tle.norad, orbitState(tle, receiver.station, now.value)] as const);
		return new Map(entries.filter((entry): entry is [number, OrbitState] => entry[1] !== null));
	});
	const upcoming = computed(() =>
		passRows(
			state.passes.filter((pass) => pass.maxElevation >= state.minPeak),
			now.value,
		),
	);
	const rows = computed<SatelliteRow[]>(() =>
		TRACKED_SATELLITES.map((satellite) => ({
			satellite,
			state: states.value.get(satellite.norad) ?? null,
			next: upcoming.value.find((row) => row.pass.norad === satellite.norad),
		})),
	);
	const selected = computed(() => rows.value.find((row) => row.satellite.norad === state.selected) ?? rows.value[0]);
	const downlink = computed(() => selected.value.satellite.downlinks[state.downlink] ?? selected.value.satellite.downlinks[0]);
	const heard = computed(() => {
		const look = selected.value.state?.look;
		if (!look || downlink.value.decoder) return null;
		const freq = receivedMHz(downlink.value.freqMHz, look.rangeRateKmS);
		return { freq, shiftHz: (freq - downlink.value.freqMHz) * 1e6 };
	});
	const mapSatellites = computed<MapSatellite[]>(() =>
		rows.value.flatMap((row) => (row.state ? [{ name: row.satellite.name, state: row.state }] : [])),
	);
	const selection = computed(() => {
		const tle = state.tles.find((item) => item.norad === state.selected);
		const current = selected.value.state;
		if (!tle || !current) return { track: [], coverage: [] };
		return {
			track: groundTrack(tle, trackFrom.value, orbitMinutes(tle)),
			coverage: footprint(current.latitude, current.longitude, current.altitudeKm),
		};
	});
	return {
		rows,
		upcoming,
		selected,
		downlink,
		heard,
		mapSatellites,
		selection,
		tracking: computed(() => trackingText(receiver)),
		visible: computed(() => rows.value.filter((row) => (row.state?.look?.elevation ?? -90) > 0).length),
	};
}
