/** The Emscripten module built from wasm/meteor (meteor_decode plus BrowSDR's wrapper.c). */
export interface MeteorModule {
	HEAP8: Int8Array;
	HEAPU8: Uint8Array;
	/** `diffcoded` 1 differentially decodes the symbols (OQPSK downlinks), 0 leaves them as they are. */
	_meteor_init(diffcoded: number): void;
	_meteor_reset(): void;
	_meteor_input(): number;
	_meteor_input_size(): number;
	_meteor_push(count: number): number;
	_meteor_rows(): number;
	_meteor_width(): number;
	_meteor_channel_rows(index: number): number;
	_meteor_channel(index: number): number;
	_meteor_apid(index: number): number;
	_meteor_rs(): number;
	_meteor_vit(): number;
	_meteor_vcdu_seq(): number;
	_meteor_mpdus(): number;
	_meteor_block_time(block: number): number;
}

export type MeteorFactory = (options: { locateFile(path: string): string }) => Promise<MeteorModule>;

export type MeteorChannelIndex = 0 | 1 | 2;

/** LRPT modulation: plain QPSK, or offset QPSK (Q half a symbol late), which Meteor-M2 3 and 4 send. */
export type MeteorModulation = 'qpsk' | 'oqpsk';

export interface MeteorStats {
	/** Reed-Solomon errors corrected in the last CADU; -1 when it could not be corrected. */
	rs: number;
	/** Average Viterbi path cost per byte: lower is better, about 1100 or less decodes. */
	vit: number;
	vcduSeq: number;
	mpdus: number;
}

/** One meteor_decode instance: soft QPSK symbols in, AVHRR image rows out. */
export interface MeteorDecoder {
	/** Queues int8 soft symbols (two per QPSK symbol) and returns how many image rows were completed. */
	push(symbols: Int8Array): number;
	rows(): number;
	/** Rows of one channel that are final (later strips never rewrite them). */
	channelRows(index: MeteorChannelIndex): number;
	width(): number;
	/** Pixels of one composite channel (rows × width), viewed in WASM memory: copy before keeping. */
	channel(index: MeteorChannelIndex): Uint8Array;
	/** APID shown in that channel, or -1 while it is unused. */
	apid(index: MeteorChannelIndex): number;
	/** UTC milliseconds carried by the packet completing an eight-row block. */
	blockTime(block: number): number;
	stats(): MeteorStats;
	reset(): void;
}

export interface MeteorStatus {
	state: 'off' | 'receiving' | 'error';
	message: string;
	locked: boolean;
	quality: number;
	freqOffsetHz: number;
	rs: number;
	vit: number;
	mpdus: number;
	/** Image rows decoded so far. */
	rows: number;
	/** APID shown in each composite channel (red, green, blue), -1 while unused. */
	apids: [number, number, number];
}

/** New image rows from..to-1 of the three composite channels, each (to - from) × width pixels. */
export interface MeteorRows {
	from: number;
	to: number;
	width: number;
	channels: [Uint8Array, Uint8Array, Uint8Array];
	/** Sparse source timestamps; row is relative to this decoder's image, not this message. */
	timeBlocks?: Array<{ row: number; timeMs: number }>;
}

export interface MeteorMessage {
	type: 'meteor';
	freq: number;
	status: MeteorStatus;
	rows?: MeteorRows;
}
