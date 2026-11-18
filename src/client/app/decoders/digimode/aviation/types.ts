import type { DigimodeRecord } from '@/worker/decoders/digimode/types';

/** A labelled line of a record's details. */
export type Field = [label: string, value: string];

/** What one decoder of a VFO's aviation state does with a record that carries its kind of application. */
export interface AviationPart {
	read<T extends DigimodeRecord>(record: T): T;
}
