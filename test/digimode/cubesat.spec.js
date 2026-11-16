import { describe, expect, it } from 'vitest';
import { CubesatDecoder, CUBESAT_RATE } from '@/worker/decoders/digimode/cubesat';
import { afskSignal, ax25Frame, wireBits } from '../decoders/aprs/fixtures';
import { noise } from './fixtures';

/** G3RUH FSK as a satellite sends it: NRZI, the x^17 + x^12 + 1 scrambler, ±3 kHz NRZ FSK at 96 kHz. */
function g3ruhSignal(bits, { baud = 9600, offsetHz = 0, noiseLevel = 0, seed = 7 } = {}) {
	const levels = [];
	let level = 0;
	let sr = 0;
	for (const bit of bits) {
		if (!bit) level ^= 1; // NRZI: a zero changes the level
		const sent = level ^ ((sr >> 11) & 1) ^ ((sr >> 16) & 1);
		sr = ((sr << 1) | sent) & 0x1ffff;
		levels.push(sent);
	}
	const perBit = CUBESAT_RATE / baud;
	const lead = 4800;
	const count = lead * 2 + Math.ceil(levels.length * perBit);
	const iq = new Float32Array(count * 2);
	const random = noise(seed);
	let phase = 0;
	for (let n = 0; n < count; n++) {
		const k = Math.floor((n - lead) / perBit);
		const deviation = k >= 0 && k < levels.length ? (levels[k] ? 3000 : -3000) : 0;
		phase += (2 * Math.PI * (offsetHz + deviation)) / CUBESAT_RATE;
		iq[2 * n] = Math.cos(phase) + noiseLevel * random();
		iq[2 * n + 1] = Math.sin(phase) + noiseLevel * random();
	}
	return iq;
}

/** AFSK at 48 kHz brought to the decoder's 96 kHz by repeating samples (the decoder takes every other one). */
function upsample(iq) {
	const out = new Float32Array(iq.length * 2);
	for (let n = 0; n < iq.length / 2; n++) out.set([iq[2 * n], iq[2 * n + 1], iq[2 * n], iq[2 * n + 1]], 4 * n);
	return out;
}

function decode(iq) {
	const records = [];
	const decoder = new CubesatDecoder({ record: (r) => records.push(r), status: () => {} });
	for (let i = 0; i < iq.length; i += 8192) decoder.process(iq.subarray(i, Math.min(iq.length, i + 8192)));
	return records;
}

const field = (record, label) => record.fields.find(([name]) => name === label)?.[1];

describe('CubeSat AX.25 telemetry', () => {
	it('decodes a 9600 bd G3RUH frame 1.2 kHz off tune', () => {
		const bits = wireBits(ax25Frame('UPSAT-1', 'CQ', [], 'Hello from orbit, battery 7.9 V'), { flags: 64 });
		const [record] = decode(g3ruhSignal(bits, { offsetHz: 1200, noiseLevel: 0.4 }));
		expect(record.text).toBe('UPSAT-1 → CQ: Hello from orbit, battery 7.9 V');
		expect(field(record, 'Framing')).toBe('G3RUH 9600 bd');
	});
	it('decodes 4800 bd G3RUH and shows binary telemetry as bytes', () => {
		const info = String.fromCharCode(...Array.from({ length: 40 }, (_, i) => (i * 37) & 255));
		const bits = wireBits(ax25Frame('BEESAT', 'DP0BEE', [], info), { flags: 40 });
		const [record] = decode(g3ruhSignal(bits, { baud: 4800 }));
		expect(record.text).toBe('BEESAT → DP0BEE: 40 bytes of binary telemetry');
		expect(field(record, 'Hex').startsWith('00 25 4a 6f')).toBe(true);
	});
	it('decodes the ISS 1200 bd AFSK digipeater and names it', () => {
		const iq = afskSignal(wireBits(ax25Frame('RS0ISS', 'CQ', ['ARISS'], '>ARISS - International Space Station')), {
			rate: 48000,
			offset: 900,
		});
		const records = decode(upsample(iq));
		expect(records).toHaveLength(1);
		expect(records[0].text).toBe('ISS · RS0ISS → CQ,ARISS: >ARISS - International Space Station');
		expect(field(records[0], 'Framing')).toBe('AFSK 1200 bd');
	});
	it('ignores a frame with a bad check sequence', () => {
		const bits = wireBits(ax25Frame('UPSAT-1', 'CQ', [], 'corrupted'), { flags: 64, corrupt: true });
		expect(decode(g3ruhSignal(bits))).toHaveLength(0);
	});
});
