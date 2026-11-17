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
import { LoraAprsDecoder } from './lora-aprs';
import { MESHCOM_125_MODE, MeshComDecoder } from './meshcom';
import { Ft4Decoder, Ft8Decoder } from './ftx';
import { WsprDecoder } from './wspr';
import { RTTY_AMATEUR, RttyReceiver } from './rtty';
import { PSK_MODES, PskDecoder } from './psk';
import { CwDecoder } from './cw';
import { FlarmDecoder } from './flarm';
import { FANET_125, FANET_250, FANET_500, FanetDecoder } from './fanet';
import { Mpt1327Decoder } from './mpt1327';
import { OrbcommReceiver } from './orbcomm/receiver';

/** Worker-side constructors of the catalog's decoders. */
export const DIGIMODE_DECODERS: Record<string, (sink: DigimodeSink) => DigimodeDecoder> = {
	'dsc-vhf': (sink) => new DscVhfDecoder(sink),
	navtex: (sink) => new NavtexReceiver(sink),
	'ax25-sat': (sink) => new CubesatDecoder(sink),
	orbcomm: (sink) => new OrbcommReceiver(sink),
	'sstv-fm': (sink) => new SstvFmDecoder(sink),
	'sstv-usb': (sink) => new SstvUsbDecoder(sink),
	vdl2: (sink) => new Vdl2Decoder(sink),
	tones: (sink) => new TonesDecoder(sink),
	wmbus: (sink) => new WmbusDecoder(sink),
	wefax: (sink) => new WefaxDecoder(sink),
	meshtastic: (sink) => new MeshtasticDecoder(sink),
	meshcore: (sink) => new MeshCoreDecoder(sink),
	lorawan: (sink) => new LorawanDecoder(sink),
	'lora-aprs': (sink) => new LoraAprsDecoder(sink),
	meshcom: (sink) => new MeshComDecoder(sink),
	'meshcom-125': (sink) => new MeshComDecoder(sink, MESHCOM_125_MODE),
	ft8: (sink) => new Ft8Decoder(sink),
	ft4: (sink) => new Ft4Decoder(sink),
	wspr: (sink) => new WsprDecoder(sink),
	cw: (sink) => new CwDecoder(sink),
	rtty: (sink) => new RttyReceiver(sink, { start: RTTY_AMATEUR }),
	'rtty-dwd': (sink) => new RttyReceiver(sink, { start: { baudIdx: 1, shiftIdx: 3, reverse: false } }),
	'rtty-dwd-lf': (sink) => new RttyReceiver(sink, { start: { baudIdx: 1, shiftIdx: 5, reverse: false } }),
	psk31: (sink) => new PskDecoder(sink, PSK_MODES[0]),
	psk63: (sink) => new PskDecoder(sink, PSK_MODES[1]),
	psk125: (sink) => new PskDecoder(sink, PSK_MODES[4]),
	qpsk31: (sink) => new PskDecoder(sink, PSK_MODES[2]),
	qpsk63: (sink) => new PskDecoder(sink, PSK_MODES[3]),
	flarm: (sink) => new FlarmDecoder(sink),
	fanet: (sink) => new FanetDecoder(sink, FANET_250),
	'fanet-500': (sink) => new FanetDecoder(sink, FANET_500),
	'fanet-125': (sink) => new FanetDecoder(sink, FANET_125),
	mpt1327: (sink) => new Mpt1327Decoder(sink),
};
