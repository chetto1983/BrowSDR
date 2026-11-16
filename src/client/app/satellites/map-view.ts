import { nextTick, onBeforeUnmount, watch, type ComputedRef, type Ref } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import type { LatLon } from '@/satellites/types';
import type { SatelliteMap } from './map';
import type { MapSatellite } from './types';
import { useMapFullscreen } from '@/app/decoders/adsb/fullscreen';

/** Creates the Leaflet map while the panel shows it and keeps markers, station and selection current. */
export function useSatelliteMap(
	receiver: AppInstance,
	showMap: Ref<boolean>,
	mapElement: Ref<HTMLElement | undefined>,
	satellites: ComputedRef<MapSatellite[]>,
	selection: ComputedRef<{ track: LatLon[]; coverage: LatLon[] }>,
	error: Ref<string>,
) {
	let map: SatelliteMap | undefined;
	let observer: ResizeObserver | undefined;
	let generation = 0;
	const { fullscreen, setFullscreen } = useMapFullscreen(
		() => receiver.satellites.panelOpen,
		() => (showMap.value = true),
		() => map?.resize(),
	);
	const select = (norad: number) => {
		receiver.satelliteSelect(norad);
		map?.focus(norad);
	};
	const refresh = () => map?.update(satellites.value, receiver.satellites.selected);
	const refreshSelection = () => map?.setSelection(selection.value.track, selection.value.coverage);
	const destroy = () => {
		generation++;
		observer?.disconnect();
		observer = undefined;
		map?.destroy();
		map = undefined;
	};
	watch(
		() => receiver.satellites.panelOpen && showMap.value,
		async (open) => {
			destroy();
			if (!open) return;
			const current = generation;
			error.value = '';
			await nextTick();
			try {
				const [leaflet, { SatelliteMap }] = await Promise.all([import('leaflet'), import('./map')]);
				if (current !== generation || !mapElement.value) return;
				map = new SatelliteMap(
					leaflet,
					mapElement.value,
					() => (error.value = 'Map tiles unavailable. Positions still update; check your internet connection.'),
					select,
				);
				if (typeof ResizeObserver !== 'undefined') {
					observer = new ResizeObserver(() => map?.resize());
					observer.observe(mapElement.value);
				}
				map.setStation(receiver.station);
				refresh();
				refreshSelection();
			} catch {
				error.value = 'Could not load the map. Satellite data remains available in the list.';
			}
		},
		{ immediate: true },
	);
	watch([satellites, () => receiver.satellites.selected], refresh);
	watch(selection, refreshSelection);
	watch(
		() => receiver.station,
		(site) => map?.setStation(site),
	);
	onBeforeUnmount(destroy);
	return { fullscreen, setFullscreen, select };
}
