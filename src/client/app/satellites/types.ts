import type { OrbitState, PassRow, TrackedSatellite } from '@/satellites/types';

/** A satellite marker: its short name and where it is now. */
export interface MapSatellite {
	name: string;
	state: OrbitState;
}

/** One line of the live satellite table. */
export interface SatelliteRow {
	satellite: TrackedSatellite;
	/** Null until its orbit has loaded. */
	state: OrbitState | null;
	/** The next pass above the chosen peak elevation, or the one in progress. */
	next: PassRow | undefined;
}

export type SatelliteVisibility = 'all' | 'above' | 'below';
export type SatellitePassWindow = 'all' | 'today' | '24h' | 'none';
export type SatelliteTableSort = 'catalog' | 'name' | 'elevation' | 'next';

export interface SatelliteTableFilters {
	query: string;
	visibility: SatelliteVisibility;
	window: SatellitePassWindow;
	time: number;
	tomorrow: number;
	/** The group the pass filter keeps to (ORBCOMM, TinyGS's LoRa satellites), null for all. */
	groupIds: Set<number> | null;
}
