/** One decoded item (a call, a message, a frame), as the log shows it. */
export interface DigimodeRecord {
	/** Increasing per decoder run, so the app can drop duplicates. */
	id: number;
	/** Wall clock, ms. */
	time: number;
	mode: string;
	/** One-line summary. */
	text: string;
	/** Labelled details for the expanded view. */
	fields?: Array<[label: string, value: string]>;
	/** A record that failed its check (shown dimmed). */
	damaged?: boolean;
	/** Alert-worthy content, such as a DSC distress call. */
	alert?: boolean;
}

export interface DigimodeStatus {
	state: 'off' | 'receiving' | 'error';
	message: string;
	/** Records decoded in this run. */
	records: number;
	/** Locked to a signal (sync found). */
	locked: boolean;
}

/** New picture rows (SSTV, fax): RGB bytes, `width` pixels per row. */
export interface DigimodeImageRows {
	/** Changes when a new picture starts. */
	picture: number;
	title: string;
	width: number;
	from: number;
	to: number;
	rgb: Uint8Array;
}

export interface DigimodeMessage {
	type: 'digimode';
	freq: number;
	mode: string;
	status: DigimodeStatus;
	/** Records decoded since the previous message. */
	records: DigimodeRecord[];
	image?: DigimodeImageRows;
}

/** What a decoder can report; the stream turns it into messages. */
export interface DigimodeSink {
	record(record: Omit<DigimodeRecord, 'id' | 'time' | 'mode'>): void;
	/** Lock state and a short status line ("Searching", "Locked, 1200 bd"). */
	status(message: string, locked: boolean): void;
	image?(rows: Omit<DigimodeImageRows, 'rgb'> & { rgb: Uint8Array }): void;
}

/** A decoder fed with complex baseband (interleaved I/Q) at its catalog rate, centred on the VFO. */
export interface DigimodeDecoder {
	process(iq: Float32Array): void;
	reset(): void;
}

export interface DigimodePreset {
	label: string;
	freqMHz: number;
}

/** Shared by the app (mode list, tuning) and the worker (channel). */
export interface DigimodeInfo {
	id: string;
	label: string;
	family: string;
	description: string;
	/** Complex sample rate the decoder wants, Hz. */
	rate: number;
	/** Channel filter width, Hz. */
	bandwidth: number;
	presets: DigimodePreset[];
	/** Produces pictures. */
	image?: boolean;
	/** OnAir source the decoder is ported from. */
	source: string;
}
