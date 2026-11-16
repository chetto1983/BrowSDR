import { describe, expect, it } from 'vitest';
import { crc16, descramble, fireCode } from '@/worker/decoders/dab/fec/crc';
import { depuncture, eepGeometry, ficDepuncture, subchannelProfile, uepGeometry } from '@/worker/decoders/dab/fec/puncture';
import { rsDecode120, rsEncode120 } from '@/worker/decoders/dab/fec/rs';
import { Viterbi } from '@/worker/decoders/dab/fec/viterbi';
import { convEncode, crc16 as txCrc16, eepSize, fireCode as txFireCode, prbs, punctureEep, punctureFic, rsEncode } from './gen-coding.js';
import { random } from './fixtures.js';

/** Soft values of sent bits (positive = 1) with Gaussian noise of `sigma` against an amplitude of 40. */
function soft(bits, sigma, rnd) {
	return Int8Array.from(bits, (b) => {
		const g = Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
		return Math.max(-127, Math.min(127, Math.round((b ? 40 : -40) + sigma * 40 * g)));
	});
}

const randomBits = (n, rnd) => Uint8Array.from({ length: n }, () => (rnd() < 0.5 ? 1 : 0));
const errors = (a, b, n) => a.slice(0, n).reduce((e, v, i) => e + (v !== b[i] ? 1 : 0), 0);

describe('DAB channel coding', () => {
	it('matches the transmitter on CRC-16, the Fire code and the energy dispersal', () => {
		const rnd = random(3);
		for (let n = 1; n < 40; n += 7) {
			const d = Uint8Array.from({ length: n }, () => Math.floor(rnd() * 256));
			expect(crc16(d, n)).toBe(txCrc16(d, n));
			expect(fireCode(d, n)).toBe(txFireCode(d, n));
		}
		// CRC-16/GENIBUS of "123456789" and the first bits of the energy dispersal (EN 300 401 table 12)
		expect(crc16(new TextEncoder().encode('123456789'), 9)).toBe(0xd64e);
		const zeros = new Uint8Array(16);
		descramble(zeros, 16);
		expect(Array.from(zeros).join('')).toBe('0000011110111110');
		expect(Array.from(prbs(16)).join('')).toBe('0000011110111110');
	});

	it('decodes the FIC code word through noise (rate 1/3 puncturing, Viterbi)', () => {
		const rnd = random(7);
		const bits = randomBits(768, rnd);
		const sent = punctureFic(convEncode(bits, 768));
		expect(sent.length).toBe(2304);
		const mother = new Int8Array(3096);
		ficDepuncture(soft(sent, 0.6, rnd), 0, mother);
		const out = new Uint8Array(768);
		new Viterbi().decode(mother, 768, out);
		expect(errors(out, bits, 768)).toBe(0);
	});

	it.each([
		['EEP 3-A', 48, 0, 2, 0.7],
		['EEP 1-B', 64, 1, 0, 0.75],
		['EEP 4-A', 32, 0, 3, 0.45],
	])('decodes %s at %i kbit/s through noise', (_, bitrate, option, level, sigma) => {
		const rnd = random(bitrate + level);
		const size = eepSize(bitrate, option, level);
		const g = eepGeometry(size, option, level);
		expect(g).toMatchObject({ bitrate, infoBits: bitrate * 24 });
		const bits = randomBits(g.infoBits, rnd);
		const sent = punctureEep(convEncode(bits, g.infoBits), bitrate, option, level);
		expect(sent.length).toBe(size * 64);
		const profile = subchannelProfile(true, size, option, level, 0);
		const mother = new Int8Array(4 * (g.infoBits + 6));
		depuncture(profile, soft(sent, sigma, rnd), mother);
		const out = new Uint8Array(g.infoBits);
		new Viterbi().decode(mother, g.infoBits, out);
		expect(errors(out, bits, g.infoBits)).toBe(0);
	});

	it('decodes every UEP profile of table 6 without noise', () => {
		const rnd = random(11);
		for (let index = 0; index < 64; index++) {
			const g = uepGeometry(index);
			const profile = subchannelProfile(false, 0, 0, 0, index);
			expect(profile, `UEP index ${index}`).not.toBeNull();
			expect(profile.bits).toBe(g.size * 64);
			if (index % 9) continue;
			const bits = randomBits(g.infoBits, rnd);
			const mother = convEncode(bits, g.infoBits);
			const rx = new Int8Array(profile.bits);
			profile.kept.forEach((pos, k) => (rx[k] = mother[pos] ? 40 : -40));
			const m = new Int8Array(mother.length);
			depuncture(profile, rx, m);
			const out = new Uint8Array(g.infoBits);
			new Viterbi().decode(m, g.infoBits, out);
			expect(errors(out, bits, g.infoBits)).toBe(0);
		}
	});

	it('corrects 5 byte errors of an RS(120,110) code word and refuses 6', () => {
		const rnd = random(5);
		const data = Uint8Array.from({ length: 110 }, () => Math.floor(rnd() * 256));
		const cw = new Uint8Array(120),
			mine = new Uint8Array(120);
		rsEncode(data, cw);
		rsEncode120(data, mine);
		expect(mine).toEqual(cw);
		expect(rsDecode120(cw.slice())).toBe(0);
		const bad = cw.slice();
		for (const at of [0, 17, 55, 109, 119]) bad[at] ^= 1 + Math.floor(rnd() * 255);
		expect(rsDecode120(bad)).toBe(5);
		expect(bad).toEqual(cw);
		const worse = cw.slice();
		for (const at of [1, 2, 3, 40, 80, 118]) worse[at] ^= 0x5a;
		const before = worse.slice();
		expect(rsDecode120(worse)).toBe(-1);
		expect(worse).toEqual(before);
	});
});
