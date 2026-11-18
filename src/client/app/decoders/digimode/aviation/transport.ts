import { createCotpSession, decodeCotp, type CotpPdu, type CotpSessionEvent, type CotpSessionResult } from '@jlynx_/acars-decoder';
import { hexOf, remember } from './fields';
import type { AtnLayer, AtnNsdu, AtnTsdu, Field } from './types';

const DT = 0xf0;

/** Whether a TPDU's ATN checksum could not be verified because its NSAPs, over which it is computed, are not known. */
const unknownNsaps = (pdu: CotpPdu, nsaps: boolean): boolean => !nsaps && pdu.atnIntegrity === 'unverified';

function checksum(pdu: CotpPdu, nsaps: boolean): string {
	if (unknownNsaps(pdu, nsaps)) return 'ATN checksum not verified: NSAPs not known';
	if (pdu.atnIntegrity) return `ATN checksum ${pdu.atnIntegrity}`;
	return pdu.integrity === 'unverified' ? 'no checksum' : `checksum ${pdu.integrity}`;
}

function eventText(event: CotpSessionEvent): string {
	const id = event.connectionId ? `connection ${event.connectionId}` : 'connection';
	switch (event.status) {
		case 'requested':
			return `${id} requested`;
		case 'established': {
			const n = event.negotiation;
			const atn = n?.atnChecksum ? `, ATN ${n.atnChecksum}-bit checksum` : '';
			return `${id} established (class 4, ${n?.format} format, TPDU ${n?.tpduSize} octets, checksum ${n?.checksum}${atn})`;
		}
		case 'closed':
			return `${id} closed${event.reason ? `: ${event.reason}` : ''}`;
		case 'acknowledged':
			return `${id}: data acknowledged`;
		case 'duplicate':
			return `${id}: received again`;
		default:
			return `not taken by the session (${event.status})${event.reason ? `: ${event.reason}` : ''}`;
	}
}

/**
 * A DT the session could not place that ends its TSDU and whose own checksum (ISO or ATN) verified, or whose ATN checksum
 * cannot be verified without its NSAPs (the frame check of the link still vouches for its bytes).
 */
const standalone = (pdu: CotpPdu, nsaps: boolean): boolean =>
	pdu.type === DT &&
	!!pdu.endOfTransmission &&
	!!pdu.userData?.length &&
	(pdu.integrity === 'verified' || pdu.atnIntegrity === 'verified' || (unknownNsaps(pdu, nsaps) && pdu.integrity !== 'failed'));

/**
 * The ATN transport layer of one VFO: the ACARS library's passive COTP session (class 4), one link per pair of end
 * systems (the aircraft's and the ground's NSAPs) with the direction aircraft to ground as 'a-to-b'. A connection is
 * followed from its CR and CC; its DT TPDUs are assembled into TSDUs. A DT the session cannot place (its connection was
 * set up before listening, expired, or was not accepted, such as one whose CR has the ATN checksum only), or holds back
 * waiting for an earlier DT that was not received, is read on its own when it ends a TSDU, its checksum verified, and
 * the DT before it on the same reference did not leave a TSDU open: ATN messages are almost always one DT long.
 */
export class AtnTransport {
	private readonly session = createCotpSession({ maxRecords: 256 });
	/** By link, direction and destination reference: whether the last DT left its TSDU open. */
	private readonly open = new Map<string, boolean>();
	/** By link, direction and destination reference: the session's connection its DTs were last placed on. */
	private readonly connections = new Map<string, string>();

	read(nsdu: AtnNsdu, downlink: boolean, time: number): AtnLayer<AtnTsdu[]> {
		const nsaps = nsdu.nsaps;
		const air = nsaps && (downlink ? nsaps.source : nsaps.destination);
		const ground = nsaps && (downlink ? nsaps.destination : nsaps.source);
		const link = air && ground ? `${hexOf(air, 20)}:${hexOf(ground, 20)}` : `AVLC ${nsdu.stations}`;
		const direction = downlink ? 'a-to-b' : 'b-to-a';
		let result: Pick<CotpSessionResult, 'packet' | 'events' | 'assemblies'>;
		try {
			result = nsaps
				? this.session.push(nsdu.bytes, { link, direction, receivedAt: time, atnAddresses: nsaps })
				: this.unplaced(nsdu.bytes);
		} catch (error) {
			return { fields: [['ATN COTP', `not read: ${error instanceof Error ? error.message : 'invalid NSDU'}`]] };
		}
		const tpdus = result.packet.pdus.map((pdu) => `${pdu.typeName} (${checksum(pdu, !!nsaps)})`).join(' + ') || 'no TPDU';
		const fields: Field[] = [['ATN COTP', [tpdus, ...result.events.map(eventText)].join('; ')]];
		const up: AtnTsdu[] = [];
		for (const part of result.assemblies) {
			if (part.status === 'complete' && part.payload) up.push({ payload: part.payload, connection: part.connectionId, how: 'session' });
			else if (part.status === 'pending')
				fields.push(['ATN COTP', `DT ${part.fragments} of a TSDU on ${part.connectionId}, waiting for more`]);
			else fields.push(['ATN COTP', `${part.status} on ${part.connectionId}${part.reason ? `: ${part.reason}` : ''}`]);
		}
		const waiting = result.assemblies.length > 0 && result.assemblies.every((part) => part.status === 'pending');
		const scope = { key: `${link} ${direction}`, nsaps: !!nsaps };
		up.push(...this.singles(result.packet.pdus, scope, result.assemblies[0]?.connectionId, waiting, fields));
		return { fields, up };
	}

	/**
	 * The TPDUs of an NSDU whose NSAPs are not known, kept from the session: it verifies every ATN checksum, which covers
	 * the NSAPs, so it would refuse them all. Their DTs are read on their own.
	 */
	private unplaced(bytes: Uint8Array): Pick<CotpSessionResult, 'packet' | 'events' | 'assemblies'> {
		const packet = decodeCotp(bytes);
		if (!packet) throw new Error('not a COTP NSDU');
		return { packet, events: [], assemblies: [] };
	}

	/**
	 * Notes every DT; reads on its own one the session did not place (`placed` undefined) or holds back (`waiting`),
	 * under the connection its reference was last seen on.
	 */
	private singles(
		pdus: readonly CotpPdu[],
		scope: { key: string; nsaps: boolean },
		placed: string | undefined,
		waiting: boolean,
		fields: Field[],
	): AtnTsdu[] {
		const up: AtnTsdu[] = [];
		for (const pdu of pdus) {
			if (pdu.type !== DT) continue;
			const key = `${scope.key} ${pdu.destinationReference}`;
			if (placed) remember(this.connections, key, placed);
			const tail = this.open.get(key) === true;
			remember(this.open, key, !pdu.endOfTransmission);
			if ((placed && !waiting) || tail || !standalone(pdu, scope.nsaps)) continue;
			const why = waiting
				? 'its connection waits for an earlier DT that was not received'
				: 'the set-up of its connection was not followed';
			fields.push(['ATN COTP', `DT read on its own: ${why}`]);
			up.push({ payload: pdu.userData!, connection: this.connections.get(key) ?? key, how: 'single' });
		}
		return up;
	}
}
