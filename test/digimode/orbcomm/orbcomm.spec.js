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
	it('requires Fletcher checksum and reports fragments without guessing binary payloads', () => {
		const packets = frame(7, 23);
		expect(isSync(packets[0])).toBe(true);
		expect(fletcherOk(packets[2])).toBe(true);
		expect(parseOrbcommPacket(packets[2]).text).toContain('Downlink info 1/3');
		expect(parseOrbcommPacket(packets[1]).text).toContain('Ephemeris');
		const corrupted = packets[2].slice();
		corrupted[5] ^= 1;
		expect(parseOrbcommPacket(corrupted)).toBeNull();
	});

	it('decodes a pulse-shaped downlink with Doppler and shows message fragments', () => {
		const { records, statuses } = decode(signal({ seconds: 3, offsetHz: 1200 }));
		expect(statuses.some((status) => status.locked && status.message.includes('satellite 23'))).toBe(true);
		expect(records.some((record) => record.text.includes('Ephemeris'))).toBe(true);
		expect(records.some((record) => record.text.includes('Downlink info 1/3'))).toBe(true);
		expect(records.some((record) => record.text.includes('Message fragment 1/2'))).toBe(true);
	});

	it('survives negative Doppler, clock error and a corrupt packet', () => {
		const { records, statuses } = decode(signal({ seconds: 4, offsetHz: -3700, clockPpm: 150, breakPacket: true }));
		expect(statuses.some((status) => status.locked)).toBe(true);
		expect(records.some((record) => record.text.includes('Message fragment 1/2'))).toBe(true);
		expect(records.some((record) => record.text.includes('Ephemeris'))).toBe(true);
	});

	it('parses checksum-valid packets captured from the live pass', () => {
		const message = Uint8Array.from([0x1a, 0x21, 0x13, 0x31, 0x3d, 0, 0, 0, 0, 0, 0xba, 0x8a]);
		const downlink = Uint8Array.from([0x1c, 0x32, 0x27, 0x01, 0x14, 0, 0, 0, 0, 0, 0xe5, 0x91]);
		expect(parseOrbcommPacket(message).text).toBe('Message fragment 2/2 · 13 31 3D 00 00 00 00 00');
		expect(parseOrbcommPacket(downlink).text).toBe('Downlink info 3/3 · 27 01 14 00 00 00 00 00');
		expect(parseOrbcommPacket(downlink).fields).not.toContainEqual(['Channels', expect.anything()]);
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
