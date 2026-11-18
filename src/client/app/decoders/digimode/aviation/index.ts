import { toRaw } from 'vue';
import type { DigimodeRecord } from '@/worker/decoders/digimode/types';
import { AcarsBlocks } from './acars';
import type { AviationPart } from './types';

/**
 * The aviation data link state of one VFO: the ACARS reassembly, kept while the VFO runs the same mode on the same
 * frequency. It lives in the app (main thread) with the ACARS library the app already loads, so the DSP workers (one
 * per VFO) stay small.
 */
class AviationState {
	private readonly parts: Record<string, AviationPart> = { acars: new AcarsBlocks() };

	constructor(readonly key: string) {}

	read<T extends DigimodeRecord>(record: T): T {
		const kind = record.application?.kind;
		const part = kind ? this.parts[kind] : undefined;
		if (!part) return record;
		try {
			return part.read(record);
		} catch {
			return record;
		}
	}
}

/** Per receiver, per VFO index; outside Vue's reactivity. */
const states = new WeakMap<object, Map<number, AviationState>>();

const KINDS = new Set(['acars']);

/**
 * A VDL2 or HFDL record with what the app reads from it: the ACARS library's interpretation of its block, and of the
 * message the block completes. The state starts again when the VFO's mode or frequency changes.
 */
export function readAviation<T extends DigimodeRecord>(receiver: object, vfo: number, mode: string, freq: number, record: T): T {
	if (!KINDS.has(record.application?.kind ?? '')) return record;
	const key = toRaw(receiver);
	const list = states.get(key) ?? new Map<number, AviationState>();
	states.set(key, list);
	const id = `${mode} ${freq}`;
	let state = list.get(vfo);
	if (state?.key !== id) list.set(vfo, (state = new AviationState(id)));
	return state.read(record);
}

/** Forgets a VFO's state (its decoder was changed). */
export function resetAviation(receiver: object, vfo: number): void {
	states.get(toRaw(receiver))?.delete(vfo);
}
