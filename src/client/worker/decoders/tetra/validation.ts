import { isRecord } from '@/platform/data';
import type { TetraMessage } from './types';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const integer = (value: unknown, min: number, max: number) =>
	Number.isInteger(value) && (value as number) >= min && (value as number) <= max;

/** Bounded check for TETRA telemetry received from a remote peer. */
export function validTetraMessage(value: unknown): value is TetraMessage {
	if (!isRecord(value) || value.type !== 'tetra' || !finite(value.freq) || !isRecord(value.status)) return false;
	const status = value.status;
	return (
		['off', 'receiving', 'error'].includes(String(status.state)) &&
		typeof status.message === 'string' &&
		status.message.length <= 500 &&
		['samples', 'bursts', 'frames'].every((key) => finite(status[key]) && status[key] >= 0) &&
		finite(status.quality) &&
		finite(status.freqOffsetHz) &&
		Array.isArray(value.cells) &&
		value.cells.length <= 32 &&
		value.cells.every(validCell)
	);
}

function validCell(value: unknown): boolean {
	if (!isRecord(value) || !isRecord(value.sync)) return false;
	const sync = value.sync;
	return (
		typeof value.id === 'string' &&
		value.id.length <= 32 &&
		integer(value.mcc, 0, 1023) &&
		integer(value.mnc, 0, 16383) &&
		integer(value.colourCode, 0, 63) &&
		['syncCount', 'sysinfoCount', 'firstSeen', 'lastSeen'].every((key) => finite(value[key]) && value[key] >= 0) &&
		[
			'systemCode',
			'colourCode',
			'timeslot',
			'frame',
			'multiframe',
			'sharingMode',
			'mcc',
			'mnc',
			'neighbourBroadcast',
			'cellServiceLevel',
		].every((key) => integer(sync[key], 0, 16383)) &&
		typeof sync.lateEntry === 'boolean' &&
		(value.sysinfo === undefined || validSysinfo(value.sysinfo))
	);
}

function validSysinfo(value: unknown): boolean {
	if (!isRecord(value) || !isRecord(value.services)) return false;
	const numbers = [
		'mainCarrier',
		'band',
		'offset',
		'mainCarrierMHz',
		'duplexSpacing',
		'commonScch',
		'msTxPowerMax',
		'rxLevelAccessMin',
		'accessParameter',
		'radioDownlinkTimeout',
		'hyperframeOrCck',
		'locationArea',
		'subscriberClass',
	];
	const services = Object.values(value.services);
	return (
		numbers.every((key) => finite(value[key]) && value[key] >= 0 && value[key] <= 65535) &&
		typeof value.reverseOperation === 'boolean' &&
		typeof value.cipherKeyBroadcast === 'boolean' &&
		services.length === 11 &&
		services.every((flag) => typeof flag === 'boolean')
	);
}
