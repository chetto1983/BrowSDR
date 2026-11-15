import type { DspProcessor } from '/wasm/dsp/browsdr_dsp.js';
import type { VfoParams } from '@/worker/runtime/types';
import { TetraDemodulator, TETRA_RATE } from '@/worker/decoders/tetra/demodulator';
import { errorMessage } from '@/platform/errors';
import type { TetraEarSymbols } from './types';

/** Stream demodulated soft bits to the optional TetraEar bridge; never owns the radio. */
export class TetraEarStream {
	private ddc?: DspProcessor;
	private key = '';
	private freq = 0;
	private session = 0;
	private lastChunk?: number;
	private bits = new Int8Array(2040);
	private length = 0;
	private demod = new TetraDemodulator((a, b) => {
		this.bits[this.length++] = this.soft(a);
		this.bits[this.length++] = this.soft(b);
		if (this.length === this.bits.length) this.flush();
	});

	constructor(
		private Processor: typeof DspProcessor,
		private memory: { buffer: ArrayBuffer },
		private post: (message: TetraEarSymbols) => void,
	) {}

	configure(params: VfoParams, rate: number, center: number): void {
		const key = params.tetraear ? JSON.stringify([params.tetraear, params.freq, rate, center]) : '';
		if (key === this.key) return;
		this.reset();
		this.key = key;
		if (!key) return;
		this.freq = params.freq;
		this.session = params.tetraear!;
		try {
			if (
				!Number.isFinite(params.freq) ||
				!Number.isFinite(rate) ||
				!Number.isFinite(center) ||
				rate < TETRA_RATE ||
				Math.abs(params.freq - center) * 1e6 + TETRA_RATE / 2 > rate / 2
			)
				throw new Error('TetraEar needs a 72 kHz channel entirely inside the received band.');
			this.ddc = new this.Processor(rate, (params.freq - center) * 1e6, TETRA_RATE);
			this.ddc.set_if_sample_rate(TETRA_RATE);
			this.ddc.set_bandwidth(25000);
			this.emit({ reset: true });
		} catch (error) {
			this.fail(error);
		}
	}

	process(ptr: number, values: number, floatInput: boolean, chunkId?: number): void {
		if (!this.ddc || !values) return;
		try {
			if (this.lastChunk !== undefined && chunkId !== undefined && chunkId !== this.lastChunk + 1) {
				this.demod.reset();
				this.ddc.reset();
				this.length = 0;
				this.emit({ reset: true });
			}
			this.lastChunk = chunkId;
			const output = floatInput ? this.ddc.process_iq_only_f32_ptr(ptr, values) : this.ddc.process_iq_only_ptr(ptr, values);
			const count = this.ddc.get_iq_output_len();
			if (count) this.demod.process(new Float32Array(this.memory.buffer, output, count));
		} catch (error) {
			this.fail(error);
		}
	}

	reset(): void {
		this.ddc?.free();
		this.ddc = undefined;
		this.demod.reset();
		this.lastChunk = undefined;
		this.length = 0;
		this.key = '';
	}

	private soft(value: number): number {
		return Math.max(-127, Math.min(127, Math.round(-value * 127)));
	}

	private flush(): void {
		this.emit({ bits: this.bits.buffer });
		this.bits = new Int8Array(2040);
		this.length = 0;
	}

	private emit(value: Partial<TetraEarSymbols>): void {
		this.post({ type: 'tetraear_symbols', freq: this.freq, session: this.session, ...value });
	}

	private fail(error: unknown): void {
		this.ddc?.free();
		this.ddc = undefined;
		this.emit({ error: errorMessage(error) });
	}
}
