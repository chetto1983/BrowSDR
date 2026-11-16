import { describe, expect, it } from 'vitest';
import { LoraAprsDecoder, LORA_APRS_MODE, LORA_APRS_RATE, loraAprsReport } from '@/worker/decoders/digimode/lora-aprs';
import { splitLoraAprs } from '@/worker/decoders/digimode/lora-aprs/proto';
import { loraAprsFrame } from './builders';
import { decodeFrames } from './phy';
import { APRS_EVENTS, MeshScene, loraAprsEu, schedule } from './scene';

const field = (record, label) => record.fields.find(([name]) => name === label)?.[1];

describe('LoRa APRS frames', () => {
	it('splits the TNC2 packet and checks the calls (OnAir mesh_proto_aprs cases)', () => {
		expect(splitLoraAprs(loraAprsFrame('A61AB-7>APLRT1,WIDE1-1:!2504.83N/05508.42E>Marina\r\n'))).toEqual({
			src: 'A61AB-7',
			dest: 'APLRT1',
			path: 'WIDE1-1',
			info: '!2504.83N/05508.42E>Marina',
		});
		expect(splitLoraAprs(Uint8Array.from([0x3c, 0xfe, 0x01, 0x41]))).toBe('no LoRa APRS prefix');
		expect(splitLoraAprs(loraAprsFrame('A61AB-7 APLRT1:hello'))).toBe('not a TNC2 packet');
		expect(splitLoraAprs(loraAprsFrame('A61 AB>APLRT1:hello'))).toBe('bad call in the TNC2 header');
		expect(splitLoraAprs(loraAprsFrame('A61AB>APLRT1,WIDE#:hello'))).toBe('bad path in the TNC2 header');
		const r = loraAprsReport(loraAprsFrame('A61AB-7>APLRT1,WIDE1-1::A61EF-9  :Meet at the Marina at 9{01'));
		expect(r.text).toBe('A61AB-7 → APLRT1 via WIDE1-1 · Message · To A61EF-9: Meet at the Marina at 9 (#01)');
		expect(LORA_APRS_MODE.sfs).toEqual([9, 12]);
	});

	it('never throws on garbage', () => {
		let x = 9;
		const next = () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0) >>> 24;
		for (let k = 0; k < 3000; k++) {
			const b = Uint8Array.from({ length: 1 + (k % 90) }, next);
			b.set([0x3c, 0xff, 0x01].slice(0, b.length));
			expect(typeof loraAprsReport(b).text).toBe('string');
		}
	});
});

describe('LoRa APRS receiver', () => {
	it("decodes OnAir's 70 cm stations on SF12 and a PL station on SF9 4/7", () => {
		const scene = new MeshScene(6);
		const events = [...APRS_EVENTS.slice(0, 6), { ...APRS_EVENTS[6], pl: true }];
		const frames = schedule(events, {
			p: (e) => (e.pl ? loraAprsEu(9, 7) : loraAprsEu(12, 5)),
			bytes: (e) => loraAprsFrame(e.tnc2),
			radio: (e) => scene.radio(`ap${e.station}`, 0 - (12 * e.station) / 2),
			cfoHz: -2200,
			sroPpm: 5,
			scene,
		});
		const { records, ms, seconds } = decodeFrames(LoraAprsDecoder, frames, { rate: LORA_APRS_RATE, bwHz: 125000 });
		console.log(`LoRa APRS: ${seconds.toFixed(1)} s of signal in ${ms.toFixed(0)} ms`);
		for (const r of records) console.log(r.text);
		expect(records.map((r) => [field(r, 'Spreading factor'), r.damaged])).toEqual(frames.map((f) => [`SF${f.p.sf}`, false]));
		expect(records[0].text).toBe('A61AB-7 → APLRT1 via WIDE1-1 · Position · 25.08050°N 55.14033°E · Marina tracker 12.6V');
		expect(records[2].text).toContain('A61EF-9 → APLRT1 via A61CD-10*,WIDE1* · Weather');
		expect(records[4].text).toContain('Object DXBMTG');
		expect(records[5].text).toBe('A61EF-9 → APLRT1 · Status · On the road to Abu Dhabi, 35°C');
		expect(records[6].text).toContain('Telemetry · Sequence 005: 199, 0, 255, 73, 123 · bits 01101001');
		expect(field(records[6], 'Coding rate')).toBe('4/7');
	}, 120_000);
	it('finds nothing in noise alone', () => {
		const { records } = decodeFrames(LoraAprsDecoder, [], { rate: LORA_APRS_RATE, bwHz: 125000, durationSec: 6 });
		expect(records).toHaveLength(0);
	});
});
