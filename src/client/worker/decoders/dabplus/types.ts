/** The faad2 build of wasm/faad2 (see wrapper.c). */
export interface FaadModule {
	HEAPU8: Uint8Array;
	HEAPF32: Float32Array;
	_dab_aac_open(asc: number, length: number): number;
	_dab_aac_decode(handle: number, au: number, length: number, out: number, maxFrames: number): number;
	_dab_aac_rate(handle: number): number;
	_dab_aac_channels(handle: number): number;
	_dab_aac_error(handle: number): number;
	_dab_aac_sbr(handle: number): number;
	_dab_aac_ps(handle: number): number;
	_dab_aac_close(handle: number): void;
	_malloc(bytes: number): number;
	_free(pointer: number): void;
}

export type FaadFactory = (options: { locateFile(path: string): string }) => Promise<FaadModule>;

/** One DAB+ AAC stream: access units in, 48 kHz interleaved stereo out. */
export interface AacDecoder {
	/** Decodes an access unit; null when faad2 rejects it (the caller conceals). */
	decode(au: Uint8Array): Float32Array | null;
	/** Output rate of faad2 before the resampling to 48 kHz. */
	readonly rate: number;
	close(): void;
}

export interface DabComponentInfo {
	subchannel: number;
	dabPlus: boolean;
	bitrate: number;
	protection: string;
	primary: boolean;
}

export interface DabServiceInfo {
	sid: number;
	label: string;
	shortLabel?: string;
	components: DabComponentInfo[];
}

export interface DabStatus {
	state: 'off' | 'loading' | 'searching' | 'synced' | 'error';
	message: string;
	ensemble: string;
	eid: number;
	services: DabServiceInfo[];
	/** Service being played (SId), 0 for none. */
	service: number;
	serviceLabel: string;
	/** Dynamic label (now playing). */
	label: string;
	codec: string;
	bitrate: number;
	snrDb: number;
	/** Access units decoded / lost since the service was chosen. */
	audioUnits: number;
	audioErrors: number;
}

export interface DabMessage {
	type: 'dab';
	freq: number;
	status: DabStatus;
}
