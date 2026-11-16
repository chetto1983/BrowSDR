import type { DigimodeDecoder, DigimodeSink } from './types';
import { DscVhfDecoder } from './dsc';

/** Worker-side constructors of the catalog's decoders. */
export const DIGIMODE_DECODERS: Record<string, (sink: DigimodeSink) => DigimodeDecoder> = {
	'dsc-vhf': (sink) => new DscVhfDecoder(sink),
};
