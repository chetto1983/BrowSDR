import { computed, defineComponent, inject, onBeforeUnmount, ref, watch } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import * as components from '@/ui';
import { isLoraSat } from '@/worker/decoders/digimode/lora-sat/catalog';
import { formatKHz, formatMHz, groupIds, pointing, useSatelliteLive } from './live';
import { useSatelliteMap } from './map-view';
import { useSatelliteTable } from './table';
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
		const live = useSatelliteLive(receiver, now, trackFrom, passFilter);
		const map = useSatelliteMap(receiver, showMap, mapElement, live.mapSatellites, live.selection, error);
		const orbcommIds = computed(() => new Set(state.orbcomm.map((satellite) => satellite.norad)));
		const nextOrbcommPass = computed(() => live.upcoming.value.find((row) => orbcommIds.value.has(row.pass.norad)));
		const showNextOrbcomm = () => {
			if (!nextOrbcommPass.value) return;
			if (passFilter.value === -1) map.select(nextOrbcommPass.value.pass.norad);
			else passFilter.value = -1;
		};
		watch([passFilter, () => state.orbcomm.length], ([filter]) => {
			if (filter === -1 && nextOrbcommPass.value) map.select(nextOrbcommPass.value.pass.norad);
		});
		const group = computed(() => groupIds(state, passFilter.value));
		const table = useSatelliteTable(live.rows, now, passFilter, group);
		watch(
			() => state.showLora,
			(show) => {
				if (!show && passFilter.value === -2) passFilter.value = 0;
			},
		);

		return {
			receiver,
			state,
			showMap,
			mapElement,
			error,
			latitude,
			longitude,
			passFilter,
			nextOrbcommPass,
			showNextOrbcomm,
			...table,
			...live,
			...map,
			passList: computed(() => {
				const ids = group.value;
				return live.upcoming.value.filter(
					(row) => !passFilter.value || (ids ? ids.has(row.pass.norad) : row.pass.norad === passFilter.value),
				);
			}),
			decodes: computed(() => isLoraSat(live.downlink.value?.digimode)),
			loraFooter: computed(() =>
				state.showLora ? ' · LoRa satellites: TinyGS list, frequencies from SatNOGS DB (CC BY-SA 4.0) and OnAir, unverified' : '',
			),
			showLora: (event: Event) => void receiver.satelliteShowLora((event.target as HTMLInputElement).checked),
			pointing,
			formatMHz,
			formatKHz,
			setLocation: () => receiver.satelliteSetLocation(Number(latitude.value), Number(longitude.value)),
		};
	},
});
