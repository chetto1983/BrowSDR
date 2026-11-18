import { decodeAtnCm, type AtnCmAddress, type AtnCmApplication } from '@jlynx_/acars-decoder';
import { hexOf } from './fields';
import type { AtnBits, AtnMessage, Field } from './types';

/** ATN applications by their AE qualifier (ICAO), as the logon lists name them. */
export const AE_NAMES: Record<number, string> = { 0: 'ADS-C', 1: 'CM', 2: 'CPDLC', 22: 'PM-CPDLC' };

const aeName = (qualifier: number): string => AE_NAMES[qualifier] ?? `AE qualifier ${qualifier}`;

const TYPES: Record<string, string> = {
	'logon-request': 'logon request',
	'logon-response': 'logon response',
	'contact-request': 'contact request',
	'contact-response': 'contact response',
	update: 'update',
	'forward-request': 'forward request',
	'forward-response': 'forward response',
	abort: 'abort',
	extension: 'extension',
};

/** A CM TSAP as its ASN.1 parts: routing domain part, address reference (ARS), LOC/SYS/NSEL/TSEL. */
const tsap = (a: AtnCmAddress): string =>
	[
		a.routingDomainPart ? `RDP ${hexOf(a.routingDomainPart)}` : '',
		a.addressReference ? `ARS ${hexOf(a.addressReference)}` : '',
		`LOC/SYS/NSEL/TSEL ${hexOf(a.localSystemNselTsel)}`,
	]
		.filter(Boolean)
		.join(' · ');

const applications = (list: AtnCmApplication[]): string =>
	list.map((app) => `${aeName(app.aeQualifier)} v${app.version}${app.address ? ` at ${tsap(app.address)}` : ''}`).join('; ');

/**
 * A CM message (Doc 9705 CMMessageSetVersion1): logon, contact, update, forward or abort, with the flight, the
 * addresses and the applications offered. Throws when the bits are not one.
 */
export function readCm(bits: AtnBits, direction: 'uplink' | 'downlink'): AtnMessage {
	const cm = decodeAtnCm(bits.payload, direction, bits.bitLength);
	const type = TYPES[cm.type] ?? cm.type;
	const partly = cm.structureComplete ? '' : ' (partly read)';
	const fields: Field[] = [['CM message', `${type}${partly}`]];
	if (cm.flightIdentification) fields.push(['CM flight', cm.flightIdentification]);
	if (cm.address) fields.push([direction === 'downlink' ? 'CM aircraft address' : 'CM address', tsap(cm.address)]);
	if (cm.addressedApplications) fields.push(['CM applications', applications(cm.addressedApplications)]);
	if (cm.otherApplications) fields.push(['CM other applications', applications(cm.otherApplications)]);
	if (cm.facility) fields.push(['CM facility', cm.facility]);
	if (cm.departure) fields.push(['CM departure', cm.departure]);
	if (cm.destination) fields.push(['CM destination', cm.destination]);
	const t = cm.departureDateTime;
	if (t) fields.push(['CM departure time', `${t.year}-${t.month}-${t.day} ${t.hour}:${String(t.minute).padStart(2, '0')}`]);
	if (cm.response) fields.push(['CM response', `${cm.response.meaning} (${cm.response.code})`]);
	if (cm.extension) fields.push(['CM extension', `${cm.extension.index}: ${hexOf(cm.extension.payload)}`]);
	const offered = [...(cm.addressedApplications ?? []), ...(cm.otherApplications ?? [])];
	const summary = [
		`CM ${type}`,
		cm.flightIdentification,
		cm.facility ? `${cm.type === 'contact-request' ? 'contact' : 'facility'} ${cm.facility}` : '',
		offered.length ? `applications ${offered.map((app) => `${aeName(app.aeQualifier)} v${app.version}`).join(', ')}` : '',
		cm.response ? cm.response.meaning : '',
	]
		.filter(Boolean)
		.join(', ');
	return { fields, summary: summary + partly, complete: cm.structureComplete };
}
