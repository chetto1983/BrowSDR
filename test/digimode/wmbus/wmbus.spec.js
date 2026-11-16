import { describe, expect, it } from 'vitest';
import { WmbusDecoder, WMBUS_RATE } from '@/worker/decoders/digimode/wmbus';
import { crc16, decode36, encode36, mfrStringToCode, parseFrame } from '@/worker/decoders/digimode/wmbus/proto';
import { parseRecords } from '@/worker/decoders/digimode/wmbus/records';
import { buildFrame, encodeChips, meterBurst, meterFrame, wmbusSignal } from './fixtures';

function decode(iq) {
	const records = [];
	const decoder = new WmbusDecoder({ record: (r) => records.push(r), status: () => {} });
	for (let i = 0; i < iq.length; i += 8192) decoder.process(iq.subarray(i, Math.min(iq.length, i + 8192)));
	return records;
}

const field = (record, label) => record.fields.find(([name]) => name === label)?.[1];

describe('Wireless M-Bus link layer', () => {
	it('uses the EN 13757-4 CRC and 3-out-of-6 code', () => {
		expect(crc16(new TextEncoder().encode('123456789'))).toBe(0xc2b7); // CRC-16/EN-13757 check value
		const table = [0x16, 0x0d, 0x0e, 0x0b, 0x1c, 0x19, 0x1a, 0x13, 0x2c, 0x25, 0x26, 0x23, 0x34, 0x31, 0x32, 0x29];
		table.forEach((word, nibble) => {
			expect(encode36(nibble)).toBe(word);
			expect(decode36(word)).toBe(nibble);
		});
		expect(decode36(0x38)).toBe(-1);
		expect(mfrStringToCode('KAM')).toBe(0x2c2d); // "2D 2C" in every Kamstrup telegram
	});
	it('reads the link layer, the short header and the records of a format A frame', () => {
		const { air } = meterFrame(0, 0);
		const f = parseFrame(air, air.length, false);
		expect(f).toMatchObject({ ok: true, mfr: 'KAM', id: '12345678', version: 0x1b, typeName: 'water', ci: 0x7a, acc: 0 });
		expect(f.records.map((r) => `${r.quantity} ${r.value}`)).toContain('Volume 123.456 m3');
		const bad = air.slice();
		bad[bad.length >> 1] ^= 0x10;
		expect(parseFrame(bad, bad.length, false)).toMatchObject({ ok: false, crcOk: false });
	});
	it('reads a two-block format B frame', () => {
		const { phy, air } = meterFrame(4, 1);
		expect(phy).toBe('C1B');
		expect(air.length).toBeGreaterThan(128);
		const f = parseFrame(air, air.length, true);
		expect(f.ok).toBe(true);
		expect(f.records.length).toBeGreaterThan(20);
	});
	it('names the security mode of an encrypted payload and of an encrypted extended link layer', () => {
		const head = [0x44, 0x2d, 0x2c, 0x78, 0x56, 0x34, 0x12, 0x01, 0x07];
		const mode7 = parseFrame(...frameOf([...head, 0x7a, 0x11, 0x00, 0x10, 0x07, ...Array(16).fill(0xa5)]));
		expect(mode7).toMatchObject({ ok: true, encrypted: true, encryption: 'mode 7 (AES-128-CBC, ephemeral key)', acc: 0x11 });
		expect(mode7.records).toHaveLength(0);
		const ell = [...head, 0x8d, 0x20, 0x01, 0x00, 0x00, 0x00, 0x20, 0x00, 0x00, 0x7a, 0x01, 0x00, 0x00, 0x00, 0x04, 0x13];
		expect(parseFrame(...frameOf([...ell, 0x10, 0x27, 0x00, 0x00]))).toMatchObject({ encrypted: true, encryption: 'ELL AES-128-CTR' });
		ell[12] = 0xe0; // the time bits of the session number, ENC 0: in clear
		ell[15] = 0x00;
		const clear = parseFrame(...frameOf([...ell, 0x10, 0x27, 0x00, 0x00]));
		expect(clear).toMatchObject({ ok: true, encrypted: false });
		expect(clear.records.map((r) => r.value)).toEqual(['10.000 m3']);
	});
	it('never throws on garbage', () => {
		let x = 7;
		const b = new Uint8Array(64);
		for (let k = 0; k < 3000; k++) {
			for (let i = 0; i < b.length; i++) {
				x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
				b[i] = x >>> 24;
			}
			expect(parseFrame(b, 1 + (x % 64), (x & 0x100) !== 0).ok).toBe(false);
			parseRecords(b);
		}
	});
	it('reads data records of every kind (OnAir test values)', () => {
		const d = [
			0x01, 0x13, 0x7f, 0x82, 0x01, 0x13, 0x10, 0x00, 0x0a, 0x5a, 0x34, 0x12, 0x0b, 0x2d, 0x99, 0x99, 0xf9, 0x02, 0x6c, 0x21, 0x3a,
		];
		d.push(0x0d, 0x78, 0x03, 0x41, 0x42, 0x43, 0x2f, 0x2f, 0x0f, 0x01, 0x02);
		const { complete, records, manufacturerData } = parseRecords(Uint8Array.from(d));
		expect(complete && manufacturerData).toBe(true);
		// VIF 0x2D is power in hW: the negative BCD 99999 reads -9999900 W
		expect(records.map((r) => r.value)).toEqual(['0.127 m3', '0.016 m3', '123.4 C', '-9999900 W', '2025-10-01', 'CBA']);
		expect(records[1].note).toBe('storage 2');
		expect(records[3]).toMatchObject({ numeric: true, number: -99999 });
		const dife = parseRecords(Uint8Array.from([0xc4, 0x8f, 0x8f, 0x8f, 0x8f, 0x8f, 0x8f, 0x8f, 0x8f, 0x8f, 0x0f, 0x13, 0x01, 0, 0, 0]));
		expect(dife.records[0].storage).toBe(2 ** 41 - 1);
		expect(parseRecords(Uint8Array.from([0x04, 0x13, 0x01])).complete).toBe(false);
	});
});

