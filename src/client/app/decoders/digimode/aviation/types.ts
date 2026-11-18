import type { DigimodeRecord } from '@/worker/decoders/digimode/types';

/** A labelled line of a record's details. */
export type Field = [label: string, value: string];

/** What one decoder of a VFO's aviation state does with a record that carries its kind of application. */
export interface AviationPart {
	read<T extends DigimodeRecord>(record: T): T;
}

/** An X.25 packet of a VDL2 frame between an aircraft and a ground station, as the ATN stack reads it. */
export interface AtnFrame {
	/** AVLC addresses of the two ends, six hex digits. */
	air: string;
	ground: string;
	downlink: boolean;
	bytes: Uint8Array;
	/** Reception time, ms, never decreasing. */
	time: number;
}

/** What a layer read: lines for the record and what it hands to the layer above. */
export interface AtnLayer<T> {
	fields: Field[];
	up?: T;
}

/** A complete network service data unit (a COTP NSDU) with the NSAPs of the CLNP PDU (or compression context) it came in. */
export interface AtnNsdu {
	bytes: Uint8Array;
	source: Uint8Array;
	destination: Uint8Array;
}

/** A complete transport service data unit. */
export interface AtnTsdu {
	payload: Uint8Array;
	/** The transport connection: the library's connection id, or link, direction and reference of a single DT. */
	connection: string;
	/** Assembled on a connection whose CR and CC were received, or one DT read on its own. */
	how: 'session' | 'single';
}

/** The ATN applications read (by the ICAO AE qualifiers: 1 CM, 2 CPDLC, 22 PM-CPDLC, 0 ADS-C). */
export type AtnApplicationKind = 'cm' | 'cpdlc' | 'pm-cpdlc' | 'adsc';

/** An application message as fields, a one-line summary and whether its whole bit string was read. */
export interface AtnMessage {
	fields: Field[];
	summary: string;
	complete: boolean;
}

/** A PER bit string (the library's AtnBitString). */
export interface AtnBits {
	payload: Uint8Array;
	bitLength: number;
}

/** Reads one application's message from its bits in a known direction; throws when the bits are not one. */
export type AtnReader = (bits: AtnBits, direction: 'uplink' | 'downlink') => AtnMessage;
