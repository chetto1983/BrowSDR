import type { DspProcessor } from '/wasm/dsp/browsdr_dsp.js';
import type { VfoParams } from '@/worker/runtime/types';
import { errorMessage } from '@/platform/errors';
import { HdAudioPacer } from '@/worker/decoders/hd-radio/audio';
import { createAacDecoder } from './faad';
import type {
	AacDecoder,
	DabAudioParams,
	DabEnsembleInfo,
	DabMessage,
	DabReceiverCore,
	DabReceiverFactory,
	DabStatus,
	DabSyncStatus,
} from './types';

/** Transmission mode I runs at 2.048 MS/s; its ensembles are 1.536 MHz wide. */
export const DAB_RATE = 2_048_000;
export const DAB_BANDWIDTH = 1_536_000;

let receiverFactory: DabReceiverFactory | null = null;

/** Installs the DAB receiver core (OnAir's, ported in src/client/worker/decoders/dab). */
export function provideDabReceiver(factory: DabReceiverFactory): void {
	receiverFactory = factory;
}
const STATUS_MS = 500;

const emptyStatus = (): DabStatus => ({
	state: 'off',
	message: 'DAB+ off',
	ensemble: '',
	eid: 0,
	services: [],
	service: 0,
	serviceLabel: '',
	label: '',
	codec: '',
	bitrate: 0,
	snrDb: 0,
	audioUnits: 0,
	audioErrors: 0,
});

const codecName = (params: DabAudioParams) => (params.sbr && params.ps ? 'HE-AAC v2' : params.sbr ? 'HE-AAC' : 'AAC-LC');
const ascKey = (asc: Uint8Array) => Array.from(asc).join(',');

/**
 * DAB+ on a VFO in mode 'dab': the ensemble cut to 2.048 MS/s, OnAir's receiver (src/client/worker/decoders/dab),
 * the chosen service's access units decoded by faad2, and the audio paced to the IQ like HD Radio's.
 */
export class DabStream {
	private key = '';
	private generation = 0;
	private ddc?: DspProcessor;
	private receiver?: DabReceiverCore;
	private aac?: AacDecoder;
	private aacKey = '';
	private aacOpening = false;
	private status = emptyStatus();
	private frequency = 0;
	private wantedService = 0;
	private sequence?: number;
	private lastEmit = 0;
	private audio = new HdAudioPacer(DAB_RATE);
	audioActive = false;

	constructor(
		private Processor: typeof DspProcessor,
		private memory: { buffer: ArrayBuffer },
		private post: (message: DabMessage) => void,
	) {}

	configure(params: VfoParams, inputRate: number, center: number): void {
		this.frequency = params.freq;
		if (params.mode !== 'dab') {
			if (this.key) {
				this.reset();
				this.emit();
			}
			return;
		}
		this.wantedService = params.dabService ?? 0;
		const key = JSON.stringify([params.freq, inputRate, center]);
		if (key === this.key) {
			this.chooseService();
			return;
		}
		this.reset();
		this.key = key;
		this.wantedService = params.dabService ?? 0;
		if (inputRate < DAB_RATE || Math.abs(params.freq - center) * 1e6 + DAB_BANDWIDTH / 2 > inputRate / 2) {
			this.fail('DAB+ needs at least 2.048 MSPS and the whole 1.536 MHz ensemble inside the received band. Center the radio on the block.');
			return;
		}
		if (!receiverFactory) {
			this.fail('The DAB receiver is not available in this build.');
			return;
		}
		try {
			this.ddc = new this.Processor(inputRate, (params.freq - center) * 1e6, DAB_BANDWIDTH);
			this.ddc.set_if_sample_rate(DAB_RATE);
			this.ddc.set_bandwidth(DAB_BANDWIDTH);
			const generation = this.generation;
			const current = () => generation === this.generation;
			this.receiver = receiverFactory({
				status: (sync) => current() && this.onSync(sync),
				ensemble: (info) => current() && this.onEnsemble(info),
				audioUnit: (au, audio, ok) => current() && this.onAudioUnit(au, audio, ok),
				label: (text) => {
					if (current()) this.status.label = text;
				},
			});
			this.status = { ...emptyStatus(), state: 'searching', message: 'Searching for a DAB ensemble' };
			this.emit();
		} catch (error) {
			this.fail(errorMessage(error));
		}
	}

