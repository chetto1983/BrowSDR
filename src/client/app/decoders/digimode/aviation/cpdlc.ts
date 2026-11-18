import { decodeAtnCpdlc, type AtnCpdlc, type AtnCpdlcValue } from '@jlynx_/acars-decoder';
import { hexOf, scalar } from './fields';
import type { AtnBits, AtnMessage, Field } from './types';

/**
 * The standard wording (ICAO Doc 4444, Doc 9705) of common CPDLC message elements; the others are named by their
 * ASN.1 element (number and parameter type). The parameters follow.
 */
const PHRASES: Record<string, string> = {
	UM0: 'UNABLE',
	UM1: 'STANDBY',
	UM2: 'REQUEST DEFERRED',
	UM3: 'ROGER',
	UM4: 'AFFIRM',
	UM5: 'NEGATIVE',
	UM19: 'MAINTAIN',
	UM20: 'CLIMB TO',
	UM23: 'DESCEND TO',
	UM74: 'PROCEED DIRECT TO',
	UM106: 'MAINTAIN',
	UM107: 'MAINTAIN PRESENT SPEED',
	UM116: 'RESUME NORMAL SPEED',
	UM117: 'CONTACT',
	UM120: 'MONITOR',
	UM123: 'SQUAWK',
	UM133: 'REPORT PRESENT LEVEL',
	UM157: 'CHECK STUCK MICROPHONE',
	UM159: 'ERROR',
	UM160: 'NEXT DATA AUTHORITY',
	UM161: 'END SERVICE',
	UM165: 'THEN',
	UM179: 'SQUAWK IDENT',
	UM190: 'FLY HEADING',
	UM211: 'REQUEST FORWARDED',
	UM222: 'NO SPEED RESTRICTION',
	UM227: 'LOGICAL ACKNOWLEDGEMENT',
	UM237: 'REQUEST AGAIN WITH NEXT UNIT',
	DM0: 'WILCO',
	DM1: 'UNABLE',
	DM2: 'STANDBY',
	DM3: 'ROGER',
	DM4: 'AFFIRM',
	DM5: 'NEGATIVE',
	DM6: 'REQUEST',
	DM9: 'REQUEST CLIMB TO',
	DM10: 'REQUEST DESCENT TO',
	DM18: 'REQUEST',
	DM22: 'REQUEST DIRECT TO',
	DM32: 'PRESENT LEVEL',
	DM62: 'ERROR',
	DM63: 'NOT CURRENT DATA AUTHORITY',
	DM65: 'DUE TO WEATHER',
	DM66: 'DUE TO AIRCRAFT PERFORMANCE',
	DM89: 'MONITORING',
	DM99: 'CURRENT DATA AUTHORITY',
	DM100: 'LOGICAL ACKNOWLEDGEMENT',
	DM107: 'NOT AUTHORIZED NEXT DATA AUTHORITY',
};

/**
 * The `send` alternative (index 3) of GroundPDUs and AircraftPDUs, as their CHOICE preamble: the extension bit, then
 * the index in 3 bits (6 root alternatives) or 2 bits (4). Its type is ATCUplinkMessage / ATCDownlinkMessage, the type
 * whose PER encoding a protected message carries (Doc 9705 PM-CPDLC, CPDLCMessage), so these bits put in front of
 * that encoding let the library's plain reader read it.
 */
const SEND_PREAMBLE = { uplink: '0011', downlink: '011' } as const;

const pad2 = (n: unknown): string => scalar(n).padStart(2, '0');

/** The first node of `type` in the tree (extension values included). */
function find(value: AtnCpdlcValue, type: string): AtnCpdlcValue | undefined {
	if (value.type === type) return value;
	for (const child of [...(value.children ?? []), ...(value.extensions ?? []).flatMap((e) => (e.value ? [e.value] : []))]) {
		const found = find(child, type);
		if (found) return found;
	}
	return undefined;
}

function findAll(value: AtnCpdlcValue, test: (v: AtnCpdlcValue) => boolean, out: AtnCpdlcValue[] = []): AtnCpdlcValue[] {
	if (test(value)) out.push(value);
	else for (const child of value.children ?? []) findAll(child, test, out);
	return out;
}

const leafValue = (v: AtnCpdlcValue, type: string): unknown => find(v, type)?.value;

