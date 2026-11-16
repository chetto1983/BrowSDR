import type { DigimodeDecoder, DigimodeSink } from './types';
import { DscVhfDecoder } from './dsc';
import { NavtexReceiver } from './navtex';
import { CubesatDecoder } from './cubesat';
import { SstvFmDecoder, SstvUsbDecoder } from './sstv';
import { Vdl2Decoder } from './vdl2';
import { TonesDecoder } from './tones';
import { WmbusDecoder } from './wmbus';
import { WefaxDecoder } from './wefax';
import { MeshtasticDecoder } from './meshtastic';
import { MeshCoreDecoder } from './meshcore';
import { LorawanDecoder } from './lorawan';

/** Worker-side constructors of the catalog's decoders. */
export const DIGIMODE_DECODERS: Record<string, (sink: DigimodeSink) => DigimodeDecoder> = {
	'dsc-vhf': (sink) => new DscVhfDecoder(sink),
	navtex: (sink) => new NavtexReceiver(sink),
	'ax25-sat': (sink) => new CubesatDecoder(sink),
	'sstv-fm': (sink) => new SstvFmDecoder(sink),
	'sstv-usb': (sink) => new SstvUsbDecoder(sink),
	vdl2: (sink) => new Vdl2Decoder(sink),
	tones: (sink) => new TonesDecoder(sink),
	wmbus: (sink) => new WmbusDecoder(sink),
	wefax: (sink) => new WefaxDecoder(sink),
	meshtastic: (sink) => new MeshtasticDecoder(sink),
	meshcore: (sink) => new MeshCoreDecoder(sink),
	lorawan: (sink) => new LorawanDecoder(sink),
};
