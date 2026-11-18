// SPDX-License-Identifier: GPL-3.0-or-later
// Test encoders for ATN over VDL2, adapted for BrowSDR's tests from the test encoders of the ACARS library
// (jLynx/acars-typescript-decoder, GPL-3.0-or-later), revision 14a7fcc5cdaef43ac9d3e382750e0f84b9105948 (0.1.3):
// test/transport/cotp-session/wire.js (tpdu, connect, data: RFC 905 class-4 TPDUs with their ISO 8073 checksum),
// test/transport/compressed/context.spec.js (setup: an RFC 994 CLNP header with its checksum and the Mobile SNDCF
// local-reference option), test/transport/esis-addresses.spec.js (wire, hello: an RFC 995 ES-IS hello with its
// checksum), test/transport/atn/integrity.spec.js (protect: the ATN extended checksum over a TPDU and
// the NSAP pseudo-trailer) and the X.691 bit helpers and hand-packed messages of test/payload/protocols/atn/
// acse.spec.js, ulcs.spec.js, cm.spec.js and cpdlc.spec.js. Changes: the pieces are put together into whole frames
// (X.25 data packets around CLNP, compressed CLNP, COTP, the short session/presentation headers, ACSE with user
// information, CM and CPDLC messages with chosen values); names and defaults are BrowSDR's. Synthetic values only,
// no captured traffic.

// ---------------------------------------------------------------- bits (X.691 unaligned PER)

export const int = (value, width) => (width ? BigInt(value).toString(2).padStart(width, '0') : '');
/** Bits to octets, zero padded (a complete PER encoding is at least one octet). */
export const bytes = (binary) =>
	Uint8Array.from(binary.padEnd(Math.max(8, Math.ceil(binary.length / 8) * 8), '0').match(/.{8}/g), (v) => parseInt(v, 2));
/** A length determinant. */
export const length = (count) => (count < 128 ? int(count, 8) : int(0x8000 | count, 16));
export const octets = (values) => values.map((v) => int(v, 8)).join('');
/** IA5 characters, 7 bits each. */
export const chars = (text) => [...text].map((c) => int(c.charCodeAt(0), 7)).join('');
/** An unconstrained integer of one octet (an ACSE AE qualifier, an EXTERNAL indirect reference). */
const integer = (value) => int(1, 8) + int(value & 255, 8);
/** An OBJECT IDENTIFIER: length and the arcs, the first two in one subidentifier (arcs below 128 here). */
const oid = (arcs) => {
	const body = [arcs[0] * 40 + arcs[1], ...arcs.slice(2)];
	return length(body.length) + octets(body);
};

// ---------------------------------------------------------------- X.25 (ISO 8208, modulo 8)

/** A data packet: GFI 1, logical channel, P(R), M bit, P(S), the user data. */
export const x25Data = (lcn, ps, pr, payload, more = false) => [
	0x10 | ((lcn >> 8) & 0xf),
	lcn & 0xff,
	((pr & 7) << 5) | (more ? 0x10 : 0) | ((ps & 7) << 1),
	...payload,
];

// ---------------------------------------------------------------- CLNP (ISO 8473, RFC 994) and Mobile SNDCF

const mod255 = (n) => ((n % 255) + 255) % 255 || 255;

/** An uncompressed data PDU (no segmentation) from `src` to `dst` (NSAPs), its header checksum set; `lref` adds option 5. */
export function clnp({ src, dst, payload, lref, lifetime = 60 }) {
	const options = lref === undefined ? [] : [5, lref > 127 ? 2 : 1, ...(lref > 127 ? [lref >> 8, lref & 255] : [lref])];
	const header = [0x81, 0, 1, lifetime, 0x1c, 0, 0, 0, 0, dst.length, ...dst, src.length, ...src, ...options];
	header[1] = header.length;
	const pdu = Uint8Array.from([...header, ...payload]);
	pdu[5] = pdu.length >> 8;
	pdu[6] = pdu.length & 255;
	const head = pdu.subarray(0, header.length);
	const sum = head.reduce((a, b) => a + b, 0);
	const weighted = head.reduce((a, b, i) => a + b * (i + 1), 0);
	pdu[7] = mod255(weighted - 9 * sum);
	pdu[8] = mod255(-sum - pdu[7]);
	return [...pdu];
}

