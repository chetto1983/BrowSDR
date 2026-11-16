import { describe, expect, it } from 'vitest';
import { vhfDscSignal as vhfSignal } from './fixtures';
import { DscVhfDecoder } from '@/worker/decoders/digimode/dsc';
import { dscParseCall } from '@/worker/decoders/digimode/dsc/call';
import {
	dscBuildAllShips,
	dscBuildDistress,
	dscBuildIndividual,
	dscFrameBits,
	dscSymbolBits,
	dscSymbolDecode,
} from '@/worker/decoders/digimode/dsc/symbols';

function decode(iq) {
	const records = [];
	const decoder = new DscVhfDecoder({ record: (r) => records.push(r), status: () => {} });
	for (let i = 0; i < iq.length; i += 2048) decoder.process(iq.subarray(i, Math.min(iq.length, i + 2048)));
	return records;
}

const field = (record, label) => record.fields.find(([name]) => name === label)?.[1];

describe('DSC symbols', () => {
	it('round-trips all 128 symbols through their 10-bit form', () => {
		for (let s = 0; s < 128; s++) expect(dscSymbolDecode(dscSymbolBits(s))).toBe(s);
	});
	it('rejects a symbol with one bit flipped', () => {
		for (let s = 0; s < 128; s++) for (let b = 0; b < 10; b++) expect(dscSymbolDecode(dscSymbolBits(s) ^ (1 << b))).not.toBe(s);
	});
});

describe('DSC call parsing', () => {
	it('reads a distress alert', () => {
		const body = dscBuildDistress('247123450', 105, 44.5, 8.9, 14, 32, 100);
		const call = dscParseCall(body, 127, true, 0);
		expect(call.kind).toBe('Distress alert');
		expect(call.from).toBe('247123450');
		expect(call.natureName).toBe('Sinking');
		expect(call.position.text).toBe("44°30'N 008°54'E");
		expect(call.time).toBe('14:32 UTC');
		expect(call.telecommandText).toBe('then F3E/G3E simplex telephony');
	});
	it('reads an all-ships safety call with a working channel', () => {
		const body = dscBuildAllShips('002470100', 108, 100, 126, 900016, -1);
		const call = dscParseCall(body, 127, true, 0);
		expect(call.kind).toBe('All ships safety call');
		expect(call.freqRx).toBe('VHF ch 16');
	});
});

describe('VHF DSC receiver', () => {
	const individual = dscBuildIndividual('247987650', 100, '002470100', 100, 126, 900006, -1);
	const bits = dscFrameBits(individual, 117, 20);

	it('decodes an individual call 1.5 kHz off tune in noise', () => {
		const records = decode(vhfSignal(bits, { offsetHz: 1500, noiseLevel: 0.6 }));
		expect(records).toHaveLength(1);
		const [record] = records;
		expect(record.damaged).toBe(false);
		expect(record.text).toBe('Individual call: 002470100 → 247987650');
		expect(field(record, 'From')).toBe('002470100 (coast station)');
		expect(field(record, 'To')).toBe('247987650 (ship)');
		expect(field(record, 'Frequency (rx)')).toBe('VHF ch 6');
		expect(field(record, 'End')).toBe('Acknowledgement requested');
	});
	it('repairs damaged symbols from the second copy', () => {
		const damaged = [...bits];
		// Flip one bit in each of three DX symbols of the message (slots 18, 22, 26 start after the 20 dot bits).
		for (const slot of [18, 22, 26]) damaged[20 + slot * 10 + 3] ^= 1;
		const [record] = decode(vhfSignal(damaged));
		expect(record.damaged).toBe(false);
		expect(record.text).toBe('Individual call: 002470100 → 247987650');
	});
	it('flags a distress alert', () => {
		const alert = dscFrameBits(dscBuildDistress('247123450', 110, 44.1, 9.8, 9, 5, 100), 127, 20);
		const [record] = decode(vhfSignal(alert, { offsetHz: -2000 }));
		expect(record.alert).toBe(true);
		expect(record.text).toBe("Distress alert: 247123450 → all stations - Man overboard at 44°06'N 009°48'E");
	});
	it('stays quiet on noise', () => {
		expect(decode(vhfSignal([], { noiseLevel: 1, lead: 48000 }))).toHaveLength(0);
	});
});
