import type { DspOutput } from '@/worker/runtime/dsp-messages.types';
import type { OutputRecord } from './types';

/** Turns DSP worker output into decoded records, reporting each aircraft only when it has news. */
export class DecodedEvents {
	private messagesByIcao = new Map<string, number>();
	private frameBySonde = new Map<string, number>();
	count = 0;

	get aircraft(): number {
		return this.messagesByIcao.size;
	}

	accept(message: DspOutput, now = new Date()): OutputRecord[] {
		const time = now.toISOString();
		if (message.type === 'rtl433_event') {
			this.count++;
			return [{ kind: 'rtl433', time, freq_mhz: message.freq, ...message.event }];
		}
		if (message.type === 'radiosonde') {
			const records: OutputRecord[] = [];
			for (const sonde of message.sondes) {
				if (this.frameBySonde.get(sonde.id) === sonde.frame) continue;
				this.frameBySonde.set(sonde.id, sonde.frame);
				this.count++;
				records.push({ kind: 'radiosonde', time, freq_mhz: message.freq, ...sonde });
			}
			return records;
		}
		if (message.type !== 'adsb' || !('aircraft' in message)) return [];
		const records: OutputRecord[] = [];
		for (const aircraft of message.aircraft) {
			if (this.messagesByIcao.get(aircraft.icao) === aircraft.messages) continue;
			this.messagesByIcao.set(aircraft.icao, aircraft.messages);
			this.count++;
			records.push({ kind: 'aircraft', time, freq_mhz: message.freq, ...aircraft });
		}
		return records;
	}
}

const HIDDEN_FIELDS = new Set([
	'kind',
	'time',
	'freq_mhz',
	'model',
	'type',
	'id',
	'protocol',
	'mic',
	'mod',
	'freq1',
	'freq2',
	'rssi',
	'noise',
]);

function compact(value: unknown): string {
	if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(1);
	return typeof value === 'string' ? value : JSON.stringify(value);
}

/** One readable line per record; times are UTC so they read the same everywhere. */
export function formatEvent(record: OutputRecord): string {
	const clock = `${record.time.slice(11, 19)}Z`;
	const position =
		typeof record.latitude === 'number' && typeof record.longitude === 'number'
			? `${record.latitude.toFixed(4)},${record.longitude.toFixed(4)}`
			: 'no position';
	if (record.kind === 'radiosonde') {
		const altitude = typeof record.altitude === 'number' ? `${Math.round(record.altitude)} m` : '— m';
		return `${clock}  ${compact(record.model)} ${compact(record.id)} frame ${compact(record.frame)}  ${altitude}  ${position}`;
	}
	if (record.kind === 'aircraft') {
		const altitude = typeof record.altitude === 'number' ? `${record.altitude} ft` : '— ft';
		return `${clock}  ${compact(record.icao)} ${compact(record.callsign ?? '')}  ${altitude}  ${position}`;
	}
	const head = [record.model, record.type, record.id]
		.filter((part) => part !== undefined)
		.map(compact)
		.join(' ');
	const fields = Object.entries(record)
		.filter(([key]) => !HIDDEN_FIELDS.has(key))
		.map(([key, value]) => `${key}=${compact(value)}`)
		.join(' ');
	return `${clock}  ${head}  ${fields}`;
}
