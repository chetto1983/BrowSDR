import { decodeCpdlc } from '@jlynx_/acars-decoder';
import type { DigimodeRecord } from '@/worker/decoders/digimode/types';

const MAX_FIELDS = 64;
const MAX_TEXT = 2000;

const bytesOf = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));

/**
 * A record with the FANS-1/A CPDLC body it carries decoded: the message elements as fields and their summary in the
 * one-line text. The decoders send the body (CRC checked) as hex; it is read here with the ACARS library the app
 * already loads for the ACARS tool, so the DSP workers stay small. A body the library cannot read keeps its hex.
 */
export function readApplication<T extends DigimodeRecord>(record: T): T {
	const app = record.application;
	if (app?.kind !== 'cpdlc' || !app.hex) return record;
	let decoded: ReturnType<typeof decodeCpdlc>;
	try {
		decoded = decodeCpdlc(bytesOf(app.hex), app.uplink ? 'uplink' : 'downlink');
	} catch {
		return record;
	}
	if (!decoded.summary) return record;
	const partly = decoded.complete ? '' : ' (partly decoded)';
	const fields: Array<[string, string]> = [
		...(record.fields ?? []),
		['CPDLC message', decoded.summary + partly],
		...decoded.fields.map((field): [string, string] => [field.label, field.value]),
		...(decoded.complete || !decoded.notes.length ? [] : [['CPDLC notes', decoded.notes.join(' ')] as [string, string]]),
	];
	return { ...record, text: `${record.text}: ${decoded.summary}`.slice(0, MAX_TEXT), fields: fields.slice(0, MAX_FIELDS) };
}
