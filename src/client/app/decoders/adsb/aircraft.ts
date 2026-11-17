import type { Aircraft } from '@/worker/decoders/adsb/types';
import { HFDL_POSITION_MS } from './hfdl';

/**
 * Deduplicate receiver VFOs and expire data even when reception has stopped. Aircraft heard on HFDL are added while
 * their position is recent, unless ADS-B hears them.
 */
export function visibleAircraft(sources: Aircraft[][], now: number, hfdl: readonly Aircraft[] = []): Aircraft[] {
	const aircraft = new Map<string, Aircraft>();
	for (const source of sources) {
		for (const record of source ?? []) {
			if (now - record.lastSeen > 120000) continue;
			const previous = aircraft.get(record.icao);
			if (!previous || record.lastSeen > previous.lastSeen) aircraft.set(record.icao, record);
		}
	}
	for (const record of hfdl) if (now - record.lastSeen <= HFDL_POSITION_MS && !aircraft.has(record.icao)) aircraft.set(record.icao, record);
	return [...aircraft.values()].sort((a, b) => a.icao.localeCompare(b.icao)).slice(0, 500);
}

export function hasLivePosition(aircraft: Aircraft, now: number): boolean {
	return (
		aircraft.latitude !== undefined &&
		aircraft.longitude !== undefined &&
		aircraft.positionTime !== undefined &&
		now - aircraft.positionTime <= (aircraft.source === 'hfdl' ? HFDL_POSITION_MS : 30000)
	);
}
