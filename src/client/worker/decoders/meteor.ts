import type { DspProcessor } from '/wasm/dsp/browsdr_dsp.js';
import type { VfoParams } from '@/worker/runtime/types';
import type { MeteorDecoder, MeteorMessage, MeteorRows, MeteorStatus } from './meteor/types';
import { MeteorDemodulator, METEOR_CHANNEL_RATE } from './meteor/demodulator';
import { createMeteorDecoder } from './meteor-init';
import { selectRows } from './meteor/rows';
import { errorMessage } from '@/platform/errors';

export { METEOR_CHANNEL_RATE };
const CHANNEL_WIDTH = 150000;
/** Symbols kept while meteor_decode loads (about 2 s); older ones are dropped. */
const PENDING_LIMIT = 2 * 2 * 72000;

export const isMeteorFrequency = (frequency: number): boolean => Number.isFinite(frequency) && frequency >= 137 && frequency <= 138;

const idleStatus = (): MeteorStatus => ({
	state: 'off',
	message: 'Decoder off',
	locked: false,
	quality: 0,
	freqOffsetHz: 0,
	rs: 0,
	vit: 0,
	mpdus: 0,
	rows: 0,
	apids: [-1, -1, -1],
});

/**
 * Receives one Meteor-M LRPT downlink: QPSK demodulation here, image decoding in meteor_decode (WASM).
 * The image survives gaps in the input; only a change of channel starts a new one.
 */
export class MeteorStream {
	private key = '';
	private frequency = 137.9;
	private ddc?: DspProcessor;
	private lastChunk?: number;
	private decoder: MeteorDecoder | null = null;
	private loading: Promise<void> | null = null;
	private pending: Int8Array[] = [];
	private pendingLength = 0;
	private sentRows = 0;
	private lastEmit = 0;
	private status = idleStatus();
	private readonly demodulator = new MeteorDemodulator((soft) => this.symbols(soft));

	constructor(
		private Processor: typeof DspProcessor,
		private memory: { buffer: ArrayBuffer },
		private post: (message: MeteorMessage) => void,
	) {}

	configure(params: VfoParams, inputRate: number, centerFreq: number): void {
		this.frequency = params.freq;
		if (!params.meteor) {
			if (this.key) {
				this.reset();
				this.emit();
			}
			return;
		}
		const key = JSON.stringify([params.freq, inputRate, centerFreq]);
		if (key === this.key) return;
		this.reset();
		this.key = key;
		if (!isMeteorFrequency(params.freq)) return this.fail('Tune this VFO to a Meteor LRPT downlink (137.0-138.0 MHz).');
		if (inputRate < METEOR_CHANNEL_RATE || Math.abs(params.freq - centerFreq) * 1e6 + CHANNEL_WIDTH / 2 > inputRate / 2) {
			return this.fail('Meteor LRPT needs a 150 kHz channel inside the received band. Move the center frequency closer to 137.9 MHz.');
		}
		try {
			this.ddc = new this.Processor(inputRate, (params.freq - centerFreq) * 1e6, METEOR_CHANNEL_RATE);
			this.ddc.set_if_sample_rate(METEOR_CHANNEL_RATE);
			this.ddc.set_bandwidth(CHANNEL_WIDTH);
			this.status.state = 'receiving';
			this.load(key);
			this.emit();
		} catch (error) {
			this.fail(errorMessage(error));
		}
	}

	process(ptr: number, values: number, floatInput: boolean, chunkId?: number): void {
		if (!values || this.status.state !== 'receiving' || !this.ddc) return;
		try {
			if (chunkId !== undefined && this.lastChunk !== undefined && chunkId !== this.lastChunk + 1) {
				this.demodulator.reset();
				this.ddc.reset();
			}
			this.lastChunk = chunkId;
			const output = floatInput ? this.ddc.process_iq_only_f32_ptr(ptr, values) : this.ddc.process_iq_only_ptr(ptr, values);
			const count = this.ddc.get_iq_output_len();
			if (count) this.demodulator.process(new Float32Array(this.memory.buffer, output, count));
			if (performance.now() - this.lastEmit >= 500) this.emit();
		} catch (error) {
			this.fail(errorMessage(error));
		}
	}

	reset(): void {
		this.ddc?.free();
		this.ddc = undefined;
		this.key = '';
		this.lastChunk = undefined;
		this.decoder = null;
		this.loading = null;
		this.pending = [];
		this.pendingLength = 0;
		this.sentRows = 0;
		this.demodulator.reset();
		this.status = idleStatus();
	}

	/** Each channel gets its own meteor_decode instance; symbols wait while it loads. */
	private load(key: string): void {
		const loading = createMeteorDecoder(undefined, this.demodulator.modulation).then(
			(decoder) => {
				if (this.key !== key || this.loading !== loading) return;
				this.decoder = decoder;
				for (const block of this.pending) decoder.push(block);
				this.pending = [];
				this.pendingLength = 0;
			},
			(error: unknown) => {
				if (this.key === key) this.fail(`Meteor image decoder unavailable: ${errorMessage(error)}`);
			},
		);
		this.loading = loading;
	}

	private symbols(soft: Int8Array): void {
		if (this.decoder) {
			this.decoder.push(soft);
			return;
		}
		this.pending.push(soft.slice());
		this.pendingLength += soft.length;
		while (this.pendingLength > PENDING_LIMIT) this.pendingLength -= this.pending.shift()!.length;
	}

	private fail(message: string): void {
		const key = this.key;
		this.reset();
		this.key = key;
		this.status.state = 'error';
		this.status.message = message;
		this.emit();
	}

	private emit(): void {
		this.lastEmit = performance.now();
		const status = this.status;
		status.locked = this.demodulator.locked;
		status.quality = this.demodulator.quality;
		status.freqOffsetHz = this.demodulator.freqOffsetHz;
		const decoder = this.decoder;
		let rows: MeteorRows | undefined;
		if (decoder) {
			const stats = decoder.stats();
			[status.rs, status.vit, status.mpdus] = [stats.rs, stats.vit, stats.mpdus];
			status.apids = [decoder.apid(0), decoder.apid(1), decoder.apid(2)];
			rows = selectRows(decoder, this.sentRows);
			if (rows) this.sentRows = rows.to;
			status.rows = this.sentRows;
		}
		if (status.state === 'receiving') status.message = this.receivingMessage();
		this.post({ type: 'meteor', freq: this.frequency, status: { ...status, apids: [...status.apids] }, ...(rows ? { rows } : {}) });
	}

	private receivingMessage(): string {
		const where = `${this.frequency.toFixed(3)} MHz`;
		if (this.status.mpdus) return `Receiving image on ${where}`;
		if (this.demodulator.locked) return `Locked on ${where}, waiting for image data`;
		return `Searching for the Meteor carrier on ${where}`;
	}
}