function measurementText(m: NonNullable<AtnCpdlcValue['measurement']>): string {
	if (m.unit === 'flight-level') return `FL${m.value}`;
	if (m.unit === 'metric-flight-level') return `flight level ${m.value} (metric, 10 m)`;
	return `${m.value} ${m.unit}${m.reference ? ` ${m.reference}` : ''}`;
}

/** The values of a parameter, compactly: times as hh:mm, measurements with their unit, names of enumerations. */
function valueText(v: AtnCpdlcValue): string {
	if (v.type === 'Time' || v.type === 'Timehhmmss') return times(v);
	if (v.measurement) return measurementText(v.measurement);
	if (v.enumeration) return v.enumeration;
	if (v.value !== undefined && v.value !== null) {
		if (typeof v.value === 'object') return `${v.value.bitLength} bits ${hexOf(v.value.payload, 32)}`;
		return String(v.value);
	}
	const parts = [...(v.children ?? []), ...(v.extensions ?? []).flatMap((e) => (e.value ? [e.value] : []))];
	return parts.map(valueText).filter(Boolean).join(' ');
}

function times(v: AtnCpdlcValue): string {
	const hh = leafValue(v, 'TimeHours');
	const mm = leafValue(v, 'TimeMinutes');
	const ss = leafValue(v, 'TimeSeconds');
	return `${pad2(hh)}:${pad2(mm)}${ss === undefined ? '' : `:${pad2(ss)}`}`;
}

/** One message element: "UM117 CONTACT EDYY center 132.6 MHz". */
function elementText(element: AtnCpdlcValue): string {
	const choice = element.choice ?? '';
	const [, side, number, type] = /^([ud])M(\d+)(.*)$/.exec(choice) ?? [];
	if (!side) return choice;
	const id = `${side.toUpperCase()}M${number}`;
	const head = PHRASES[id] ?? (type === 'NULL' ? '' : type);
	const body = valueText(element);
	return [id, head, body].filter(Boolean).join(' ');
}

/** The header and elements of an ATC message, or the values of another alternative (abort, forward). */
function messageFields(root: AtnCpdlcValue): AtnMessage {
	const fields: Field[] = [];
	const header = find(root, 'ATCMessageHeader');
	if (header) {
		fields.push(['CPDLC message id', scalar(leafValue(header, 'MsgIdentificationNumber'))]);
		const reference = leafValue(header, 'MsgReferenceNumber');
		if (reference !== undefined) fields.push(['CPDLC reference', scalar(reference)]);
		const date = find(header, 'Date');
		const time = find(header, 'Timehhmmss');
		if (date && time)
			fields.push([
				'CPDLC time',
				`${scalar(leafValue(date, 'Year'))}-${pad2(leafValue(date, 'Month'))}-${pad2(leafValue(date, 'Day'))} ${times(time)} UTC`,
			]);
		const ack = find(header, 'LogicalAck');
		if (ack?.enumeration) fields.push(['CPDLC logical acknowledgement', ack.enumeration]);
	}
	const elements = findAll(root, (v) => /^ATC(Up|Down)linkMsgElementId$/.test(v.type)).map(elementText);
	elements.forEach((text, i) => fields.push([`CPDLC element ${i + 1}`, text]));
	const constrained = findAll(root, (v) => /^T_atc(up|down)linkmessagedata_constraineddata$/.test(v.type))[0];
	if (constrained) fields.push(['CPDLC constrained data', valueText(constrained)]);
	const mode = find(root, 'Mode');
	if (mode?.enumeration) fields.push(['CPDLC mode', mode.enumeration]);
	const what = elements.length ? elements.join('; ') : `${root.choice ?? root.type} ${valueText(root)}`.trim();
	return { fields, summary: what, complete: true };
}

/** A plain CPDLC message (GroundPDUs uplink, AircraftPDUs downlink). Throws when the bits are not one. */
export function plainCpdlc(bits: AtnBits, direction: 'uplink' | 'downlink'): AtnMessage {
	const decoded = decodeAtnCpdlc(bits.payload, { direction, mode: 'plain', bitLength: bits.bitLength });
	const message = messageFields(decoded.value);
	const partly = decoded.structureComplete ? '' : ' (partly read)';
	return {
		fields: [['CPDLC message', message.summary + partly], ...message.fields],
		summary: `CPDLC ${message.summary}${partly}`,
		complete: decoded.structureComplete,
	};
}

