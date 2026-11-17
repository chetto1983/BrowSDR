// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from OnAir core/src/orbcomm/orbcomm_rx.cpp; one receiver per BrowSDR VFO.
import type { DigimodeDecoder, DigimodeSink } from '@/worker/decoders/digimode/types';
import type { MessageParts } from './types';
import { FRAME_PACKETS, PACKET_BYTES, fletcherOk, isSync, parseOrbcommPacket } from './protocol';
import { OrbcommDemodulator } from './demodulator';

const PACKET_BITS = PACKET_BYTES * 8;

function bitsToBytes(bits: ArrayLike<number>, polarity: number): Uint8Array {
	const packet = new Uint8Array(PACKET_BYTES);
	for (let bit = 0; bit < PACKET_BITS; bit++) packet[bit >> 3] |= (bits[bit] ^ polarity) << (bit & 7);
	return packet;
}

/** One tuned ORBCOMM downlink. Two VFOs can run independent receivers in the same SDR passband. */
export class OrbcommReceiver implements DigimodeDecoder {
	private readonly demodulator = new OrbcommDemodulator((bit) => this.bit(bit));
	private readonly search: number[] = [];
	private readonly packetBits = new Uint8Array(PACKET_BITS);
	private readonly parts = new Map<string, MessageParts>();
	private locked = false;
	private polarity = 0;
	private packetIndex = 0;
	private bitCount = 0;
	private missedSync = 0;
	private satellite = -1;
	private good = 0;
	private bad = 0;
	private station?: { lat: number; lon: number };

	constructor(private readonly sink: DigimodeSink) {}

	process(iq: Float32Array): void {
		this.demodulator.process(iq);
	}

	setStation(lat: number, lon: number): void {
		this.station = { lat, lon };
	}

	reset(): void {
		this.demodulator.reset();
		this.search.length = 0;
		this.parts.clear();
		this.locked = false;
		this.polarity = 0;
		this.packetIndex = 0;
		this.bitCount = 0;
		this.missedSync = 0;
		this.satellite = -1;
		this.good = 0;
		this.bad = 0;
		this.sink.status('Searching for ORBCOMM sync', false);
	}

	private bit(bit: number): void {
		if (!this.locked) {
			this.search.push(bit);
			if (this.search.length > PACKET_BITS) this.search.shift();
			if (this.search.length < PACKET_BITS) return;
			for (let polarity = 0; polarity < 2; polarity++) {
				const packet = bitsToBytes(this.search, polarity);
				if (!isSync(packet)) continue;
				this.locked = true;
				this.polarity = polarity;
				this.packetIndex = 1;
				this.bitCount = 0;
				this.missedSync = 0;
				this.search.length = 0;
				this.packet(packet);
				return;
			}
			return;
		}
		this.packetBits[this.bitCount++] = bit;
		if (this.bitCount !== PACKET_BITS) return;
		this.bitCount = 0;
		const packet = bitsToBytes(this.packetBits, this.polarity);
		const index = this.packetIndex;
		this.packetIndex = (index + 1) % FRAME_PACKETS;
		if (index === 0) {
			if (isSync(packet)) this.missedSync = 0;
			else if (++this.missedSync >= 2) {
				this.locked = false;
				this.search.length = 0;
				this.sink.status('ORBCOMM sync lost', false);
				return;
			}
		}
		this.packet(packet);
	}

	private packet(bytes: Uint8Array): void {
		if (!fletcherOk(bytes)) {
			this.bad++;
			return;
		}
		this.good++;
		const parsed = parseOrbcommPacket(bytes)!;
		if (parsed.kind === 'sync') {
			this.satellite = parsed.satellite!;
			this.sink.status(`ORBCOMM satellite ${this.satellite} · ${this.good} packets`, true);
			return;
		}
		if (this.good % 50 === 0) this.sink.status(`ORBCOMM satellite ${this.satellite} · ${this.good} packets · ${this.bad} failed`, true);
		if (parsed.kind === 'fill') return;
		const fields = [['Satellite', this.satellite >= 0 ? String(this.satellite) : 'Unknown'] as [string, string], ...parsed.fields];
		if (parsed.position && this.station) {
			const lat1 = (this.station.lat * Math.PI) / 180;
			const lat2 = (parsed.position.lat * Math.PI) / 180;
			const dlat = lat2 - lat1;
			const dlon = ((parsed.position.lon - this.station.lon) * Math.PI) / 180;
			const arc =
				2 * Math.asin(Math.min(1, Math.sqrt(Math.sin(dlat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) ** 2)));
			fields.push(['Ground distance', `${Math.round(6371 * arc)} km`]);
		}
		this.sink.record({ text: `Sat ${this.satellite}: ${parsed.text}`, fields });
		if (!parsed.message) return;
		const { id, part, last, text } = parsed.message;
		const key = `${this.satellite}:${id}`;
		if (part === 0) this.parts.set(key, { next: 0, text: '' });
		const entry = this.parts.get(key);
		if (!entry || entry.next !== part) return;
		entry.text += text;
		entry.next++;
		if (entry.text.length > 512) this.parts.delete(key);
		else if (last) {
			const full = entry.text.trimEnd();
			this.sink.record({
				text: `Sat ${this.satellite}: message ${id} complete · ${full}`,
				fields: [
					['Satellite', String(this.satellite)],
					['Message ID', String(id)],
					['Text', full],
				],
			});
			this.parts.delete(key);
		}
		if (this.parts.size > 64) this.parts.clear();
	}
}