	process(ptr: number, values: number, floatInput: boolean, sequence: number): Float32Array | null {
		if (!this.ddc || !this.receiver || values === 0) return null;
		if (this.sequence !== undefined && sequence !== this.sequence + 1) {
			this.ddc.reset();
			this.receiver.reset();
			this.audio = new HdAudioPacer(DAB_RATE);
			this.status = { ...this.status, state: 'searching', message: 'Input gap · searching for the ensemble' };
		}
		this.sequence = sequence;
		try {
			const output = floatInput ? this.ddc.process_iq_only_f32_ptr(ptr, values) : this.ddc.process_iq_only_ptr(ptr, values);
			const count = this.ddc.get_iq_output_len();
			if (count) this.receiver.process(new Float32Array(this.memory.buffer, output, count));
			if (performance.now() - this.lastEmit >= STATUS_MS) this.emit();
			const audio = this.audio.read(count / 2);
			this.audioActive = !!audio;
			return audio;
		} catch (error) {
			this.fail(errorMessage(error));
			return null;
		}
	}

	reset(): void {
		this.generation++;
		this.ddc?.free();
		this.ddc = undefined;
		this.receiver = undefined;
		this.closeAac();
		this.key = '';
		this.sequence = undefined;
		this.audio = new HdAudioPacer(DAB_RATE);
		this.audioActive = false;
		this.status = emptyStatus();
	}

	private onSync(sync: DabSyncStatus): void {
		const synced = sync.state === 'synced';
		this.status.state = synced ? 'synced' : 'searching';
		this.status.snrDb = sync.snrDb;
		this.status.message = synced
			? `Ensemble locked · SNR ${sync.snrDb.toFixed(1)} dB · FIC ${Math.round(sync.ficOkRatio * 100)} %`
			: 'Searching for a DAB ensemble';
	}

	private onEnsemble(info: DabEnsembleInfo): void {
		this.status.ensemble = info.label;
		this.status.eid = info.eid;
		this.status.services = info.services;
		this.chooseService();
		this.emit();
	}

	/** The wanted service's primary DAB+ audio component goes to the receiver; the first such service by default. */
	private chooseService(): void {
		const audio = this.status.services.filter((service) => service.components.some((component) => component.dabPlus));
		const service = audio.find((item) => item.sid === this.wantedService) ?? (this.wantedService ? undefined : audio[0]);
		const component = service?.components.find((item) => item.dabPlus && item.primary) ?? service?.components.find((item) => item.dabPlus);
		if (service?.sid === this.status.service) return;
		this.closeAac();
		this.audio = new HdAudioPacer(DAB_RATE);
		this.status = {
			...this.status,
			service: service?.sid ?? 0,
			serviceLabel: service?.label ?? '',
			label: '',
			codec: '',
			bitrate: component?.bitrate ?? 0,
			audioUnits: 0,
			audioErrors: 0,
		};
		this.receiver?.select(component ? component.subchannel : null);
		if (this.key) this.emit();
	}

	private onAudioUnit(au: Uint8Array, params: DabAudioParams, ok: boolean): void {
		const key = ascKey(params.asc);
		if (key !== this.aacKey && !this.aacOpening) this.openAac(params, key);
		if (!this.aac || this.aacKey !== key) return;
		const pcm = ok ? this.aac.decode(au) : null;
		if (pcm) {
			this.status.audioUnits++;
			this.audio.push(pcm);
		} else {
			this.status.audioErrors++;
			// Conceal a lost unit with silence of the same length, so the audio clock does not slip.
			this.audio.push(new Float32Array((params.sbr ? 1920 : 960) * 2 * (48000 / params.sampleRate)));
		}
	}

	private openAac(params: DabAudioParams, key: string): void {
		this.closeAac();
		this.aacOpening = true;
		const generation = this.generation;
		createAacDecoder(params.asc)
			.then((decoder) => {
				this.aacOpening = false;
				if (generation !== this.generation) return decoder.close();
				this.aac = decoder;
				this.aacKey = key;
				this.status.codec = `${codecName(params)} ${params.stereo || params.ps ? 'stereo' : 'mono'} ${params.sampleRate / 1000} kHz`;
			})
			.catch((error: unknown) => {
				this.aacOpening = false;
				this.status.message = `DAB+ audio: ${errorMessage(error)}`;
			});
	}

	private closeAac(): void {
		this.aac?.close();
		this.aac = undefined;
		this.aacKey = '';
	}

	private fail(message: string): void {
		const key = this.key;
		this.reset();
		this.key = key;
		this.status = { ...emptyStatus(), state: 'error', message };
		this.emit();
	}

	private emit(): void {
		this.lastEmit = performance.now();
		this.post({
			type: 'dab',
			freq: this.frequency,
			status: { ...this.status, services: this.status.services.map((service) => ({ ...service })) },
		});
	}
}