/** No bit set from `from` on. */
function zeroFrom(bytes: Uint8Array, from: number): boolean {
	for (let i = from; i < bytes.length * 8; i++) if ((bytes[i >> 3] >> (7 - (i & 7))) & 1) return false;
	return true;
}

/**
 * The inner message of a protected one: its bits (an ATC message's PER encoding) after the `send` preamble, read by
 * the library's plain reader. Complete when the reader stopped inside them and only zero padding follows (the inner
 * encoding is octet padded, which the reader's own completeness check counts as unread octets).
 */
function innerMessage(inner: AtnBits, direction: 'uplink' | 'downlink'): { decoded: AtnCpdlc; complete: boolean } {
	const preamble = SEND_PREAMBLE[direction];
	const total = preamble.length + inner.bitLength;
	const bytes = new Uint8Array(Math.ceil(total / 8));
	const put = (bit: number, at: number) => (bytes[at >> 3] |= bit << (7 - (at & 7)));
	[...preamble].forEach((bit, i) => put(Number(bit), i));
	for (let i = 0; i < inner.bitLength; i++) put((inner.payload[i >> 3] >> (7 - (i & 7))) & 1, preamble.length + i);
	const decoded = decodeAtnCpdlc(bytes, { direction, mode: 'plain' });
	return { decoded, complete: decoded.value.choice === 'send' && decoded.consumedBits <= total && zeroFrom(bytes, decoded.consumedBits) };
}

/** The envelope of a protected message: which alternative, the algorithm and the sizes of the protected parts. */
function envelope(root: AtnCpdlcValue): string {
	// The library names alternative 3 of ProtectedGroundPDUs "startup" like 2; the ASN.1 calls it send.
	const name = root.choiceIndex === 3 ? 'send' : (root.choice ?? root.type);
	const algorithm = leafValue(root, 'AlgorithmIdentifier');
	const mode = find(root, 'ProtectedMode')?.enumeration;
	const message = leafValue(root, 'CPDLCMessage') as AtnBits | undefined;
	const check = find(root, 'ProtectedUplinkMessage') ?? find(root, 'ProtectedDownlinkMessage');
	const integrity = check?.children?.find((child) => child.name === 'integrityCheck')?.value as AtnBits | undefined;
	return [
		name,
		mode ? `mode ${mode}` : '',
		algorithm === undefined ? '' : `algorithm ${scalar(algorithm)}`,
		message ? `protected message ${message.bitLength} bits` : '',
		integrity ? `integrity check ${integrity.bitLength} bits (${hexOf(integrity.payload, 16)})` : '',
	]
		.filter(Boolean)
		.join(', ');
}

/**
 * A protected CPDLC message (PM-CPDLC, ProtectedGroundPDUs / ProtectedAircraftPDUs). The library keeps the protected
 * message opaque until its integrity check can be verified, which it cannot do; its bits are the PER encoding of an ATC
 * message, which the library's plain reader reads, shown as such: the ATN integrity check is not verified.
 */
export function protectedCpdlc(bits: AtnBits, direction: 'uplink' | 'downlink'): AtnMessage {
	const decoded = decodeAtnCpdlc(bits.payload, { direction, mode: 'protected', bitLength: bits.bitLength });
	const fields: Field[] = [['PM-CPDLC', envelope(decoded.value)]];
	const inner = leafValue(decoded.value, 'CPDLCMessage') as AtnBits | undefined;
	if (!inner?.bitLength) {
		const other = messageFields(decoded.value);
		return { fields: [...fields, ...other.fields], summary: `PM-CPDLC ${other.summary}`, complete: decoded.structureComplete };
	}
	let read: ReturnType<typeof innerMessage> | undefined;
	try {
		read = innerMessage(inner, direction);
	} catch {
		read = undefined;
	}
	if (!read?.complete) {
		fields.push(['PM-CPDLC message', `does not read as an ATC message: ${hexOf(inner.payload, 64)}`]);
		return { fields, summary: 'PM-CPDLC message not read', complete: false };
	}
	const message = messageFields(read.decoded.value);
	fields.push(['CPDLC integrity', 'ATN integrity check not verified'], ['CPDLC message', message.summary], ...message.fields);
	return {
		fields,
		summary: `PM-CPDLC (ATN integrity check not verified) ${message.summary}`,
		complete: decoded.structureComplete,
	};
}
