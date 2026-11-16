import type { DigimodeDecoder, DigimodeSink } from './types';
import { DscVhfDecoder } from './dsc';
import { CubesatDecoder } from './cubesat';
import { SstvFmDecoder, SstvUsbDecoder } from './sstv';

/** Worker-side constructors of the catalog's decoders. */
export const DIGIMODE_DECODERS: Record<string, (sink: DigimodeSink) => DigimodeDecoder> = {
	'dsc-vhf': (sink) => new DscVhfDecoder(sink),
	'ax25-sat': (sink) => new CubesatDecoder(sink),
	'sstv-fm': (sink) => new SstvFmDecoder(sink),
	'sstv-usb': (sink) => new SstvUsbDecoder(sink),
};
