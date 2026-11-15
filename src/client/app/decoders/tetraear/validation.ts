import { isRecord } from '@/platform/data';
import type { TetraEarBatch, TetraEarFrame } from './types';

const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const optionalNumber = (value: unknown, max: number) => value === null || (count(value) && value <= max);

function validFrame(value: unknown): value is TetraEarFrame {
	if (!isRecord(value)) return false;
	return (
		typeof value.kind === 'string' &&
		value.kind.length <= 64 &&
		optionalNumber(value.slot, 4) &&
		optionalNumber(value.mcc, 1023) &&
		optionalNumber(value.mnc, 16383) &&
		optionalNumber(value.colour, 63) &&
		optionalNumber(value.address, 16777215) &&
		(value.encrypted === null || typeof value.encrypted === 'boolean') &&
		typeof value.text === 'string' &&
		value.text.length <= 2048 &&
		(value.call === null ||
			(isRecord(value.call) &&
				Object.keys(value.call).length <= 16 &&
				Object.values(value.call).every(
					(field) =>
						field === null ||
						typeof field === 'boolean' ||
						(typeof field === 'number' && Number.isFinite(field)) ||
						(typeof field === 'string' && field.length <= 256),
				)))
	);
}

export function validBatch(value: unknown): value is TetraEarBatch {
	return (
		isRecord(value) &&
		value.type === 'batch' &&
		count(value.bursts) &&
		count(value.valid) &&
		count(value.rejected) &&
		Array.isArray(value.frames) &&
		value.frames.length <= 64 &&
		value.frames.every(validFrame)
	);
}

export function bridgeUrl(value: string, pageProtocol = location.protocol): string {
	const url = new URL(value);
	if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash)
		throw new Error('Enter a ws:// or wss:// bridge address without credentials or a fragment.');
	if (pageProtocol === 'https:' && url.protocol !== 'wss:')
		throw new Error('This HTTPS page needs a wss:// bridge. Use a trusted TLS certificate, or open BrowSDR on http://localhost:5173.');
	return url.href;
}
