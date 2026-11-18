// ATN over VDL2: the decoder sends the X.25 packet of each good I frame between an aircraft and a ground station; the
// app reads it with the ACARS library's passive stack (X.25, CLNP and its compression, COTP, ULCS, ACSE) up to CM and
// CPDLC. There is no real ATN capture in the library's tests or here: the frames are built with BrowSDR's VDL2 test
// encoders and the library's test encoders (atn-wire.js), with synthetic values.

import { describe, expect, it } from 'vitest';
import { readAviation } from '@/app/decoders/digimode/aviation';
import { validDigimodeMessage } from '@/worker/decoders/digimode/validation';
import { VDL2_RATE, Vdl2Decoder } from '@/worker/decoders/digimode/vdl2';
import { avlcFrame, controlI } from '@/worker/decoders/digimode/vdl2/avlc';
import { vdl2Signal, vdl2X25CallRequest } from '../vdl2-fixtures';
import {
	aareTsdu,
	aarqTsdu,
	clnp,
	clnpCompressed,
	cmContactRequest,
	cmContactResponse,
	cmLogonRequest,
	cmLogonResponse,
	connect,
	dataTpdu,
	dataTpduAtn,
	dataTsdu,
	downlinkWilco,
	esisHello,
	plainDownlink,
	plainUplink,
	protectedMessage,
	uplinkContact,
	x25Data,
} from './atn-wire';

const GS = { addr: 0x10a000, type: 4, status: false };
const AIR = { addr: 0x3c664b, type: 1, status: false };
const AIR2 = { addr: 0x4ca1f4, type: 1, status: false };
const nsap = (ars) => [0x47, 0x00, 0x27, 0x81, 0x81, ...ars, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0x20];
const AIR_NSAP = nsap([0x3c, 0x66, 0x4b]);
const AIR2_NSAP = nsap([0x4c, 0xa1, 0xf4]);
const GND_NSAP = [0x47, 0x00, 0x27, 0x41, 0x20, 0x44, 0x45, 0x55, 0, 0, 0, 2, 0, 0, 0, 0, 0, 3, 0x21];
const T0 = Date.UTC(2026, 10, 18, 12, 0);
const field = (r, label) => r.fields?.find(([name]) => name === label)?.[1];
const fields = (r, label) => r.fields?.filter(([name]) => name === label || name.startsWith(`${label} (`)).map(([, v]) => v) ?? [];

/** An X.25 circuit of an aircraft: its packets as AVLC I frames, P(S) and P(R) kept per direction. */
function circuit(air, lcn = 1) {
	const ps = { down: 0, up: 0 };
	const frame = (downlink, payload, more) => {
		const own = downlink ? 'down' : 'up';
		const packet = x25Data(lcn, ps[own]++ & 7, ps[downlink ? 'up' : 'down'] & 7, payload, more);
		return downlink ? avlcFrame(GS, air, controlI(0, 0, false), packet) : avlcFrame(air, GS, controlI(0, 0, false), packet);
	};
	return {
		call: () => avlcFrame(GS, air, controlI(0, 0, false), vdl2X25CallRequest(lcn, '', '')),
		accept: () => avlcFrame(air, GS, controlI(0, 0, false), [0x10 | (lcn >> 8), lcn & 0xff, 0x0f, 0x00, 0x00]),
		down: (payload, more = false) => frame(true, payload, more),
		up: (payload, more = false) => frame(false, payload, more),
	};
}

const REFS = { air: 0x0101, ground: 0x0202 };

/** The set-up of an aircraft's circuit and CM connection: call, CR/CC in plain CLNP (local references 5 and 7 set up). */
const setup = (c, airNsap) => [
	c.call(),
	c.accept(),
	c.down(clnp({ src: airNsap, dst: GND_NSAP, lref: 5, payload: connect(0xe0, 0, REFS.air) })),
	c.up(clnp({ src: GND_NSAP, dst: airNsap, lref: 7, payload: connect(0xd0, REFS.air, REFS.ground) })),
];

