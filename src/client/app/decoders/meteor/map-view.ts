import { nextTick, onBeforeUnmount, ref, watch, type ComputedRef } from 'vue';
import type * as Leaflet from 'leaflet';
import type { AppInstance } from '@/app/core/receiver.types';
import { METEOR_SATELLITES } from '@/satellites/catalog';
import type { Tle } from '@/satellites/types';
import { meteorImage } from './controller';
import { projectImage } from './projection';
import { meteorTles } from './station';

async function tleFor(receiver: AppInstance, norad: number): Promise<Tle | undefined> {
	const known = receiver.meteor.tles.find((item) => item.norad === norad);
	if (known) return known;
	const result = await meteorTles(new Date());
	receiver.meteor.tles = result.tles;
	return result.tles.find((item) => item.norad === norad);
}

/** Lazily renders the timed Meteor scan on Leaflet and refreshes it during a pass. */
export function useMeteorMap(receiver: AppInstance, imageVfo: ComputedRef<number>) {
	const mapElement = ref<HTMLElement | null>(null);
	const mapOpen = ref(false);
	const mapMessage = ref('');
	const mapNorad = ref(0);
	let map: Leaflet.Map | null = null;
	let overlay: Leaflet.ImageOverlay | null = null;
	let imageUrl: string | null = null;
	let mapTimer: ReturnType<typeof setTimeout> | null = null;
	let mappedRows = 0;
	let rendering = false;

	const destroy = () => {
		if (mapTimer) clearTimeout(mapTimer);
		mapTimer = null;
		map?.remove();
		map = null;
		overlay = null;
		if (imageUrl) URL.revokeObjectURL(imageUrl);
		imageUrl = null;
		mapOpen.value = false;
	};
	const showOnMap = async () => {
		if (rendering) return;
		const image = meteorImage(receiver, imageVfo.value);
		const norad = mapNorad.value || image.norad;
		if (!image.timedBlocks) {
			mapMessage.value = 'No onboard row times yet. Wait for decoded image packets.';
			return;
		}
		if (!norad) {
			mapMessage.value = 'Choose Meteor-M2 3 or M2 4 to project the image.';
			return;
		}
		const tle = await tleFor(receiver, norad).catch(() => undefined);
		if (!tle) {
			mapMessage.value = 'No orbit available for this satellite. Connect to the internet to fetch its TLE.';
			return;
		}
		rendering = true;
		mapMessage.value = 'Projecting received scan lines…';
		mapOpen.value = true;
		await nextTick();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		try {
			const projected = projectImage(image, tle, receiver.meteor.view);
			if (!projected || !mapElement.value) {
				mapMessage.value = 'Too few valid timed rows for a map. Keep receiving the pass.';
				return;
			}
			const leaflet = await import('leaflet');
			if (!map) {
				map = leaflet.map(mapElement.value, { center: [45, 0], zoom: 3, worldCopyJump: true });
				leaflet
					.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
						attribution: '© OpenStreetMap contributors',
						maxZoom: 19,
					})
					.addTo(map);
			}
			const blob = await new Promise<Blob | null>((resolve) => projected.canvas.toBlob(resolve, 'image/png'));
			if (!blob || !map) throw new Error('Could not render projected image');
			const url = URL.createObjectURL(blob);
			const first = !overlay;
			if (overlay) map.removeLayer(overlay);
			overlay = leaflet.imageOverlay(url, projected.bounds, { opacity: 0.85, interactive: false }).addTo(map);
			if (imageUrl) URL.revokeObjectURL(imageUrl);
			imageUrl = url;
			mappedRows = image.rows;
			map.invalidateSize();
			if (first) map.fitBounds(projected.bounds, { padding: [16, 16], maxZoom: 7 });
			mapMessage.value = `${METEOR_SATELLITES.find((satellite) => satellite.norad === norad)?.name ?? 'Meteor'} · ${image.timedBlocks} timed blocks · ${image.rows} rows`;
		} catch (error) {
			mapMessage.value = error instanceof Error ? error.message : 'Could not project the image.';
		} finally {
			rendering = false;
		}
	};

	watch(
		() => receiver.meteor.imageVersion,
		() => {
			if (!mapOpen.value || mapTimer || meteorImage(receiver, imageVfo.value).rows < mappedRows + 64) return;
			mapTimer = setTimeout(() => {
				mapTimer = null;
				void showOnMap();
			}, 15_000);
		},
	);
	watch(
		() => receiver.meteor.panelOpen,
		(open) => {
			if (!open) destroy();
		},
	);
	onBeforeUnmount(destroy);
	return { mapElement, mapOpen, mapMessage, mapNorad, showOnMap };
}
