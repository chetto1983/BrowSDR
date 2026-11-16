import type { DigimodeDecoder, DigimodeSink } from './types';
import { DscVhfDecoder } from './dsc';
import { CubesatDecoder } from './cubesat';

/** Worker-side constructors of the catalog's decoders. */
export const DIGIMODE_DECODERS: Record<string, (sink: DigimodeSink) => DigimodeDecoder> = {
	'dsc-vhf': (sink) => new DscVhfDecoder(sink),
	'ax25-sat': (sink) => new CubesatDecoder(sink),
};
