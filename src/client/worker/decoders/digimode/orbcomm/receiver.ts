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
	private pendingEphemeris?: Uint8Array;
	private readonly fragments = new Map<string, { total: number; parts: Array<Uint8Array | undefined>; lastSlot: number }>();
	private slot = 0;

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
		this.pendingEphemeris = undefined;
		this.fragments.clear();
		this.slot = 0;
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
		this.slot++;
		if (this.pendingEphemeris) {
			const full = new Uint8Array(2 * PACKET_BYTES);
			full.set(this.pendingEphemeris);
			full.set(bytes, PACKET_BYTES);
			this.pendingEphemeris = undefined;
			if (fletcherOk(full)) {
				this.good += 2;
				this.report(parseOrbcommPacket(full)!);
				return;
			}
			this.bad++;
		}
		if (bytes[0] === 0x1f && !fletcherOk(bytes)) {
			this.pendingEphemeris = bytes.slice();
			return;
		}
		if (!fletcherOk(bytes)) {
			this.bad++;
			return;
		}
		this.good++;
		const parsed = parseOrbcommPacket(bytes)!;
		this.report(parsed);
		if (parsed.kind === 'message' || parsed.kind === 'uplink' || parsed.kind === 'downlink' || parsed.kind === 'network') {
			this.assemble(bytes, parsed.kind);
		}
	}

	private report(parsed: NonNullable<ReturnType<typeof parseOrbcommPacket>>): void {
		if (parsed.kind === 'sync') {
			this.satellite = parsed.satellite!;
			for (const [key, value] of this.fragments) if (this.slot - value.lastSlot > 500) this.fragments.delete(key);
			this.sink.status(`ORBCOMM satellite ${this.satellite} · ${this.good} packets`, true);
			return;
		}
		if (this.good % 50 === 0) this.sink.status(`ORBCOMM satellite ${this.satellite} · ${this.good} packets · ${this.bad} failed`, true);
		if (parsed.kind === 'fill') return;
		const fields = [['Satellite', this.satellite >= 0 ? String(this.satellite) : 'Unknown'] as [string, string], ...parsed.fields];
		this.sink.record({ text: `Sat ${this.satellite}: ${parsed.text}`, fields });
	}

	private assemble(bytes: Uint8Array, kind: string): void {
		const total = bytes[1] >> 4;
		const index = bytes[1] & 15;
		if (!total || index >= total) return;
		const key = `${this.satellite}:${kind}`;
		let assembly = this.fragments.get(key);
		if (!assembly || assembly.total !== total || index === 0 || this.slot - assembly.lastSlot > 500) {
			assembly = { total, parts: Array.from({ length: total }, () => undefined as Uint8Array | undefined), lastSlot: this.slot };
			this.fragments.set(key, assembly);
		}
		assembly.parts[index] = bytes.slice(2, 10);
		assembly.lastSlot = this.slot;
		if (assembly.parts.filter((part) => part !== undefined).length !== total) return;
		this.fragments.delete(key);
		const payload = new Uint8Array(8 * total);
		assembly.parts.forEach((part, partIndex) => payload.set(part!, 8 * partIndex));
		const payloadHex = Array.from(payload, (byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
		const fields: Array<[string, string]> = [
			['Satellite', String(this.satellite)],
			['Fragments', String(total)],
			['Payload (hex)', payloadHex],
		];
		const used = payload.filter((byte) => byte !== 0);
		if (used.length >= 4 && used.every((byte) => byte >= 32 && byte <= 126)) fields.push(['Printable bytes', String.fromCharCode(...used)]);
		this.sink.record({ text: `Sat ${this.satellite}: complete ${kind} · ${payload.length} bytes`, fields });
	}
}
