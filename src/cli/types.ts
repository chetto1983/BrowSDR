import type { VfoParams } from '@/worker/runtime/types';
import type { DspInput, DspOutput } from '@/worker/runtime/dsp-messages.types';

export type DecoderName = 'adsb' | 'rtl433' | 'radiosonde' | 'meteor';

/** The subset of the Pi relay's GET /status that the CLI relies on. */
export interface RelayStatus {
	connected: boolean;
	state: { frequency_hz: number; sample_rate: number; gain_index: number };
	clients: Array<{ id: number; kind: string; remote: string; controller: boolean; client?: string }>;
}

export interface DecodeOptions {
	freq?: number;
	center?: number;
	rate?: number;
	gain?: number;
	take?: boolean;
	protocols?: string;
}

export interface DecodePlan {
	decoder: DecoderName;
	/** Controller tunes the shared dongle; listener decodes whatever band the controller chose. */
	role: 'controller' | 'listener';
	take: boolean;
	freqMHz: number;
	centerMHz: number;
	sampleRate: number;
	gainIndex: number;
	params: VfoParams;
}

/** One line of NDJSON output: `kind` is ours, because decoder payloads carry their own `type`. */
export interface OutputRecord {
	kind: 'rtl433' | 'aircraft' | 'radiosonde';
	time: string;
	freq_mhz: number;
	[field: string]: unknown;
}

/** Stand-in for a dedicated worker's global scope, so dsp-worker runs in-process under Node. */
export interface WorkerScope {
	postMessage(message: DspOutput): void;
	onmessage: ((event: { data: DspInput }) => Promise<void>) | null;
}

export interface DecodeRun extends DecodeOptions {
	relay: string;
	seconds: number;
	json: boolean;
}

/** What a decoder bookmark from the station file stands for on the command line. */
export interface BookmarkDecode {
	decoder: DecoderName;
	options: DecodeOptions & { freq: number };
}

export interface BookmarkSummary {
	id: string;
	name: string;
	freq_mhz: number;
	/** `decode <decoder>` for decoder groups, otherwise the demodulation mode for listening. */
	use: string;
}

export interface CliIo {
	out(line: string): void;
	err(line: string): void;
}

export interface DecoderProfile {
	freqMHz: number;
	sampleRate: number;
	/** Tuned centre relative to the channel, keeping the DC spike out of narrow decoders. */
	centerOffsetMHz: number;
	/** Half-width the decoder needs around its channel. */
	halfBandHz: number;
	minSampleRate: number;
	params(freqMHz: number, options: DecodeOptions): VfoParams;
}