/** A compressed (local reference) data PDU of the Mobile SNDCF: type 0, priority 0, lifetime, flags, the reference. */
export const clnpCompressed = (lref, payload, lifetime = 60) => [
	0x00,
	lifetime,
	0,
	...(lref > 127 ? [0x80 | (lref >> 8), lref & 255] : [lref]),
	...payload,
];

/** An ES-IS end system hello (RFC 995, ISO 9542) listing `addresses`, holding time 30 s, its checksum set. */
export function esisHello(addresses) {
	const body = [addresses.length, ...addresses.flatMap((address) => [address.length, ...address])];
	const bytes = [0x82, 9 + body.length, 1, 0, 2, 0, 30, 0, 0, ...body];
	const sum = bytes.reduce((total, byte) => total + byte, 0) % 255;
	const weighted = bytes.reduce((total, byte, index) => total + (index + 1) * byte, 0) % 255;
	bytes[7] = (weighted - 9 * sum + 255 * 256) % 255 || 255;
	bytes[8] = (-sum - bytes[7] + 510) % 255 || 255;
	return bytes;
}

// ---------------------------------------------------------------- COTP (ISO 8073 class 4, RFC 905)

/** A TPDU: LI, the fixed part, parameters, the ISO checksum parameter (set) and the user data. */
export function tpdu(fixed, parameters = [], payload = [], checksum = true) {
	const header = [...fixed, ...parameters.flatMap(([id, values]) => [id, values.length, ...values])];
	const offset = header.length + 3;
	if (checksum) header.push(0xc3, 2, 0, 0);
	const out = Uint8Array.from([header.length, ...header, ...payload]);
	if (!checksum) return [...out];
	let sum = 0;
	let weighted = 0;
	for (const byte of out) {
		sum = (sum + byte) % 255;
		weighted = (weighted + sum) % 255;
	}
	out[offset] = ((out.length - offset - 1) * sum - weighted + 255 * 256) % 255;
	out[offset + 1] = (-sum - out[offset] + 510) % 255;
	return [...out];
}

/** A connect request (0xE0) or confirm (0xD0) of class 4, normal format, TPDU size 1024 octets, credit 3. */
export const connect = (type, destination, source) =>
	tpdu([type | 3, destination >> 8, destination & 255, source >> 8, source & 255, 0x40], [[0xc0, [10]]]);

/** A data TPDU to the peer's `reference`, normal format, end of the TSDU. */
export const dataTpdu = (reference, sequence, payload, end = true) =>
	tpdu([0xf0, reference >> 8, reference & 255, sequence | (end ? 0x80 : 0)], [], payload);

const choose = (n, k) => {
	let v = 1;
	for (let i = 1; i <= k; i++) v = (v * (n - i + 1)) / i;
	return v;
};
const mod = (n) => ((n % 255) + 255) % 255;

