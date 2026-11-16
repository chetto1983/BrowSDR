import type { DigimodeRecord } from '@/worker/decoders/digimode/types';

/** A decoded record with the VFO it came from. */
export interface DigimodeLogEntry extends DigimodeRecord {
	vfo: number;
	freq: number;
}
