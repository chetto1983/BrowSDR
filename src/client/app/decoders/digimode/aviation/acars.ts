import {
	createDecoderSession,
	type AcarsInterpretation,
	type AssemblyStatus,
	type DecoderSession,
	type InterpretedAcarsRecord,
} from '@jlynx_/acars-decoder';
import { airportName } from '@jlynx_/acars-decoder/airports';
import type { DigimodeRecord } from '@/worker/decoders/digimode/types';
import { withFields } from './fields';
import type { AviationPart, Field } from './types';

/**
 * Blocks a source keeps: the library reassembles a message within five minutes (two between blocks), so a window a
 * little longer is enough; a source is one aircraft in one direction.
 */
const RETENTION_MS = 6 * 60_000;
const MAX_RECORDS = 64;
const MAX_SOURCES = 128;

const newSession = (): DecoderSession =>
	createDecoderSession({ airportLookup: airportName, maxSources: MAX_SOURCES, maxRecords: MAX_RECORDS, retentionMs: RETENTION_MS });

const coverage = (it: AcarsInterpretation): string => it.coverage + (it.coverageDetail ? `: ${it.coverageDetail}` : '');
const decodedSummary = (it: AcarsInterpretation): string => (it.coverage === 'unknown' || !it.summary ? '' : `: ${it.summary}`);

/** What the record's place in a multi-block message is, for its details. */
function assemblyLine(status: AssemblyStatus): string {
	const blocks = status.blocks ?? [];
	if (status.protocol !== 'ACARS') return `${status.protocol} ${status.status}${status.reason ? `: ${status.reason}` : ''}`;
	switch (status.status) {
		case 'pending':
			return `part ${blocks.length} of a message (blocks ${blocks.join(', ')} so far), waiting for more blocks`;
		case 'complete':
			return `the last of ${blocks.length} blocks (${blocks.join(', ')}); the message below is read from all of them`;
		case 'duplicate':
			return `received again (blocks ${blocks.join(', ')})`;
		default:
			return `not reassembled: ${status.reason ?? status.status}`;
	}
}

/** What the record's line says after the decoder's own text. */
function lineNote(status: AssemblyStatus | undefined, it: AcarsInterpretation): string {
	const blocks = status?.blocks ?? [];
	switch (status?.status) {
		case 'pending':
			return ` · part ${blocks.length} of a message, waiting for more blocks`;
		case 'complete':
			return ` · message of ${blocks.length} blocks${decodedSummary(it)}`;
		case 'duplicate':
			return ` · block received again${decodedSummary(it)}`;
		case 'failed':
		case 'expired':
			return ` · not reassembled${decodedSummary(it)}`;
		default:
			return decodedSummary(it);
	}
}

/** The record with the library's reading of its block (or of the message its block completes). */
function describe<T extends DigimodeRecord>(record: T, result: InterpretedAcarsRecord): T {
	const it = result.interpretation;
	const statuses = result.assemblies ?? [];
	const fields: Field[] = statuses.map((status): Field => [`${status.protocol} reassembly`, assemblyLine(status)]);
	fields.push(['ACARS message', `${it.title} (${coverage(it)})`]);
	if (it.summary) fields.push(['ACARS summary', it.summary]);
	for (const field of it.fields) fields.push([field.label, field.value]);
	if (result.assembledText !== undefined) fields.push(['Assembled text', result.assembledText]);
	if (it.notes.length) fields.push(['ACARS notes', it.notes.join(' ')]);
	const status = statuses.find((item) => item.protocol === 'ACARS');
	return withFields(record, fields, lineNote(status, it));
}

/**
 * ACARS blocks of one VFO (VDL2, HFDL): the ACARS library's decoder session reassembles multi-block messages (ETB
 * blocks up to the ETX one) per aircraft and direction and interprets each block, and the message a block completes.
 * Missing blocks are never filled in: a message with a gap stays unassembled.
 */
export class AcarsBlocks implements AviationPart {
	private session = newSession();
	private next = 1;

	read<T extends DigimodeRecord>(record: T): T {
		const app = record.application;
		if (app?.kind !== 'acars') return record;
		const { block } = app;
		const source = `${app.aircraft ?? `reg ${block.registration}`} ${block.direction}`;
		try {
			return describe(record, this.session.push({ ...block, id: this.next++, receivedAt: record.time }, source));
		} catch {
			return record;
		}
	}
}
