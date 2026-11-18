import {
	createClnpCompressedReassembler,
	createClnpReassembler,
	createX25Reassembler,
	type EsisPdu,
	type IdrpHeader,
	type X25Assembly,
} from '@jlynx_/acars-decoder';
import { hexOf, remember } from './fields';
import type { AtnFrame, AtnLayer, AtnNsdu, Field } from './types';

/** X.25 packets (ISO 8208) after which a circuit's data packets start a new sequence: set-up, clearing, reset, restart. */
const CIRCUIT_PACKETS: Record<number, string> = {
	0x0b: 'call request',
	0x0f: 'call accepted',
	0x13: 'clear request',
	0x17: 'clear confirmation',
	0x1b: 'reset request',
	0x1f: 'reset confirmation',
	0xfb: 'restart request',
	0xff: 'restart confirmation',
};

const nsap = (bytes: Uint8Array | undefined): string => (bytes ? hexOf(bytes, 20) : '-');
const idrpLine = (idrp: IdrpHeader): Field => [
	'ATN IDRP',
	`${idrp.typeName}, sequence ${idrp.sequence}, acknowledges ${idrp.acknowledgement}${idrp.reason ? ` (${idrp.reason})` : ''}`,
];
const esisLine = (esis: EsisPdu): Field => [
	'ATN ES-IS',
	`${esis.type}, holding time ${esis.holdingTime} s, checksum ${esis.integrity}` +
		(esis.networkEntityTitle ? `, NET ${nsap(esis.networkEntityTitle)}` : '') +
		(esis.sourceAddresses?.length ? `, NSAP ${esis.sourceAddresses.map((a) => nsap(a)).join(', ')}` : ''),
];

/**
 * The ATN network layers of one VFO, with the ACARS library: X.25 reassembly (M bit) per circuit and direction, then
 * uncompressed CLNP (its header checksum verified; a Mobile SNDCF local reference it sets up is noted) or compressed
 * CLNP (with the context such a PDU set up), and ES-IS and IDRP named. Every scope names the aircraft and the ground
 * station (the AVLC addresses), the X.25 logical channel and the direction; the VFO has a state of its own.
 *
 * X.25 has no start-of-NSDU mark, and a packet that ends an NSDU may be the last of several (the library asks for a
 * known boundary). A circuit is read from a call, clear, reset or restart packet, or from the packet after one that ended
 * an NSDU; before that, and after a packet that was not received, only a packet that is a whole uncompressed CLNP PDU is
 * read (the CLNP header checksum and length show that an NSDU starts there). Other packets wait for the next boundary.
 */
export class AtnNetwork {
	// a busy channel has many aircraft, each with a circuit in both directions and a compression context in each
	private readonly x25 = createX25Reassembler({ maxChannels: 256 });
	private readonly clnp = createClnpReassembler();
	private readonly compressed = createClnpCompressedReassembler({ maxAssemblies: 256 });
	/**
	 * Circuit links (aircraft, ground, channel, direction) at a known NSDU boundary: '' once read from there on, else the
	 * packet that ended an NSDU not read (a retransmission of it is not read either). A link not here is not at one.
	 */
	private readonly boundary = new Map<string, string>();

	read(frame: AtnFrame): AtnLayer<AtnNsdu> {
		const p = frame.bytes;
		const lcn = ((p[0] & 0xf) << 8) | p[1];
		const link = `${frame.air}:${frame.ground}:${lcn}:${frame.downlink ? 'down' : 'up'}`;
		if (((p[0] >> 4) & 3) !== 1) return { fields: [['ATN X.25', 'not a modulo-8 packet: not read']] };
		if (p[2] & 1) return this.control(frame, lcn);
		const more = (p[2] & 0x10) !== 0;
		const whole = !more && p[3] === 0x81;
		const packet = hexOf(p, Infinity);
		const known = this.boundary.get(link);
		if (known === packet) return { fields: [['ATN X.25', 'packet received again: not read']] };
		if (known === undefined && !whole) {
			if (!more) remember(this.boundary, link, packet);
			const why = more ? 'an NSDU in progress' : 'it may end a longer NSDU';
			return { fields: [['ATN X.25', `not read: no known NSDU boundary on this circuit yet (${why}); read from its next NSDU`]] };
		}
		remember(this.boundary, link, '');
		if (known === undefined) this.x25.reset(link); // a whole PDU starts afresh
		const first = this.x25.push(p, { link, receivedAt: frame.time });
		if (first.status !== 'failed') {
			const note = known === undefined ? 'first packet read on this circuit: a whole CLNP PDU' : '';
			return this.assembled(first, link, frame.time, note);
		}
		this.x25.reset(link);
		if (whole) {
			const again = this.x25.push(p, { link, receivedAt: frame.time });
			return this.assembled(again, link, frame.time, `after a gap in the packet sequence (${first.reason}): read as a whole CLNP PDU`);
		}
		if (more) this.boundary.delete(link);
		else remember(this.boundary, link, packet);
		return { fields: [['ATN X.25', `not read: ${first.reason} The circuit is read again from its next NSDU.`]] };
	}

