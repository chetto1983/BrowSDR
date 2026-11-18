import { decodeAtnUlcs, type AtnAcse, type AtnUlcs } from '@jlynx_/acars-decoder';
import { AE_NAMES, readCm } from './cm';
import { plainCpdlc, protectedCpdlc } from './cpdlc';
import { hexOf, remember, scalar } from './fields';
import type { AtnApplicationKind, AtnBits, AtnMessage, AtnReader, AtnTsdu, Field } from './types';

/** The applications by the AE qualifier an association names (ICAO numbering). */
const KINDS: Record<number, AtnApplicationKind> = { 0: 'adsc', 1: 'cm', 2: 'cpdlc', 22: 'pm-cpdlc' };
const NAMES: Record<AtnApplicationKind, string> = { cm: 'CM', cpdlc: 'CPDLC', 'pm-cpdlc': 'PM-CPDLC', adsc: 'ADS-C' };
const READERS: Record<Exclude<AtnApplicationKind, 'adsc'>, AtnReader> = { cm: readCm, cpdlc: plainCpdlc, 'pm-cpdlc': protectedCpdlc };
const RESULTS = ['accepted', 'rejected (permanent)', 'rejected (transient)'];

const errorText = (error: unknown): string => (error instanceof Error ? error.message : 'not readable');
const bitsText = (bits: AtnBits): string => `${bits.bitLength} bits ${hexOf(bits.payload)}`;

/** The AE qualifier an association names: the called (else calling) one of an AARQ, the responding one of an AARE. */
function qualifier(acse: AtnAcse): number | undefined {
	const f = acse.fields;
	const q = acse.type === 'AARE' ? f.respondingAEQualifier : (f.calledAEQualifier ?? f.callingAEQualifier);
	return typeof q === 'number' ? q : undefined;
}

function acseLine(acse: AtnAcse): Field {
	const f = acse.fields;
	const q = qualifier(acse);
	const parts = [
		acse.type,
		typeof f.applicationContextName === 'string' ? `application context ${f.applicationContextName}` : '',
		q === undefined ? '' : `AE qualifier ${q} (${AE_NAMES[q] ?? 'not known here'})`,
		acse.type === 'AARE' ? `result ${RESULTS[Number(f.result)] ?? scalar(f.result)}` : '',
		f.reason === undefined ? '' : `reason ${scalar(f.reason)}`,
		acse.structureComplete ? '' : 'partly read',
	];
	return ['ATN ACSE', parts.filter(Boolean).join(', ')];
}

function sessionLine(u: AtnUlcs): string {
	const incomplete = u.envelopeComplete ? '' : ', envelope not complete';
	if (u.mode === 'data') return `data transfer, ${u.values.length} presentation value(s)${incomplete}`;
	const refusal = u.presentation?.error ? `, refused: ${u.presentation.error.description}` : '';
	return `connection: session ${u.session?.type}, presentation ${u.presentation?.type}${refusal}${incomplete}`;
}

/** Reads the bits as CM, CPDLC and PM-CPDLC in the known direction, and keeps the one that reads completely. */
function trial(bits: AtnBits, direction: 'uplink' | 'downlink'): AtnMessage {
	const found: Array<[AtnApplicationKind, AtnMessage]> = [];
	for (const kind of ['cm', 'cpdlc', 'pm-cpdlc'] as const) {
		try {
			const message = READERS[kind](bits, direction);
			if (message.complete) found.push([kind, message]);
		} catch {
			// not this application
		}
	}
	if (found.length === 1) {
		const [kind, message] = found[0];
		const how = `${NAMES[kind]}, identified by trial: of CM, CPDLC and PM-CPDLC (${direction}) only it reads completely`;
		return { ...message, fields: [['ATN application', how], ...message.fields] };
	}
	const why = found.length
		? `ambiguous, it reads completely as ${found.map(([kind]) => NAMES[kind]).join(' and ')}`
		: 'neither CM, CPDLC nor PM-CPDLC reads completely';
	return { fields: [['ATN application', `not identified (${why}): ${bitsText(bits)}`]], summary: '', complete: false };
}

/**
 * The ATN upper layers of one VFO, with the ACARS library: the short session and presentation headers and the ACSE of a
 * connection's first TSDUs, the presentation values of the data that follows, and the application messages. Which
 * application a connection carries comes from the AE qualifier its AARQ or AARE names, when one was received; without
 * it each message is read as CM, CPDLC and PM-CPDLC in the known direction and taken only if exactly one reads to its
 * end. The record says which way was used.
 */
export class AtnApplications {
	/** The application of a connection, from its ACSE. */
	private readonly known = new Map<string, AtnApplicationKind>();

	read(tsdu: AtnTsdu, downlink: boolean): { fields: Field[]; summary: string } {
		let ulcs: AtnUlcs;
		try {
			ulcs = decodeAtnUlcs(tsdu.payload, tsdu.payload[0] === 0 ? 'data' : 'connection');
		} catch (error) {
			return { fields: [['ATN session', `not read (${errorText(error)}): ${hexOf(tsdu.payload)}`]], summary: '' };
		}
		const fields: Field[] = [['ATN session', sessionLine(ulcs)]];
		const acses = [ulcs.acse, ...ulcs.values.map((value) => value.acse)].filter((acse): acse is AtnAcse => !!acse);
		for (const acse of acses) {
			fields.push(acseLine(acse));
			const q = qualifier(acse);
			if (q !== undefined && KINDS[q]) remember(this.known, tsdu.connection, KINDS[q]);
		}
		const pieces: AtnBits[] = [
			...acses.flatMap((acse) => acse.userInformation),
			...ulcs.values.filter((value) => value.context === 'user-ase-apdu'),
		];
		const summaries: string[] = [];
		for (const bits of pieces) {
			const message = this.application(bits, downlink ? 'downlink' : 'uplink', tsdu.connection);
			fields.push(...message.fields);
			if (message.summary) summaries.push(message.summary);
		}
		return { fields, summary: summaries.join('; ') };
	}

	private application(bits: AtnBits, direction: 'uplink' | 'downlink', connection: string): AtnMessage {
		if (!bits.bitLength) return { fields: [], summary: '', complete: true };
		const kind = this.known.get(connection);
		if (!kind) return trial(bits, direction);
		const how = `${NAMES[kind]}, from the AE qualifier of the connection's ACSE`;
		if (kind === 'adsc')
			return { fields: [['ATN application', `${how}; not decoded: ${bitsText(bits)}`]], summary: 'ADS-C (not decoded)', complete: false };
		try {
			const message = READERS[kind](bits, direction);
			return { ...message, fields: [['ATN application', how], ...message.fields] };
		} catch (error) {
			return {
				fields: [['ATN application', `${how}; not read (${errorText(error)}): ${bitsText(bits)}`]],
				summary: `${NAMES[kind]} not read`,
				complete: false,
			};
		}
	}
}
