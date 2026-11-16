import { describe, expect, it } from 'vitest';
import { navtexBits, navtexSignal } from './marine-fixtures';
import { NavtexReceiver } from '@/worker/decoders/digimode/navtex';
import { NavtexDecoder } from '@/worker/decoders/digimode/navtex/decoder';
import { ccir476Char, ccir476Code, ccir476Valid, codesToBits, navtexEncode, sitorBSlots } from '@/worker/decoders/digimode/navtex/code';

const MESSAGE = 'ZCZC EA42\n161230 UTC NOV 26\nGALE WARNING 118. DOVER WIGHT: SOUTHWEST 8, LATER 9.\nNNNN\n';
const BODY = '161230 UTC NOV 26\nGALE WARNING 118. DOVER WIGHT: SOUTHWEST 8, LATER 9.';

function receive(iq) {
	const records = [];
	const statuses = [];
	const receiver = new NavtexReceiver({ record: (r) => records.push(r), status: (message, locked) => statuses.push({ message, locked }) });
	for (let i = 0; i < iq.length; i += 4096) receiver.process(iq.subarray(i, Math.min(iq.length, i + 4096)));
	return { records, statuses };
}

const field = (record, label) => record.fields.find(([name]) => name === label)?.[1];

describe('CCIR 476 code', () => {
	it('has 35 code words with four marks, each character in one of them', () => {
		const valid = Array.from({ length: 128 }, (_, c) => c).filter(ccir476Valid);
		expect(valid).toHaveLength(35);
		for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ ') expect(ccir476Char(ccir476Code(ch, false), false)).toBe(ch);
		for (const ch of '0123456789-?:().,/=+') expect(ccir476Char(ccir476Code(ch, true), true)).toBe(ch);
	});
	it('puts the retransmission five places after the DX character', () => {
		// DX at even places, RX (alpha while there is nothing to repeat) at odd places, beta when the DX runs out.
		expect(sitorBSlots([0x47, 0x72, 0x1d])).toEqual([0x47, 0x0f, 0x72, 0x0f, 0x1d, 0x47, 0x33, 0x72, 0x33, 0x1d]);
	});
});

describe('NAVTEX decoder (bits)', () => {
	const decode = (bits) => {
		const messages = [];
		const decoder = new NavtexDecoder((m) => messages.push(m));
		for (const bit of bits) decoder.pushBit(bit ? 0.9 : -0.9);
		decoder.flush();
		return messages;
	};
	it('reads a message between ZCZC and NNNN', () => {
		const [message, ...rest] = decode(navtexBits(MESSAGE));
		expect(rest).toHaveLength(0);
		expect(message).toMatchObject({ station: 'E', subject: 'A', number: 42, header: 'EA42', complete: true, errors: 0 });
		expect(message.subjectName).toBe('Navigational warning');
		expect(message.text).toBe(BODY);
	});
	it('repairs damaged characters from the retransmission (time diversity)', () => {
		const bits = navtexBits(MESSAGE);
		// Damage every eighth DX character of the message: one bit flipped gives a word of three or five marks.
		for (let place = 2 * 40 + 2 * 6; place < bits.length / 7 - 30; place += 16) bits[place * 7 + 3] ^= 1;
		const [message] = decode(bits);
		expect(message.errors).toBe(0);
		expect(message.text).toBe(BODY);
	});
	it('keeps a message cut short without NNNN', () => {
		const bits = codesToBits(sitorBSlots([...new Array(40).fill(-1), ...navtexEncode('ZCZC OB07\nWIND NW 6\n')]));
		const [message] = decode(bits);
		expect(message).toMatchObject({ header: 'OB07', complete: false, text: 'WIND NW 6', subjectName: 'Meteorological warning' });
	});
});

describe('NAVTEX receiver', () => {
	it('decodes a message 130 Hz off tune in noise (0 dB SNR in 3 kHz)', () => {
		const { records, statuses } = receive(navtexSignal(navtexBits(MESSAGE), { offsetHz: 130, noiseLevel: 7, seed: 7 }));
		expect(records).toHaveLength(1);
		const [record] = records;
		expect(record.text).toBe('NAVTEX E Navigational warning 42: 161230 UTC NOV 26');
		expect(record.damaged).toBe(false);
		expect(field(record, 'Station')).toBe('E');
		expect(field(record, 'Number')).toBe('42');
		expect(field(record, 'Text')).toBe(BODY);
		expect(field(record, 'Unreadable')).toBe('0 (0.0 %)');
		expect(statuses.some((s) => s.message.startsWith('FSK signal +1'))).toBe(true);
		expect(statuses.some((s) => s.locked)).toBe(true);
	});
	it('decodes swapped tones below the dial and lists a repeat once', () => {
		const bits = navtexBits('ZCZC KD00\nMAYDAY RELAY. VESSEL ON FIRE IN 43-55N 008-10E.\nNNNN\n');
		const { records } = receive(navtexSignal([...bits, ...bits], { offsetHz: -240, noiseLevel: 1.5, invert: true, seed: 3 }));
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ alert: true, damaged: false });
		expect(records[0].text).toBe(
			'NAVTEX K Search and rescue information, piracy warning 00: MAYDAY RELAY. VESSEL ON FIRE IN 43-55N 008-10E.',
		);
	});
	it('stays quiet on noise', () => {
		const { records, statuses } = receive(navtexSignal([], { noiseLevel: 2, lead: 20, seed: 11 }));
		expect(records).toHaveLength(0);
		expect(statuses.some((s) => s.locked)).toBe(false);
	});
});