/** A data TPDU with the ATN 32-bit extended checksum (no ISO checksum) over it and the NSAPs (`source` to `destination`). */
export function dataTpduAtn(reference, sequence, payload, { source, destination }) {
	const fixed = [0xf0, reference >> 8, reference & 255, sequence | 0x80];
	const wire = tpdu(fixed, [[8, [0, 0, 0, 0]]], payload, false);
	const offset = fixed.length + 3;
	const input = [...wire, destination.length, ...destination, source.length, ...source];
	const width = 4;
	const matrix = Array.from({ length: width }, (_, order) => [
		...Array.from({ length: width }, (_, i) => choose(width - i + order - 1, order)),
		mod(-input.reduce((sum, byte, i) => sum + byte * choose(input.length - i + width + order - 1, order), 0)),
	]);
	for (let column = 0; column < width; column++) {
		const row = matrix[column];
		const inverse = Array.from({ length: 254 }, (_, i) => i + 1).find((n) => mod(row[column] * n) === 1);
		for (let j = column; j <= width; j++) row[j] = mod(row[j] * inverse);
		for (let i = 0; i < width; i++)
			if (i !== column) {
				const factor = matrix[i][column];
				for (let j = column; j <= width; j++) matrix[i][j] = mod(matrix[i][j] - factor * row[j]);
			}
	}
	matrix.forEach((row, i) => (wire[offset + i] = row[width]));
	return wire;
}

// ---------------------------------------------------------------- ULCS: short session/presentation, ACSE

/** An EXTERNAL of the ACSE user information: indirect reference 3, arbitrary (a bit string). */
const external = (bits) => '010' + integer(3) + '10' + length(bits.length) + bits;

/** A connection's first TSDU from the initiator: SCN, CP, then an AARQ (application context, AE qualifiers, user information). */
export function aarqTsdu({ context = [1, 3, 27, 3, 1], calling, called, user } = {}) {
	const flags = Array.from({ length: 15 }, () => '0');
	if (called !== undefined) flags[2] = '1';
	if (calling !== undefined) flags[6] = '1';
	if (user) flags[14] = '1';
	const bits =
		'0' + // ACSE-apdu root
		'000' + // aarq
		'0' + // no extension
		flags.join('') +
		oid(context) +
		(called === undefined ? '' : '00' + integer(called)) +
		(calling === undefined ? '' : '00' + integer(calling)) +
		(user ? '0' + external(user) : '');
	return [0xe8, 0x02, ...bytes(bits)];
}

/** The responder's first TSDU: SAC, CPA, then an AARE (accepted unless `result`), responding AE qualifier, user information. */
export function aareTsdu({ context = [1, 3, 27, 3, 1], responding, user, result = 0 } = {}) {
	const flags = Array.from({ length: 11 }, () => '0');
	if (responding !== undefined) flags[2] = '1';
	if (user) flags[10] = '1';
	const bits =
		'0' + // ACSE-apdu root
		'001' + // aare
		'0' + // no extension
		flags.join('') +
		oid(context) +
		'0' +
		int(result, 2) + // result, not extended
		'0' + // diagnostic from the service user
		'0' +
		int(0, 4) + // null
		(responding === undefined ? '' : '00' + integer(responding)) +
		(user ? '0' + external(user) : '');
	return [0xf0, 0x02, ...bytes(bits)];
}

/** A data phase TSDU: fully encoded data, one value of presentation context 3 (the application), arbitrary encoding. */
export const dataTsdu = (bits) => [...bytes('0' + '0' + '0' + int(3 - 1, 7) + int(2, 2) + length(bits.length) + bits)];

// ---------------------------------------------------------------- CM (Doc 9705 CMMessageSetVersion1)

/** A long TSAP: routing domain part (5 octets), the address reference (3), LOC/SYS/NSEL/TSEL (11). */
const longTsap = (rdp, ars, rest) => octets(rdp) + '1' + octets(ars) + '1' + octets(rest);
const cmText = (value, width, minimum) => int(value.length - minimum, width) + chars(value);
const application = (ae, version, tsap) => int(ae, 8) + int(version - 1, 8) + (tsap ? '0' + tsap : '');

const AIRCRAFT_TSAP = longTsap([0x47, 0x00, 0x27, 0x81, 0x81], [0x3c, 0x66, 0x4b], [0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0x20]);
const CPDLC_TSAP = longTsap([0x47, 0x00, 0x27, 0x81, 0x81], [0x3c, 0x66, 0x4b], [0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0x22]);
const GROUND_TSAP = longTsap([0x47, 0x00, 0x27, 0x41, 0x20], [0x44, 0x45, 0x55], [0, 0, 0, 2, 0, 0, 0, 0, 0, 3, 0x22]);