/** A logical frame (without L) as parseFrame's arguments. */
function frameOf(body) {
	const air = buildFrame(body, false);
	return [air, air.length, false];
}

describe('Wireless M-Bus receiver', () => {
	it('decodes a T1 heat meter (3-out-of-6) 3 kHz off tune in noise', () => {
		const records = decode(wmbusSignal([meterBurst(1)], { offsetHz: 3000, noiseLevel: 0.5, seed: 3 }));
		expect(records).toHaveLength(1);
		const [record] = records;
		expect(record.damaged).toBeUndefined();
		expect(record.text).toBe(
			'ELV heat (outlet) 40112233 · T1 · Energy 8123461000 Wh; Volume 450.035 m3; Power 34700 W; Flow temperature 65.2 C',
		);
		expect(field(record, 'Mode')).toBe('T1, frame format A');
		expect(field(record, 'C field')).toBe('0x44 SND-NR (send, no reply)');
		expect(field(record, 'CI field')).toBe('0x7A short header, variable data');
		expect(field(record, 'Access number')).toBe('5');
		expect(field(record, 'Encryption')).toBe('none');
		expect(field(record, 'CRC')).toBe('ok');
		// OnAir's estimate is the discriminator mean when the sync word ends, which the sync chips pull by a few kHz
		expect(Math.abs(parseFloat(field(record, 'Carrier offset')) - 3)).toBeLessThan(10);
	});
	it('reports an encrypted T1 payload as encrypted without decoding it', () => {
		const [record] = decode(wmbusSignal([meterBurst(2)], { offsetHz: -2000, noiseLevel: 0.4 }));
		expect(record.text).toBe('EMH electricity 50667788 · T1 · encrypted, mode 5 (AES-128-CBC)');
		expect(field(record, 'Encryption')).toBe('mode 5 (AES-128-CBC), payload not decrypted');
		expect(field(record, 'Readings')).toBeUndefined();
		expect(field(record, 'Payload')).toHaveLength(64);
	});
	it('decodes C1 frame formats A and B (NRZ) at ±45 kHz deviation', () => {
		const records = decode(wmbusSignal([meterBurst(3), meterBurst(4)], { offsetHz: -4000, noiseLevel: 0.5, seed: 5 }));
		expect(records.map((r) => r.text.split(' · ').slice(0, 2).join(' · '))).toEqual([
			'GWF gas 61000042 · C1 (A)',
			'SEN cold water 72004711 · C1 (B)',
		]);
		expect(records[0].text).toBe('GWF gas 61000042 · C1 (A) · Volume 234568.3 m3; Date 2025-10-01');
		expect(field(records[1], 'Mode')).toBe('C1 (B), frame format B');
		expect(field(records[1], 'Readings').split('; ')).toHaveLength(29);
	});
	it('decodes an S1 water meter (Manchester)', () => {
		const [record] = decode(wmbusSignal([meterBurst(0)], { offsetHz: 2500, noiseLevel: 0.5, seed: 9 }));
		expect(record.text).toBe('KAM water 12345678 · S1 · Volume 123.471 m3; Volume 120.000 m3; Date 2025-10-01; Volume flow 0.045 m3/h');
	});
	it('flags a telegram whose CRC fails', () => {
		const { phy, air } = meterFrame(1, 5);
		air[20] ^= 0x04;
		const records = decode(wmbusSignal([{ phy, chips: encodeChips(phy, air) }], { noiseLevel: 0.3 }));
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ damaged: true, text: 'ELV 40112233 · T1 · CRC failed' });
		expect(field(records[0], 'CRC')).toBe('failed');
	});
	it('decodes most T1 and C1 telegrams at about 10 dB SNR in 250 kHz and invents none', () => {
		// uniform noise of amplitude 1 on a unit carrier: 0.104 of the power in 250 kHz of the 400 kHz channel
		const sent = [1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3].map((meter, k) => meterBurst(meter, 10 + k));
		const records = decode(wmbusSignal(sent, { offsetHz: 5000, noiseLevel: 1, seed: 21 }));
		const good = records.filter((r) => !r.damaged);
		expect(good.length).toBeGreaterThanOrEqual(13);
		for (const r of good) expect(r.text).toMatch(/^(ELV heat \(outlet\) 40112233 · T1|GWF gas 61000042 · C1 \(A\)) · /);
		expect(new Set(good.map((r) => field(r, 'Access number'))).size).toBe(good.length);
	});
	it('stays quiet on noise', () => {
		const iq = new Float32Array(WMBUS_RATE * 2);
		const silent = wmbusSignal([], { gap: 1, noiseLevel: 1, seed: 11 });
		iq.set(silent.subarray(0, iq.length));
		expect(decode(iq)).toHaveLength(0);
	});
});
