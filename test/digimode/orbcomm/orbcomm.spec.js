import { describe, expect, it } from 'vitest';
import { fletcherOk, isSync, parseOrbcommPacket } from '@/worker/decoders/digimode/orbcomm/protocol';
import { OrbcommReceiver } from '@/worker/decoders/digimode/orbcomm/receiver';
import { frame, signal } from './fixtures';

function decode(iq) {
	const records = [];
	const statuses = [];
	const receiver = new OrbcommReceiver({
		record: (record) => records.push(record),
		status: (message, locked) => statuses.push({ message, locked }),
	});
	for (let i = 0; i < iq.length; i += 4096) receiver.process(iq.subarray(i, i + 4096));
	return { records, statuses };
}

describe('ORBCOMM public downlink', () => {
	it('requires Fletcher checksum and parses sync, channels and position', () => {
		const packets = frame(7, 23);
		expect(isSync(packets[0])).toBe(true);
		expect(fletcherOk(packets[2])).toBe(true);
		expect(parseOrbcommPacket(packets[2]).text).toContain('137.2500');
		const position = parseOrbcommPacket(packets[1]).position;
		expect(position.lat).toBeGreaterThan(8);
		expect(position.lat).toBeLessThan(9);
		expect(position.altitudeKm).toBeGreaterThan(690);
		const corrupted = packets[2].slice();
		corrupted[5] ^= 1;
		expect(parseOrbcommPacket(corrupted)).toBeNull();
	});

	it('decodes a pulse-shaped downlink with Doppler and assembles messages', () => {
		const { records, statuses } = decode(signal({ seconds: 3, offsetHz: 1200 }));
		expect(statuses.some((status) => status.locked && status.message.includes('satellite 23'))).toBe(true);
		expect(records.some((record) => record.text.includes('Position'))).toBe(true);
		expect(records.some((record) => record.text.includes('Downlink channels'))).toBe(true);
		expect(records.some((record) => record.text.includes('HELLO WORLD'))).toBe(true);
	});

	it('survives negative Doppler, clock error and a corrupt packet', () => {
		const { records, statuses } = decode(signal({ seconds: 4, offsetHz: -3700, clockPpm: 150, breakPacket: true }));
		expect(statuses.some((status) => status.locked)).toBe(true);
		expect(records.some((record) => record.text.includes('HELLO WORLD'))).toBe(true);
		expect(records.some((record) => record.text.includes('Position'))).toBe(true);
	});

	it('does not claim a satellite from receiver noise', () => {
		const noise = new Float32Array(48000 * 2);
		let seed = 987654321;
		for (let i = 0; i < noise.length; i++) {
			seed = (1664525 * seed + 1013904223) >>> 0;
			noise[i] = (seed / 0x100000000) * 2 - 1;
		}
		const { records, statuses } = decode(noise);
		expect(records).toHaveLength(0);
		expect(statuses.some((status) => status.locked)).toBe(false);
	});
});
