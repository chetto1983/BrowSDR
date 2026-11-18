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
	/** Where what the record is about was, for maps (an aircraft's reported position). */
	position?: DigimodePosition;
	/** What the record carries for the app to decode (where the ACARS library is already loaded). */
	application?: DigimodeApplication;
}

/** An ATS application or a data link unit carried by a record, decoded in the app. */
export type DigimodeApplication = DigimodeCpdlcApplication | DigimodeAcarsApplication | DigimodeAtnApplication;

/** A FANS-1/A CPDLC message body (ARINC 622, CRC checked), as hex without its CRC (Aero). */
export interface DigimodeCpdlcApplication {
	kind: 'cpdlc';
	/** Ground to aircraft; the CPDLC message sets differ by direction. */
	uplink: boolean;
	hex: string;
}

/** An ACARS block whose check sequence is good (VDL2, HFDL), for the app to reassemble and interpret. */
export interface DigimodeAcarsApplication {
	kind: 'acars';
	/** The aircraft's 24-bit address, six hex digits, when the link names it (VDL2); the registration keys it otherwise. */
	aircraft?: string;
	block: DigimodeAcarsBlock;
}

/** The ARINC 618 envelope of one block, as the ACARS library's records have it. */
export interface DigimodeAcarsBlock {
	/** Two characters; the DEL of "_<DEL>" as 'd'. */
	label: string;
	/** The text as received (parity removed), after the downlink's message number and flight. */
	text: string;
	direction: 'uplink' | 'downlink';
	registration: string;
	mode: string;
	/** 'NAK', or the block id acknowledged. */
	acknowledgement: string;
	blockId: string;
	/** Downlink: message number and block sequence letter ("M01A"). */
	messageNumber?: string;
	flight?: string;
	/** ETB: more blocks of the message follow. */
	continuation: boolean;
}

/** The information field of a VDL2 AVLC I frame that carries X.25 (ATN), the frame's check sequence good. */
export interface DigimodeAtnApplication {
	kind: 'atn';
	/** Aircraft to ground is downlink. */
	direction: 'uplink' | 'downlink';
	source: DigimodeAvlcAddress;
	destination: DigimodeAvlcAddress;
	/** The X.25 packet, upper case hex. */
	hex: string;
}

/** An AVLC address. */
export interface DigimodeAvlcAddress {
	/** 24-bit address, six upper case hex digits. */
	address: string;
	/** 1 aircraft, 4 and 5 ground station (ADM, DEL); the frames sent are between an aircraft and a ground station. */
	type: number;
}

/** A position a record reports. */
export interface DigimodePosition {
	/** What is located: an ICAO address in hex, or another id of the mode. */
	id: string;
	lat: number;
	lon: number;
	/** A flight or a call. */
	label?: string;
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
	/** The station location in degrees, for decoders that use one (positions relative to it, distances). */
	setStation?(lat: number, lon: number): void;
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
	/** Channel centre above the VFO (dial) frequency, Hz; an upper-sideband mode sets half its audio band. */
	offsetHz?: number;
	presets: DigimodePreset[];
	/** Produces pictures. */
	image?: boolean;
	/** OnAir source the decoder is ported from. */
	source: string;
}