	/** A circuit packet starts the circuit's sequence again (a restart: all circuits of the pair); flow control passes. */
	private control(frame: AtnFrame, lcn: number): AtnLayer<AtnNsdu> {
		const name = CIRCUIT_PACKETS[frame.bytes[2]];
		if (!name) return { fields: [] };
		const pair = `${frame.air}:${frame.ground}:`;
		const circuits = frame.bytes[2] >= 0xfb ? [...this.boundary.keys()].filter((key) => key.startsWith(pair)) : [];
		circuits.push(`${pair}${lcn}:down`, `${pair}${lcn}:up`);
		for (const link of circuits) {
			this.x25.reset(link);
			this.clnp.reset(link);
			this.compressed.reset(link);
			remember(this.boundary, link, '');
		}
		return { fields: [['ATN X.25', `${name}: the circuit's packets are read from here, its compression contexts start again`]] };
	}

	/** What the X.25 reassembly gave, after `note` (how the packet came to be read). */
	private assembled(assembly: X25Assembly, link: string, time: number, note: string): AtnLayer<AtnNsdu> {
		const lines: Field[] = note ? [['ATN X.25', note]] : [];
		switch (assembly.status) {
			case 'pending':
				return { fields: [...lines, ['ATN X.25', `packet ${assembly.fragments} of an NSDU (M bit), waiting for more packets`]] };
			case 'duplicate':
				return { fields: [...lines, ['ATN X.25', 'packet received again']] };
			case 'complete': {
				const layer = this.network(assembly, link, time);
				return { fields: [...lines, ...layer.fields], ...(layer.up ? { up: layer.up } : {}) };
			}
			default:
				return { fields: [...lines, ['ATN X.25', `not read: ${assembly.reason ?? assembly.status}`]] };
		}
	}

	/** The NSDU of a complete X.25 assembly: CLNP (plain or compressed), ES-IS or IDRP. */
	private network(assembly: X25Assembly, link: string, time: number): AtnLayer<AtnNsdu> {
		const payload = assembly.payload ?? new Uint8Array();
		const fields: Field[] = [];
		if (assembly.fragments > 1) fields.push(['ATN X.25', `NSDU reassembled from ${assembly.fragments} packets (${payload.length} octets)`]);
		if (payload[0] === 0x82) return { fields: [...fields, assembly.esis ? esisLine(assembly.esis) : ['ATN ES-IS', 'not read']] };
		try {
			const layer = payload[0] === 0x81 ? this.plain(payload, link, time) : this.packed(payload, link, time);
			return { fields: [...fields, ...layer.fields], ...(layer.up ? { up: layer.up } : {}) };
		} catch (error) {
			return { fields: [...fields, ['ATN CLNP', `not read: ${error instanceof Error ? error.message : 'invalid PDU'}`]] };
		}
	}

	private plain(payload: Uint8Array, link: string, time: number): AtnLayer<AtnNsdu> {
		const observed = this.compressed.observe(payload, { link, receivedAt: time, linkIntegrity: 'verified' });
		const result = this.clnp.push(payload, { link, receivedAt: time });
		const pdu = result.packet;
		const fields: Field[] = [
			['ATN CLNP', `header checksum ${pdu.integrity}, ${nsap(pdu.source)} → ${nsap(pdu.destination)}, lifetime ${pdu.lifetime} s`],
		];
		if (observed.status === 'registered')
			fields.push(['ATN SNDCF', `local reference ${observed.context?.localReference} set up for compressed CLNP on this circuit`]);
		if (result.status !== 'complete' || !result.payload || !pdu.source || !pdu.destination)
			return { fields: [...fields, ['ATN CLNP', `${result.status}${result.reason ? `: ${result.reason}` : ''}`]] };
		if (result.idrp) return { fields: [...fields, idrpLine(result.idrp)] };
		return { fields, up: { bytes: result.payload, source: pdu.source, destination: pdu.destination } };
	}

	private packed(payload: Uint8Array, link: string, time: number): AtnLayer<AtnNsdu> {
		const result = this.compressed.push(payload, { link, receivedAt: time, linkIntegrity: 'verified' });
		const reference = result.packet.localReference;
		const context = result.context;
		if (result.status !== 'complete' || !result.payload || !context) {
			const why = result.reason === 'No matching compression context.' ? 'its context was not set up while listening' : result.reason;
			return { fields: [['ATN CLNP', `compressed, local reference ${reference}: ${result.status}${why ? ` (${why})` : ''}`]] };
		}
		const fields: Field[] = [
			['ATN CLNP', `compressed, local reference ${reference}: ${nsap(context.source)} → ${nsap(context.destination)}`],
		];
		if (result.idrp) return { fields: [...fields, idrpLine(result.idrp)] };
		return { fields, up: { bytes: result.payload, source: context.source, destination: context.destination } };
	}
}
