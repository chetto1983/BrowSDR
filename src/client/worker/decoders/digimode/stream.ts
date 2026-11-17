import type { DspProcessor } from '/wasm/dsp/browsdr_dsp.js';
import type { VfoParams } from '@/worker/runtime/types';
import { errorMessage } from '@/platform/errors';
import { digimodeInfo } from './catalog';
import { DIGIMODE_DECODERS } from './modes';
import type { DigimodeDecoder, DigimodeImageRows, DigimodeMessage, DigimodeRecord, DigimodeStatus } from './types';

/** Records waiting for the next message; a burst beyond this keeps the newest. */
const MAX_PENDING = 200;

/**
 * Runs the Digital Modes decoder chosen for this VFO: a channel of the mode's rate and width centred on the VFO,
 * handed to the decoder as complex baseband.
 */
export class DigimodeStream {
	private key = '';
	private mode = '';
	private frequency = 0;
	private ddc?: DspProcessor;
	private decoder?: DigimodeDecoder;
	private lastChunk?: number;
	private nextId = 1;
	private pending: DigimodeRecord[] = [];
	private image?: DigimodeImageRows;
	private changed = false;
	private lastEmit = 0;
	private status: DigimodeStatus = { state: 'off', message: 'Decoder off', records: 0, locked: false };

	constructor(
		private Processor: typeof DspProcessor,
		private memory: { buffer: ArrayBuffer },
		private post: (message: DigimodeMessage) => void,
	) {}

	configure(params: VfoParams, inputRate: number, centerFreq: number): void {
		this.frequency = params.freq;
		const info = digimodeInfo(params.digimode);
		if (!info) {
			if (this.key) {
				this.reset();
				this.emit();
			}
			return;
		}
		const key = JSON.stringify([info.id, params.freq, inputRate, centerFreq]);
		if (key === this.key) {
			this.applyStation(params);
			return;
		}
		this.reset();
		this.key = key;
		this.mode = info.id;
		const shiftHz = (params.freq - centerFreq) * 1e6 + (info.offsetHz ?? 0);
		if (inputRate < info.rate || Math.abs(shiftHz) + info.bandwidth / 2 > inputRate / 2) {
			this.fail(`${info.label} needs a ${info.bandwidth / 1000} kHz channel inside the received band. Center the radio near the VFO.`);
			return;
		}
		try {
			this.ddc = new this.Processor(inputRate, shiftHz, info.bandwidth);
			this.ddc.set_if_sample_rate(info.rate);
			this.ddc.set_bandwidth(info.bandwidth);
			this.decoder = DIGIMODE_DECODERS[info.id]({
				record: (record) => this.addRecord(record),
				status: (message, locked) => {
					this.status.message = message;
					this.status.locked = locked;
					this.changed = true;
				},
				image: (rows) => this.addImage(rows),
			});
			this.applyStation(params);
			this.status = { state: 'receiving', message: `${info.label} on ${params.freq.toFixed(3)} MHz`, records: 0, locked: false };
			this.emit();
		} catch (error) {
			this.fail(errorMessage(error));
		}
	}

	process(ptr: number, values: number, floatInput: boolean, chunkId?: number): void {
		if (!values || this.status.state !== 'receiving' || !this.ddc || !this.decoder) return;
		try {
			if (chunkId !== undefined && this.lastChunk !== undefined && chunkId !== this.lastChunk + 1) {
				this.decoder.reset();
				this.ddc.reset();
			}
			this.lastChunk = chunkId;
			const output = floatInput ? this.ddc.process_iq_only_f32_ptr(ptr, values) : this.ddc.process_iq_only_ptr(ptr, values);
			const count = this.ddc.get_iq_output_len();
			if (count) this.decoder.process(new Float32Array(this.memory.buffer, output, count));
			const elapsed = performance.now() - this.lastEmit;
			if ((this.changed && elapsed >= 250) || elapsed >= 1000) this.emit();
		} catch (error) {
			this.fail(errorMessage(error));
		}
	}

	/** The station location, for decoders that use one. */
	private applyStation(params: VfoParams): void {
		const station = params.digimodeStation;
		if (station && Number.isFinite(station.lat) && Number.isFinite(station.lon)) this.decoder?.setStation?.(station.lat, station.lon);
	}

	reset(): void {
		this.ddc?.free();
		this.ddc = undefined;
		this.decoder = undefined;
		this.key = '';
		this.mode = '';
		this.lastChunk = undefined;
		this.pending = [];
		this.image = undefined;
		this.changed = false;
		this.status = { state: 'off', message: 'Decoder off', records: 0, locked: false };
	}

	private addRecord(record: Omit<DigimodeRecord, 'id' | 'time' | 'mode'>): void {
		this.pending.push({ ...record, id: this.nextId++, time: Date.now(), mode: this.mode });
		if (this.pending.length > MAX_PENDING) this.pending.shift();
		this.status.records++;
		this.changed = true;
	}

	/** Rows are merged until the next message, so a picture travels in a few transfers per second. */
	private addImage(rows: DigimodeImageRows): void {
		const held = this.image;
		if (held && held.picture === rows.picture && held.width === rows.width && held.to === rows.from) {
			const rgb = new Uint8Array(held.rgb.length + rows.rgb.length);
			rgb.set(held.rgb);
			rgb.set(rows.rgb, held.rgb.length);
			this.image = { ...held, to: rows.to, rgb, title: rows.title };
		} else {
			if (held) this.emit();
			this.image = { ...rows, rgb: rows.rgb.slice() };
		}
		this.changed = true;
	}

	private fail(message: string): void {
		const key = this.key;
		const mode = this.mode;
		this.reset();
		this.key = key;
		this.mode = mode;
		this.status = { state: 'error', message, records: 0, locked: false };
		this.emit();
	}

	private emit(): void {
		this.lastEmit = performance.now();
		this.changed = false;
		const message: DigimodeMessage = {
			type: 'digimode',
			freq: this.frequency,
			mode: this.mode,
			status: { ...this.status },
			records: this.pending,
		};
		if (this.image) message.image = this.image;
		this.pending = [];
		this.image = undefined;
		this.post(message);
	}
}