/** A CM logon request (downlink): flight, the aircraft's CM address, PM-CPDLC (22) offered with its address, ADS-C (0), facility, airports. */
export const cmLogonRequest = (flight = 'DLH4AB') =>
	'0' +
	int(0, 2) + // logon request
	'111110' + // addressed and other applications, facility, departure, destination; no date/time
	cmText(flight, 3, 2) +
	AIRCRAFT_TSAP +
	int(0, 8) +
	application(22, 1, CPDLC_TSAP) +
	int(0, 8) +
	application(0, 1) +
	cmText('EDYY', 3, 4) +
	chars('EDDF') +
	chars('LEMD');

/** A CM logon response (uplink): the ground's PM-CPDLC (22) address. */
export const cmLogonResponse = () => '0' + int(0, 3) + '10' + int(0, 8) + application(22, 1, GROUND_TSAP);

/** A CM contact request (uplink): the facility to log on to next and its CM address. */
export const cmContactRequest = (facility) => '0' + int(2, 3) + cmText(facility, 3, 4) + GROUND_TSAP;

/** A CM contact response (downlink): contact success. */
export const cmContactResponse = () => '0' + int(1, 2) + '0';

// ---------------------------------------------------------------- CPDLC (Doc 9705 ATN CPDLC version 1)

/** ATCMessageHeader: message id (6 bits), optional reference, date and time (2026-11-18 12:34:56), optional logical ack. */
const header = (id, reference) =>
	(reference === undefined ? '0' : '1') +
	'0' +
	int(id, 6) +
	(reference === undefined ? '' : int(reference, 6)) +
	int(2026 - 1996, 7) +
	int(11 - 1, 4) +
	int(18 - 1, 5) +
	int(12, 5) +
	int(34, 6) +
	int(56, 6);

/** UM117 CONTACT [unit name] [frequency]: facility designation, function (center), VHF frequency (0.005 MHz steps). */
const unitNameFrequency = (facility, mhz) =>
	'0' + cmText(facility, 3, 4) + '0' + int(0, 4) + int(1, 2) + int(Math.round(mhz / 0.005) - 23600, 12);

/** ATCUplinkMessage (header and one element UM117 CONTACT), a complete PER encoding of its own. */
export const uplinkContact = (id = 5, facility = 'EDYY', mhz = 132.6) =>
	header(id) + '0' + int(0, 3) + '0' + int(117, 8) + unitNameFrequency(facility, mhz);

/** ATCDownlinkMessage answering message `reference` with DM0 WILCO. */
export const downlinkWilco = (id = 9, reference = 5) => header(id, reference) + '0' + int(0, 3) + '0' + int(0, 7);

/** GroundPDUs / AircraftPDUs `send` (choice 3) of a plain CPDLC message. */
export const plainUplink = (message) => '0' + int(3, 3) + message;
export const plainDownlink = (message) => '0' + int(3, 2) + message;

/**
 * ProtectedGroundPDUs / ProtectedAircraftPDUs `send` (choice 3): ProtectedUplinkMessage / ProtectedDownlinkMessage with
 * the algorithm identifier (relative OID 1.129, as the library's test), the protected message (the PER encoding of the
 * ATC message as a bit string, octet padded) and a 32-bit integrity check.
 */
export function protectedMessage(direction, message, check = 0xa5a5a5a5) {
	const inner = message.padEnd(Math.ceil(message.length / 8) * 8, '0');
	return (
		'0' +
		int(3, direction === 'uplink' ? 3 : 2) +
		'0' + // ProtectedUplinkMessage not extended
		'11' + // algorithm identifier and protected message present
		length(3) +
		octets([1, 0x81, 1]) +
		length(inner.length) +
		inner +
		length(32) +
		int(check, 32)
	);
}
