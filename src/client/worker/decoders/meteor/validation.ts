import { isRecord } from '@/platform/data';
import type { MeteorMessage } from './types';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const MAX_ROWS = 20000; // a horizon-to-horizon pass is under 10000 rows

function validRows(value: unknown): boolean {
	if (value === undefined) return true;
	if (!isRecord(value) || !Number.isInteger(value.from) || !Number.isInteger(value.to) || value.width !== 1568) return false;
	const [from, to] = [value.from as number, value.to as number];
	if (from < 0 || to <= from || to > MAX_ROWS || !Array.isArray(value.channels) || value.channels.length !== 3) return false;
	if (!value.channels.every((channel) => channel instanceof Uint8Array && channel.length === (to - from) * 1568)) return false;
	if (value.timeBlocks === undefined) return true;
	return (
		Array.isArray(value.timeBlocks) &&
		value.timeBlocks.length <= Math.ceil((to - from) / 8) + 1 &&
		value.timeBlocks.every(
			(point: unknown) =>
				isRecord(point) &&
				Number.isInteger(point.row) &&
				(point.row as number) % 8 === 0 &&
				(point.row as number) >= Math.floor(from / 8) * 8 &&
				(point.row as number) < to &&
				finite(point.timeMs) &&
				point.timeMs > 946684800000 &&
				point.timeMs < 4102444800000,
		)
	);
}

/** Bounded check for Meteor decoder messages (worker output and remote peers). */
export function validMeteorMessage(value: unknown): value is MeteorMessage {
	if (!isRecord(value) || value.type !== 'meteor' || !finite(value.freq) || !isRecord(value.status)) return false;
	const status = value.status;
	return (
		['off', 'receiving', 'error'].includes(String(status.state)) &&
		typeof status.message === 'string' &&
		status.message.length <= 500 &&
		typeof status.locked === 'boolean' &&
		['quality', 'freqOffsetHz', 'rs', 'vit', 'mpdus', 'rows'].every((key) => finite(status[key])) &&
		Array.isArray(status.apids) &&
		status.apids.length === 3 &&
		status.apids.every((apid) => Number.isInteger(apid)) &&
		validRows(value.rows)
	);
}
