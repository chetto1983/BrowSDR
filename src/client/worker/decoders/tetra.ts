import type { DspProcessor } from '/wasm/dsp/browsdr_dsp.js';
import type { VfoParams } from '@/worker/runtime/types';
import type { TetraMessage, TetraStatus } from './tetra/types';
import { TetraDemodulator, TETRA_RATE } from './tetra/demodulator';
import { SyncBurstFinder } from './tetra/bursts';
import { TetraCells } from './tetra/tracker';
import { errorMessage } from '@/platform/errors';

export { TETRA_RATE };
/** TETRA downlinks in Europe: 380-400 MHz public safety, 410-430 and 450-470 MHz civil networks. */
export const isTetraFrequency = (frequency: number): boolean => Number.isFinite(frequency) && frequency >= 300 && frequency <= 935;

const idleStatus = (): TetraStatus => ({
	state: 'off',
	message: 'Decoder off',
	samples: 0,
	bursts: 0,
	frames: 0,
	quality: 0,
	freqOffsetHz: 0,
});

/**
 * Decodes the broadcast control information of one TETRA downlink carrier: network (MCC/MNC), colour
 * code and the cell's SYSINFO. Only main carriers send synchronisation bursts. Traffic and voice are
 * never decoded.
 */
export class TetraStream {
	private key = '';
	private frequency = 391;
	private ddc?: DspProcessor;
	private lastChunk?: number;
	private cells = new TetraCells();
	private finder = new SyncBurstFinder((burst) => this.cells.process(burst));
	private demodulator = new TetraDemodulator((a, b) => this.finder.pushSymbol(a, b));
	private lastEmit = 0;
	private status = idleStatus();
	constructor(
		private Processor: typeof DspProcessor,
		private memory: { buffer: ArrayBuffer },
		private post: (message: TetraMessage) => void,
	) {}

	configure(params: VfoParams, inputRate: number, centerFreq: number): void {
		this.frequency = params.freq;
		if (!params.tetra) {
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
		if (!isTetraFrequency(params.freq)) {
			this.fail('Tune this VFO to a TETRA downlink carrier (380-470 MHz in Europe).');
			return;
		}
		if (inputRate < TETRA_RATE || Math.abs(params.freq - centerFreq) * 1e6 + TETRA_RATE / 2 > inputRate / 2) {
			this.fail('TETRA needs a 72 kHz channel inside the received band. Move the center frequency closer to the carrier.');
			return;
		}
		try {
			this.ddc = new this.Processor(inputRate, (params.freq - centerFreq) * 1e6, TETRA_RATE);
			this.ddc.set_if_sample_rate(TETRA_RATE);
			this.ddc.set_bandwidth(25000);
			this.status.state = 'receiving';
			this.status.message = `Searching for sync on ${params.freq.toFixed(4)} MHz`;
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
				this.finder.reset();
				this.ddc.reset();
			}
			this.lastChunk = chunkId;
			const output = floatInput ? this.ddc.process_iq_only_f32_ptr(ptr, values) : this.ddc.process_iq_only_ptr(ptr, values);
			const count = this.ddc.get_iq_output_len();
			if (count) this.demodulator.process(new Float32Array(this.memory.buffer, output, count));
			this.status.samples += count / 2;
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
		this.cells = new TetraCells();
		this.finder.reset();
		this.finder.bursts = 0;
		this.demodulator.reset();
		this.status = idleStatus();
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
		status.bursts = this.finder.bursts;
		status.frames = this.cells.frames;
		status.quality = this.demodulator.quality;
		status.freqOffsetHz = this.demodulator.freqOffsetHz;
		if (status.state === 'receiving') status.message = this.receivingMessage();
		this.post({ type: 'tetra', freq: this.frequency, status: { ...status }, cells: this.cells.snapshot() });
	}

	private receivingMessage(): string {
		const where = `${this.frequency.toFixed(4)} MHz`;
		if (this.cells.frames) return `Locked on ${where}`;
		if (this.status.samples < TETRA_RATE) return `Searching for sync on ${where}`;
		if (this.demodulator.quality < 0.35) return `No TETRA signal on ${where}`;
		return `TETRA signal on ${where} but no sync bursts: a traffic carrier, or not the cell's main carrier`;
	}
}
