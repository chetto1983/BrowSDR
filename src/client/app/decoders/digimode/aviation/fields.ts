import type { DigimodeRecord } from '@/worker/decoders/digimode/types';
import type { Field } from './types';

/** The bounds the Digital Modes log keeps records within (those of the worker's records). */
const MAX_FIELDS = 64;
const MAX_TEXT = 2000;
const MAX_VALUE = 4000;
const MAX_LABEL = 200;

/** A label not yet used by the record: the log keys a record's fields by label. */
function uniqueLabel(label: string, seen: Set<string>): string {
	const base = label.slice(0, MAX_LABEL - 6);
	let name = base;
	for (let n = 2; seen.has(name); n++) name = `${base} (${n})`;
	seen.add(name);
	return name;
}

/** The record with `extra` fields after its own and `note` after its text, within the log's bounds. */
export function withFields<T extends DigimodeRecord>(record: T, extra: readonly Field[], note = ''): T {
	const fields: Field[] = [...(record.fields ?? [])];
	const seen = new Set(fields.map(([label]) => label));
	for (const [label, value] of extra) {
		if (fields.length >= MAX_FIELDS) break;
		fields.push([uniqueLabel(label, seen), value.slice(0, MAX_VALUE)]);
	}
	return { ...record, text: (record.text + note).slice(0, MAX_TEXT), fields };
}

/** Upper case hex of bytes, at most `max` of them ("…" after). */
export function hexOf(bytes: Uint8Array, max = 64): string {
	let text = '';
	for (const byte of bytes.subarray(0, max)) text += byte.toString(16).toUpperCase().padStart(2, '0');
	return bytes.length > max ? `${text}…` : text;
}

/** Bytes of an even-length hex string (the worker's records carry bytes as upper case hex). */
export const bytesOf = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));

/** Entries a state map keeps (links, connections); the oldest goes first. */
const MAX_ENTRIES = 512;

/** Sets `key` in a bounded map, as its newest entry. */
export function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
	map.delete(key);
	if (map.size >= MAX_ENTRIES) map.delete(map.keys().next().value!);
	map.set(key, value);
}

/** A decoded scalar (number, string, boolean) as text; '' for anything else. */
export const scalar = (value: unknown): string =>
	typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean' ? String(value) : '';
