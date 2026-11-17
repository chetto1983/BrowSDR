import type * as Leaflet from 'leaflet';
import type { LatLon, OrbitState, Site } from '@/satellites/types';
import type { MapSatellite } from './types';

/** Lines and areas are drawn on the world copies either side too, so they wrap when the map is zoomed out. */
const WORLD_COPIES = [-360, 0, 360];
const COLORS = { up: '#22c55e', sunlit: '#facc15', eclipse: '#94a3b8', selection: '#38bdf8', pass: '#fb923c', station: '#f43f5e' };

const copies = (points: LatLon[]): Leaflet.LatLngTuple[][] =>
	WORLD_COPIES.map((offset) => points.map(([lat, lon]): Leaflet.LatLngTuple => [lat, lon + offset]));

function markerStyle(state: OrbitState, selected: boolean): Leaflet.CircleMarkerOptions {
	const fill = (state.look?.elevation ?? -90) > 0 ? COLORS.up : state.sunlit ? COLORS.sunlit : COLORS.eclipse;
	return { radius: selected ? 8 : 6, color: selected ? '#ffffff' : '#111827', weight: selected ? 3 : 1, fillColor: fill, fillOpacity: 1 };
}

/** World map with every tracked satellite, the station, and the selected satellite's ground track and coverage. */
export class SatelliteMap {
	private map: Leaflet.Map;
	private markers = new Map<number, Leaflet.CircleMarker>();
	private station: Leaflet.CircleMarker | null = null;
	private track: Leaflet.Polyline;
	private passTrack: Leaflet.Polyline;
	private coverage: Leaflet.Polygon;

	constructor(
		private leaflet: typeof Leaflet,
		element: HTMLElement,
		onTileError: () => void,
		private onSelect: (norad: number) => void,
	) {
		this.map = leaflet.map(element, { center: [30, 0], zoom: 2, minZoom: 1, worldCopyJump: true });
		leaflet
			.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
				maxZoom: 19,
				crossOrigin: 'anonymous',
				attribution:
					'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
			})
			.addTo(this.map)
			.on('tileerror', onTileError);
		const line = { color: COLORS.selection, interactive: false };
		this.coverage = leaflet.polygon([], { ...line, weight: 1, fillOpacity: 0.1 }).addTo(this.map);
		this.track = leaflet.polyline([], { ...line, weight: 2, dashArray: '6 6' }).addTo(this.map);
		this.passTrack = leaflet.polyline([], { color: COLORS.pass, weight: 4, interactive: false }).addTo(this.map);
	}

	update(satellites: MapSatellite[], selected: number): void {
		const live = new Set(satellites.map((item) => item.state.norad));
		for (const [norad, marker] of this.markers)
			if (!live.has(norad)) {
				marker.remove();
				this.markers.delete(norad);
			}
		for (const { name, state } of satellites) {
			const location: Leaflet.LatLngTuple = [state.latitude, state.longitude];
			const style = markerStyle(state, state.norad === selected);
			let marker = this.markers.get(state.norad);
			if (!marker) {
				marker = this.leaflet.circleMarker(location, style).addTo(this.map);
				marker.bindTooltip(name, { permanent: true, direction: 'right', offset: [8, 0], className: 'satellite-label' });
				marker.on('click', () => this.onSelect(state.norad));
				this.markers.set(state.norad, marker);
			} else marker.setLatLng(location).setStyle(style);
			if (state.norad === selected) marker.bringToFront();
		}
	}

	/** The next orbit, the visible part of the next pass, and the area that hears the satellite now. */
	setSelection(track: LatLon[], passTrack: LatLon[], coverage: LatLon[]): void {
		this.track.setLatLngs(track.length ? copies(track) : []);
		this.passTrack.setLatLngs(passTrack.length ? copies(passTrack) : []);
		this.coverage.setLatLngs(coverage.length ? copies(coverage).map((ring) => [ring]) : []);
	}

	/** Marks the station and centres the map on it (zoom 3 shows the coverage of the higher satellites). */
	setStation(site: Site | null): void {
		this.station?.remove();
		if (site) this.map.setView([site.lat, site.lon], 3);
		this.station = site
			? this.leaflet
					.circleMarker([site.lat, site.lon], { radius: 5, color: '#ffffff', weight: 2, fillColor: COLORS.station, fillOpacity: 1 })
					.bindTooltip('Station')
					.addTo(this.map)
			: null;
	}

	focus(norad: number): void {
		const marker = this.markers.get(norad);
		if (marker) this.map.panTo(marker.getLatLng());
	}

	resize(): void {
		this.map.invalidateSize();
	}

	destroy(): void {
		this.map.remove();
		this.markers.clear();
		this.station = null;
	}
}
