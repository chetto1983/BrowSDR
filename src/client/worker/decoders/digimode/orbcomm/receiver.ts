// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from OnAir core/src/orbcomm/orbcomm_rx.cpp; one receiver per BrowSDR VFO.
import type { DigimodeDecoder, DigimodeSink } from '@/worker/decoders/digimode/types';
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
	private locked = false;
	private polarity = 0;
	private packetIndex = 0;
	private bitCount = 0;
	private missedSync = 0;
	private satellite = -1;
	private good = 0;
	private bad = 0;

	constructor(private readonly sink: DigimodeSink) {}

	process(iq: Float32Array): void {
		this.demodulator.process(iq);
	}

	reset(): void {
		this.demodulator.reset();
		this.search.length = 0;
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
		this.sink.record({ text: `Sat ${this.satellite}: ${parsed.text}`, fields });
	}
}