/** The CM logon: AARQ and AARE (AE qualifier 1) in compressed CLNP. */
const cm = (c, flight) => [
	c.down(clnpCompressed(5, dataTpdu(REFS.ground, 0, aarqTsdu({ calling: 1, user: cmLogonRequest(flight) })))),
	c.up(clnpCompressed(7, dataTpdu(REFS.air, 0, aareTsdu({ responding: 1, user: cmLogonResponse() })))),
];

const logon = (c, airNsap, flight) => [...setup(c, airNsap), ...cm(c, flight)];

/** A PM-CPDLC connection the ground starts (CR, CC, AARQ and AARE naming AE qualifier 22) on the same circuit. */
const pmCpdlc = (c) => [
	c.up(clnpCompressed(7, connect(0xe0, 0, 0x0303))),
	c.down(clnpCompressed(5, connect(0xd0, 0x0303, 0x0404))),
	c.up(clnpCompressed(7, dataTpdu(0x0404, 0, aarqTsdu({ called: 22 })))),
	c.down(clnpCompressed(5, dataTpdu(0x0303, 0, aareTsdu({ responding: 22 })))),
];

/** VDL2 frames, one burst each, through the decoder: its records. */
function decode(frames) {
	const iq = vdl2Signal(
		frames.map((frame) => ({ frames: [frame] })),
		{ rate: VDL2_RATE, snrDb: 25 },
	);
	const records = [];
	const decoder = new Vdl2Decoder({ record: (r) => records.push(r), status: () => {} });
	for (let i = 0; i < iq.length; i += 8192) decoder.process(iq.subarray(i, i + 8192));
	return records;
}

/** The app's side of one VFO. */
function app() {
	const receiver = {};
	let id = 0;
	return (records) =>
		records.map((r) => readAviation(receiver, 0, 'vdl2', 136.975, { ...r, id: ++id, time: T0 + id * 1000, mode: 'vdl2' }));
}

describe('ATN frames in the VDL2 records', () => {
	it('carry the X.25 packet with the AVLC addresses and the direction', () => {
		const c = circuit(AIR);
		const [call, accept] = decode([c.call(), c.accept()]);
		expect(call.application).toEqual({
			kind: 'atn',
			direction: 'downlink',
			source: { address: '3C664B', type: 1 },
			destination: { address: '10A000', type: 4 },
			hex: '10010B0000C100',
		});
		expect(accept.application).toMatchObject({ direction: 'uplink', source: { address: '10A000', type: 4 } });
	});
	it('are dropped when the frame check fails', () => {
		const c = circuit(AIR);
		const bad = c.call();
		bad[bad.length - 1] ^= 0xff;
		expect(decode([bad, c.accept()]).map((r) => r.application.direction)).toEqual(['uplink']);
	});
});

