import type { Aircraft } from '@/worker/decoders/adsb/types';
import type { DigimodeRecord } from '@/worker/decoders/digimode/types';

/** An HFDL position stays on the map this long: aircraft report one every 10 to 30 minutes, ms. */
export const HFDL_POSITION_MS = 30 * 60_000;
/** HFDL aircraft kept at most. */
const MAX_HFDL = 500;

/**
 * The aircraft positions of Digital Modes HFDL records merged into the list of aircraft heard on HFDL (tagged as
 * such, oldest first); aircraft without a position for HFDL_POSITION_MS leave it.
 */
export function mergeHfdlPositions(list: readonly Aircraft[], records: readonly DigimodeRecord[], now: number): Aircraft[] {
	const byId = new Map(list.map((item) => [item.icao, item]));
	for (const { position } of records) {
		if (!position) continue;
		const previous = byId.get(position.id);
		byId.delete(position.id);
		byId.set(position.id, {
			icao: position.id,
			callsign: position.label ?? previous?.callsign,
			latitude: position.lat,
			longitude: position.lon,
			positionTime: now,
			lastSeen: now,
			messages: (previous?.messages ?? 0) + 1,
			source: 'hfdl',
		});
	}
	return [...byId.values()].filter((item) => now - item.lastSeen <= HFDL_POSITION_MS).slice(-MAX_HFDL);
}
