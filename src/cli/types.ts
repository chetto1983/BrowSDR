import type { VfoParams } from '@/worker/runtime/types';
import type { Pass, Site, Tle } from '@/satellites/types';
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
	kind: 'rtl433' | 'aircraft' | 'radiosonde' | 'meteor';
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
	/** Directory for decoded images (Meteor PNGs); default the current directory. */
	out?: string;
	/** File name prefix of the Meteor PNG (default "meteor"). */
	pngPrefix?: string;
}

/** Decoding a recording instead of the relay: --center and --rate describe the file. */
export interface FileDecodeRun extends DecodeOptions {
	iqFile: string;
	json: boolean;
	out?: string;
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

export interface NextPassOptions {
	site: Site;
	repeat: boolean;
	take: boolean;
	/** Stop after this many passes (tests); unlimited when absent. */
	maxPasses?: number;
}

/** What --next-pass needs from the outside world, so tests can run it on a fake clock. */
export interface NextPassDeps {
	now(): Date;
	sleep(ms: number): Promise<void>;
	tles(now: Date): Promise<Tle[]>;
	status(): Promise<RelayStatus>;
	capture(pass: Pass, plan: DecodePlan): Promise<void>;
}

/** The command-line flags `decode` reads (as parseArgs returns them). */
export interface DecodeFlags {
	freq?: string;
	center?: string;
	rate?: string;
	gain?: string;
	protocols?: string;
	out?: string;
	seconds?: string;
	lat?: string;
	lon?: string;
	json: boolean;
	take: boolean;
	'next-pass': boolean;
	repeat: boolean;
}