describe('CM over ATN', () => {
	it('reads a logon and its response, the application named by the ACSE', () => {
		const out = app()(decode(logon(circuit(AIR), AIR_NSAP, 'DLH4AB')));
		expect(out).toHaveLength(6);
		const [call, , cr, cc, aarq, aare] = out;
		expect(field(call, 'ATN X.25')).toMatch(/^call request: the circuit's packets are read from here/);
		expect(field(cr, 'ATN SNDCF')).toBe('local reference 5 set up for compressed CLNP on this circuit');
		expect(field(cr, 'ATN CLNP')).toBe(
			'header checksum verified, 47002781813C664B0000000100000000000120 → 47002741204445550000000200000000000321, lifetime 30 s',
		);
		expect(field(cr, 'ATN COTP')).toBe('Connect Request (checksum verified); connection cotp-1 requested');
		expect(field(cc, 'ATN COTP')).toMatch(/connection cotp-1 established \(class 4, normal format, TPDU 1024 octets/);
		expect(field(aarq, 'ATN CLNP')).toMatch(/^compressed, local reference 5: 4700278181/);
		expect(field(aarq, 'ATN ACSE')).toBe('AARQ, application context 1.3.27.3.1, AE qualifier 1 (CM)');
		expect(field(aarq, 'ATN application')).toBe("CM, from the AE qualifier of the connection's ACSE");
		expect(field(aarq, 'CM message')).toBe('logon request');
		expect(field(aarq, 'CM flight')).toBe('DLH4AB');
		expect(field(aarq, 'CM aircraft address')).toBe('RDP 4700278181 · ARS 3C664B · LOC/SYS/NSEL/TSEL 0000000100000000000120');
		expect(field(aarq, 'CM applications')).toMatch(/^PM-CPDLC v1 at RDP 4700278181 · ARS 3C664B · /);
		expect(field(aarq, 'CM other applications')).toBe('ADS-C v1');
		expect([field(aarq, 'CM facility'), field(aarq, 'CM departure'), field(aarq, 'CM destination')]).toEqual(['EDYY', 'EDDF', 'LEMD']);
		expect(aarq.text).toContain(': CM logon request, DLH4AB, facility EDYY, applications PM-CPDLC v1, ADS-C v1');
		expect(field(aare, 'ATN ACSE')).toMatch(/^AARE, .*AE qualifier 1 \(CM\), result accepted/);
		expect(field(aare, 'CM message')).toBe('logon response');
		expect(aare.text).toContain(': CM logon response, applications PM-CPDLC v1');
	});
	it('reads a contact request from the ground and its response', () => {
		const c = circuit(AIR);
		const frames = [
			...logon(c, AIR_NSAP, 'DLH4AB'),
			c.up(clnpCompressed(7, connect(0xe0, 0, 0x0505))),
			c.down(clnpCompressed(5, connect(0xd0, 0x0505, 0x0606))),
			c.up(clnpCompressed(7, dataTpdu(0x0606, 0, aarqTsdu({ called: 1, user: cmContactRequest('EDUU') })))),
			c.down(clnpCompressed(5, dataTpdu(0x0505, 0, aareTsdu({ responding: 1, user: cmContactResponse() })))),
		];
		const [request, response] = app()(decode(frames)).slice(-2);
		expect(field(request, 'CM message')).toBe('contact request');
		expect(field(request, 'CM facility')).toBe('EDUU');
		expect(field(request, 'CM address')).toBe('RDP 4700274120 · ARS 444555 · LOC/SYS/NSEL/TSEL 0000000200000000000322');
		expect(request.text).toContain(': CM contact request, contact EDUU');
		expect(field(response, 'CM response')).toBe('Contact success (0)');
		expect(response.text).toContain(': CM contact response, Contact success');
	});
	it('reassembles an NSDU sent in two X.25 packets', () => {
		const c = circuit(AIR);
		const frames = setup(c, AIR_NSAP);
		const nsdu = clnpCompressed(5, dataTpdu(0x0202, 0, aarqTsdu({ calling: 1, user: cmLogonRequest('BAW77K') })));
		const half = Math.floor(nsdu.length / 2);
		frames.push(c.down(nsdu.slice(0, half), true), c.down(nsdu.slice(half)));
		const [first, second] = app()(decode(frames)).slice(4);
		expect(field(first, 'ATN X.25')).toBe('packet 1 of an NSDU (M bit), waiting for more packets');
		expect(field(first, 'CM flight')).toBeUndefined();
		expect(field(second, 'ATN X.25')).toBe(`NSDU reassembled from 2 packets (${nsdu.length} octets)`);
		expect(field(second, 'CM flight')).toBe('BAW77K');
	});
	it('reads compressed CLNP whose context was set up before listening, its NSAPs not known', () => {
		// an aircraft keeps its local references across ground stations: the plain CLNP that set them up came long before
		const c = circuit(AIR);
		const contact = dataTsdu(plainUplink(uplinkContact()));
		const atn = { source: Uint8Array.from(GND_NSAP), destination: Uint8Array.from(AIR_NSAP) };
		const out = app()(decode([c.call(), c.up(clnpCompressed(7, dataTpduAtn(0x0777, 3, contact, atn)))]));
		expect(field(out[1], 'ATN CLNP')).toBe('compressed, local reference 7: set up before listening, its NSAPs not known');
		expect(field(out[1], 'ATN COTP')).toBe('Data (ATN checksum not verified: NSAPs not known)');
		expect(fields(out[1], 'ATN COTP')[1]).toBe('DT read on its own: the set-up of its connection was not followed');
		expect(field(out[1], 'CPDLC element 1')).toBe('UM117 CONTACT EDYY center 132.6 MHz');
	});
	it('reads the COTP of a real circuit opened at a handoff, its compression set up before listening', () => {
		// 502D7D (YL-ABS) to ground station 109C2A on 136.975 MHz, 2026-11-18 14:33:51Z: the call, then its first two data
		// packets, already compressed with local reference 66 (X.25 packets as received)
		const hex = (text) => text.split(' ').map((pair) => parseInt(pair, 16));
		const air = { addr: 0x502d7d, type: 1, status: false };
		const ground = { addr: 0x109c2a, type: 4, status: false };
		const down = (packet) => avlcFrame(ground, air, controlI(0, 0, false), hex(packet));
		const call =
			'1b ff 0b 80 24 02 65 75 13 42 0a 0a 43 04 04 01 80 00 0f c9 07 8c 58 41 41 06 00 ff c1 06 01 00 00 13 80 00 82 1e 01 00' +
			' 04 00 1e 00 00 14 47 00 27 41 42 54 49 00 50 2d 7d 00 01 00 00 00 00 00 01 00';
		const out = app()(
			decode([
				down(call),
				down('1b ff 20 1b 28 f6 42 01 37 0a 63 81 d9 04 08 04 b3 03 75 15'),
				down('1b ff 22 1b 28 f6 42 01 38 0a f0 81 d9 83 08 04 e5 f8 67 af 00 a7 16 4e e0 c4 3d 51 74 4e 03 21 02 a2 6e 3b c8'),
			]),
		);
		expect(field(out[0], 'ATN X.25')).toMatch(/^call request/);
		expect(field(out[1], 'ATN CLNP')).toBe('compressed, local reference 66: set up before listening, its NSAPs not known');
		expect(field(out[1], 'ATN COTP')).toBe('Data Ack (ATN checksum not verified: NSAPs not known)');
		expect(field(out[2], 'ATN COTP')).toBe('Data (ATN checksum not verified: NSAPs not known)');
		expect(fields(out[2], 'ATN COTP')[1]).toBe('DT read on its own: the set-up of its connection was not followed');
		// the aircraft's logical acknowledgement, stamped two seconds before the frame was received
		expect(field(out[2], 'ATN application')).toMatch(/^PM-CPDLC, identified by trial/);
		expect(field(out[2], 'CPDLC integrity')).toBe('ATN integrity check not verified');
		expect(field(out[2], 'CPDLC message')).toBe('DM100 LOGICAL ACKNOWLEDGEMENT');
		expect([field(out[2], 'CPDLC message id'), field(out[2], 'CPDLC reference')]).toEqual(['3', '4']);
		expect(field(out[2], 'CPDLC time')).toBe('2026-11-18 14:34:28 UTC');
	});
	it('keeps two aircraft apart, their frames interleaved', () => {
		const one = logon(circuit(AIR), AIR_NSAP, 'DLH4AB');
		const two = logon(circuit(AIR2), AIR2_NSAP, 'AFR12XY');
		const out = app()(decode(one.flatMap((frame, i) => [frame, two[i]])));
		expect(out.map((r) => field(r, 'CM flight')).filter(Boolean)).toEqual(['DLH4AB', 'AFR12XY']);
		expect(field(out[6], 'ATN COTP')).toMatch(/connection cotp-1 established/);
		expect(field(out[7], 'ATN COTP')).toMatch(/connection cotp-2 established/);
	});
	it('joining a circuit, reads a whole CLNP PDU at once but other packets only from the next NSDU', () => {
		const c = circuit(AIR);
		const [, , cr, cc] = setup(c, AIR_NSAP);
		// the end of an uplink NSDU sent before the CC (packet 7 of the circuit's sequence)
		const tail = avlcFrame(AIR, GS, controlI(0, 0, false), x25Data(1, 7, 0, [0x00, 0x3c, 0x00, 0x07, 0x11, 0x22]));
		const [aarq, aare] = cm(c, 'DLH4AB');
		const out = app()(decode([cr, tail, cc, aarq, aare]));
		expect(field(out[0], 'ATN X.25')).toBe('first packet read on this circuit: a whole CLNP PDU');
		expect(field(out[0], 'ATN COTP')).toMatch(/^Connect Request/);
		expect(field(out[1], 'ATN X.25')).toBe(
			'not read: no known NSDU boundary on this circuit yet (it may end a longer NSDU); read from its next NSDU',
		);
		expect(field(out[2], 'ATN COTP')).toMatch(/connection cotp-1 established/);
		expect(field(out[3], 'CM flight')).toBe('DLH4AB');
		expect(field(out[4], 'CM message')).toBe('logon response');
	});
});

describe('CPDLC over ATN', () => {
	it('identifies plain CPDLC by trial on a connection whose set-up was not received (ATN checksum)', () => {
		const c = circuit(AIR);
		const g = Uint8Array.from(GND_NSAP);
		const a = Uint8Array.from(AIR_NSAP);
		const contact = dataTsdu(plainUplink(uplinkContact()));
		const wilco = dataTsdu(plainDownlink(downlinkWilco()));
		const out = app()(
			decode([
				c.call(),
				c.up(clnp({ src: GND_NSAP, dst: AIR_NSAP, payload: dataTpduAtn(0x0777, 3, contact, { source: g, destination: a }) })),
				c.down(clnp({ src: AIR_NSAP, dst: GND_NSAP, payload: dataTpduAtn(0x0888, 5, wilco, { source: a, destination: g }) })),
			]),
		);
		const [, up, down] = out;
		expect(field(up, 'ATN COTP')).toContain('Data (ATN checksum verified)');
		expect(fields(up, 'ATN COTP')[1]).toBe('DT read on its own: the set-up of its connection was not followed');
		expect(field(up, 'ATN application')).toBe('CPDLC, identified by trial: of CM, CPDLC and PM-CPDLC (uplink) only it reads completely');
		expect(field(up, 'CPDLC element 1')).toBe('UM117 CONTACT EDYY center 132.6 MHz');
		expect(field(up, 'CPDLC message id')).toBe('5');
		expect(field(up, 'CPDLC time')).toBe('2026-11-18 12:34:56 UTC');
		expect(up.text).toContain(': CPDLC UM117 CONTACT EDYY center 132.6 MHz');
		expect(field(down, 'CPDLC element 1')).toBe('DM0 WILCO');
		expect(field(down, 'CPDLC reference')).toBe('5');
	});
	it('reads protected CPDLC (PM-CPDLC) with the plain reader, its integrity check not verified', () => {
		const c = circuit(AIR);
		// the ground starts PM-CPDLC (AE qualifier 22) on a second connection
		const frames = [...logon(c, AIR_NSAP, 'DLH4AB'), ...pmCpdlc(c)];
		frames.push(
			c.up(clnpCompressed(7, dataTpdu(0x0404, 1, dataTsdu(protectedMessage('uplink', uplinkContact(7, 'EDUU', 133.125)))))),
			c.down(clnpCompressed(5, dataTpdu(0x0303, 1, dataTsdu(protectedMessage('downlink', downlinkWilco(9, 7)))))),
		);
		const out = app()(decode(frames)).slice(6);
		expect(field(out[2], 'ATN ACSE')).toBe('AARQ, application context 1.3.27.3.1, AE qualifier 22 (PM-CPDLC)');
		const [contact, wilco] = out.slice(4);
		expect(field(contact, 'ATN application')).toBe("PM-CPDLC, from the AE qualifier of the connection's ACSE");
		expect(field(contact, 'PM-CPDLC')).toMatch(
			/^send, algorithm 1\.129, protected message \d+ bits, integrity check 32 bits \(A5A5A5A5\)$/,
		);
		expect(field(contact, 'CPDLC integrity')).toBe('ATN integrity check not verified');
		expect(field(contact, 'CPDLC element 1')).toBe('UM117 CONTACT EDUU center 133.125 MHz');
		expect(contact.text).toContain(': PM-CPDLC (ATN integrity check not verified) UM117 CONTACT EDUU center 133.125 MHz');
		expect(field(wilco, 'CPDLC element 1')).toBe('DM0 WILCO');
		expect(field(wilco, 'CPDLC reference')).toBe('7');
	});
	it('drops a damaged frame; the circuit is read again from its next NSDU and the connection goes on', () => {
		const c = circuit(AIR);
		const frames = [...logon(c, AIR_NSAP, 'DLH4AB'), ...pmCpdlc(c)];
		const damaged = c.down(clnpCompressed(5, dataTpdu(0x0303, 1, dataTsdu(protectedMessage('downlink', downlinkWilco(9, 7))))));
		damaged[20] ^= 0x40;
		frames.push(
			damaged,
			c.down(clnpCompressed(5, dataTpdu(0x0303, 2, dataTsdu(protectedMessage('downlink', downlinkWilco(10, 8)))))),
			c.down(clnpCompressed(5, dataTpdu(0x0303, 3, dataTsdu(protectedMessage('downlink', downlinkWilco(11, 9)))))),
		);
		const records = decode(frames);
		expect(records).toHaveLength(frames.length - 1);
		const [gap, next] = app()(records).slice(-2);
		expect(field(gap, 'ATN X.25')).toMatch(
			/^not read: Missing or conflicting packet sequence\. The circuit is read again from its next NSDU\.$/,
		);
		expect(field(gap, 'CPDLC element 1')).toBeUndefined();
		expect(fields(next, 'ATN COTP')).toContain('DT read on its own: its connection waits for an earlier DT that was not received');
		expect(field(next, 'CPDLC element 1')).toBe('DM0 WILCO');
		expect(field(next, 'CPDLC reference')).toBe('9');
	});
	it('after a lost packet, reads a whole CLNP PDU at once', () => {
		const c = circuit(AIR);
		const frames = logon(c, AIR_NSAP, 'DLH4AB');
		const lost = c.down(clnpCompressed(5, dataTpdu(REFS.ground, 1, dataTsdu(plainDownlink(downlinkWilco())))));
		lost[lost.length - 2] ^= 0x01;
		const a = Uint8Array.from(AIR_NSAP);
		const g = Uint8Array.from(GND_NSAP);
		const wilco = dataTsdu(plainDownlink(downlinkWilco(12, 6)));
		frames.push(
			lost,
			c.down(clnp({ src: AIR_NSAP, dst: GND_NSAP, payload: dataTpduAtn(0x0999, 0, wilco, { source: a, destination: g }) })),
		);
		const out = app()(decode(frames));
		const last = out.at(-1);
		expect(out).toHaveLength(frames.length - 1);
		expect(field(last, 'ATN X.25')).toBe(
			'after a gap in the packet sequence (Missing or conflicting packet sequence.): read as a whole CLNP PDU',
		);
		expect(field(last, 'CPDLC element 1')).toBe('DM0 WILCO');
	});
	it('leaves bits no application reads completely unidentified', () => {
		const c = circuit(AIR);
		const g = Uint8Array.from(GND_NSAP);
		const a = Uint8Array.from(AIR_NSAP);
		const junk = dataTsdu('1111111111111111111111111111111111');
		const [, up] = app()(
			decode([
				c.call(),
				c.up(clnp({ src: GND_NSAP, dst: AIR_NSAP, payload: dataTpduAtn(0x0777, 0, junk, { source: g, destination: a }) })),
			]),
		);
		expect(field(up, 'ATN application')).toMatch(/^not identified \(neither CM, CPDLC nor PM-CPDLC reads completely\): 34 bits /);
		expect(up.text).not.toContain('CPDLC');
	});
	it('names an ES-IS hello', () => {
		const c = circuit(AIR);
		const [, hello] = app()(decode([c.call(), c.down(esisHello([AIR_NSAP]))]));
		expect(field(hello, 'ATN ES-IS')).toBe(
			'End System Hello, holding time 30 s, checksum verified, NSAP 47002781813C664B0000000100000000000120',
		);
		expect(field(hello, 'ATN COTP')).toBeUndefined();
	});
});

describe('robustness', () => {
	it('never throws on mutated or random packets, and keeps its records within the log bounds', () => {
		let seed = 7;
		const random = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
		const c = circuit(AIR);
		const packets = [...logon(c, AIR_NSAP, 'DLH4AB'), ...pmCpdlc(c)].map((frame) => [...frame.slice(9, -2)]);
		const read = app();
		const hex = (bytes) => bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
		const records = [];
		for (let i = 0; i < 1500; i++) {
			const base =
				i % 3 ? [...packets[i % packets.length]] : Array.from({ length: 3 + Math.floor(random() * 120) }, () => (random() * 256) | 0);
			if (i % 3) for (let k = 0; k < 1 + (i % 4); k++) base[Math.floor(random() * base.length)] = (random() * 256) | 0;
			base[0] = (base[0] & 0xcf) | 0x10;
			const down = random() < 0.5;
			const ends = [
				{ address: '3C664B', type: 1 },
				{ address: '10A000', type: 4 },
			];
			records.push({
				text: 'X.25',
				application: {
					kind: 'atn',
					direction: down ? 'downlink' : 'uplink',
					source: ends[down ? 0 : 1],
					destination: ends[down ? 1 : 0],
					hex: hex(base),
				},
			});
		}
		const out = read(records);
		for (const r of out)
			expect(
				validDigimodeMessage({
					type: 'digimode',
					mode: 'vdl2',
					freq: 136.975,
					status: { state: 'receiving', message: '', records: 1, locked: true },
					records: [r],
				}),
			).toBe(true);
	});
});

describe('the ATN frame check', () => {
	const message = (application) => ({
		type: 'digimode',
		mode: 'vdl2',
		freq: 136.975,
		status: { state: 'receiving', message: '', records: 1, locked: true },
		records: [{ id: 1, time: T0, mode: 'vdl2', text: 'X.25', application }],
	});
	const good = {
		kind: 'atn',
		direction: 'downlink',
		source: { address: '3C664B', type: 1 },
		destination: { address: '10A000', type: 4 },
		hex: '10010B0000C100',
	};
	it('passes a good packet', () => expect(validDigimodeMessage(message(good))).toBe(true));
	it('refuses malformed ones', () => {
		for (const application of [
			{ ...good, direction: 'up' },
			{ ...good, source: { address: '3c664b', type: 1 } },
			{ ...good, source: { address: '3C664B', type: 8 } },
			{ ...good, destination: { address: '10A00', type: 4 } },
			{ ...good, destination: undefined },
			{ ...good, hex: '1001' },
			{ ...good, hex: '10010B0000C10' },
			{ ...good, hex: '10010b0000c100' },
			{ ...good, hex: 'AB'.repeat(2001) },
		])
			expect(validDigimodeMessage(message(application))).toBe(false);
	});
});
