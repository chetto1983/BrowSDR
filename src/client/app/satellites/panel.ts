import { computed, defineComponent, inject, onBeforeUnmount, ref, watch } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import * as components from '@/ui';
import { formatKHz, formatMHz, pointing, useSatelliteLive } from './live';
import { useSatelliteMap } from './map-view';
import template from './panel.html?raw';

const TRACK_REFRESH_MS = 15_000;

export default defineComponent({
	name: 'SatellitesPanel',
	template,
	components,
	setup() {
		const receiver = inject<AppInstance>('receiver');
		if (!receiver) throw new Error('SatellitesPanel requires a receiver');
		const state = receiver.satellites;
		const now = ref(new Date());
		const trackFrom = ref(new Date());
		const showMap = ref(true);
		const mapElement = ref<HTMLElement>();
		const error = ref('');
		const passFilter = ref(0);
		const latitude = ref(receiver.station?.lat ?? '');
		const longitude = ref(receiver.station?.lon ?? '');
		// Only an open panel ticks; positions are not computed while it is closed.
		const clock = setInterval(() => {
			if (state.panelOpen) now.value = new Date();
		}, 1000);
		const trackClock = setInterval(() => {
			if (state.panelOpen) trackFrom.value = new Date();
		}, TRACK_REFRESH_MS);
		onBeforeUnmount(() => {
			clearInterval(clock);
			clearInterval(trackClock);
		});
		watch(
			() => state.panelOpen,
			(open) => {
				if (open) now.value = trackFrom.value = new Date();
			},
		);
		watch(
			() => receiver.station,
			(site) => {
				if (!site) return;
				latitude.value = site.lat;
				longitude.value = site.lon;
			},
		);
		watch(
			() => state.hours,
			() => void receiver.satellitesRefresh(),
		);
		watch([passFilter, () => state.orbcomm.length], ([filter]) => {
			if (filter === -1 && state.orbcomm.length) receiver.satelliteSelect(state.orbcomm[0].norad);
		});
		const live = useSatelliteLive(receiver, now, trackFrom, passFilter);
		const map = useSatelliteMap(receiver, showMap, mapElement, live.mapSatellites, live.selection, error);

		return {
			receiver,
			state,
			showMap,
			mapElement,
			error,
			latitude,
			longitude,
			passFilter,
			...live,
			...map,
			passList: computed(() => {
				const orbcommIds = new Set(state.orbcomm.map((satellite) => satellite.norad));
				return live.upcoming.value.filter(
					(row) => !passFilter.value || (passFilter.value === -1 ? orbcommIds.has(row.pass.norad) : row.pass.norad === passFilter.value),
				);
			}),
			pointing,
			formatMHz,
			formatKHz,
			setLocation: () => receiver.satelliteSetLocation(Number(latitude.value), Number(longitude.value)),
		};
	},
});
