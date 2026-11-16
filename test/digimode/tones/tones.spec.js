import { describe, expect, it } from 'vitest';
import { ToneScene, toneSceneFm } from './fixtures';
import { TONES_RATE, TonesDecoder } from '@/worker/decoders/digimode/tones';
import { CTCSS_HZ, ctcssIndex, DCS_STANDARD_CODES, dcsDecode, dcsWord, dtmfKind, SEQ_POOL } from '@/worker/decoders/digimode/tones/proto';

const MASK = 0x7fffff;
const rotl = (w, r) => (r === 0 ? w : ((w << r) | (w >>> (23 - r))) & MASK);

/** The scene FM-modulated (5 kHz deviation at 1.0) `offsetHz` off tune, with noise for `snrDb` in 25 kHz, through the decoder. */
function receive(scene, { offsetHz, snrDb = 12, seed = 3, carrier } = {}) {
	const iq = toneSceneFm(scene, TONES_RATE, offsetHz, snrDb, { seed, carrier });
	const records = [];
	const statuses = [];
	const decoder = new TonesDecoder({ record: (r) => records.push(r), status: (message, locked) => statuses.push({ message, locked }) });
	for (let i = 0; i < iq.length; i += 3200) decoder.process(iq.subarray(i, Math.min(iq.length, i + 3200)));
	return { records, statuses };
}

const field = (record, label) => record.fields.find(([name]) => name === label)?.[1];
const seconds = (record) => parseFloat(field(record, 'Duration'));

describe('tone signalling tables', () => {
	it('reads every standard DCS code back wherever the word starts, and an inverted one as its partner', () => {
		for (const code of DCS_STANDARD_CODES)
			for (let r = 0; r < 23; r++) expect(dcsDecode(rotl(dcsWord(code), r))).toMatchObject({ code, inverted: false, standard: true });
		expect(dcsDecode(~dcsWord(23) & MASK)).toMatchObject({ code: 47, inverted: false, aliasCode: 23, aliasInverted: true });
		expect(dcsDecode(~dcsWord(112) & MASK)).toMatchObject({ code: 112, inverted: true, standard: false, aliasCode: -1 });
		expect(dcsDecode(dcsWord(23) ^ 1)).toBeNull();
	});
	it('gives a waveform with two readings of the same rank one reading', () => {
		// 112 and 250 are rotations of each other; the reading must not depend on where the window starts.
		const codes = new Set(Array.from({ length: 23 }, (_, r) => dcsDecode(rotl(dcsWord(250), r)).code));
		expect([...codes]).toEqual([112]);
	});
	it('finds CTCSS tones within 1.2 Hz and pools the sequential tones', () => {
		expect(CTCSS_HZ).toHaveLength(50);
		expect(CTCSS_HZ[ctcssIndex(88.1)]).toBe(88.5);
		expect(ctcssIndex(90.2)).toBe(-1);
		expect(SEQ_POOL.every((hz, i) => i === 0 || hz > SEQ_POOL[i - 1])).toBe(true);
		expect(SEQ_POOL).toContain(2600);
		expect(SEQ_POOL).toContain(459);
	});
	it('names DTMF key groups', () => {
		expect(['*21#', '*21', '0037061234567', '123'].map(dtmfKind)).toEqual(['code', 'star', 'number', 'short']);
	});
});

describe('tone signalling decoder (FM)', () => {
	it('reports a CTCSS tone under speech once, when it ends', () => {
		const scene = new ToneScene(TONES_RATE, 1);
		scene.ctcss(88.5, 0.5, 6, 0.1);
		scene.speech(1.5, 3, 0.4);
		scene.pad(12);
		const { records, statuses } = receive(scene, { offsetHz: 400 });
		expect(records.map((r) => r.text)).toEqual(['CTCSS 88.5 Hz']);
		const [record] = records;
		expect(field(record, 'Value')).toBe('88.5 Hz');
		expect(field(record, 'Detail')).toBe('standard tone');
		expect(Math.abs(parseFloat(field(record, 'Measured')) - 88.5)).toBeLessThanOrEqual(0.25);
		expect(Math.abs(parseFloat(field(record, 'Level')) + 20)).toBeLessThan(1.5); // 500 Hz of 5 kHz deviation
		expect(seconds(record)).toBeGreaterThan(4.5);
		expect(seconds(record)).toBeLessThan(6.5);
		expect(statuses[0]).toEqual({ message: 'CTCSS 88.5 Hz', locked: true });
	});
	it('keeps one record for an extended CTCSS tone through a fade', () => {
		const scene = new ToneScene(TONES_RATE, 2);
		scene.ctcss(254.1, 0.5, 7, 0.1);
		scene.pad(13);
		const { records, statuses } = receive(scene, { offsetHz: -300, snrDb: 10, carrier: (t) => t < 3 || t > 4 });
		expect(statuses.filter((s) => s.locked)).toHaveLength(2);
		expect(records.map((r) => r.text)).toEqual(['CTCSS 254.1 Hz']);
		expect(field(records[0], 'Detail')).toBe('extended tone');
		expect(seconds(records[0])).toBeGreaterThan(5);
	});
	it('reads DCS codes of both polarities', () => {
		const scene = new ToneScene(TONES_RATE, 3);
		scene.dcs(23, false, 0.5, 4, 0.15);
		scene.dcs(23, true, 7.5, 4, 0.15, 11);
		scene.speech(8.5, 2, 0.4);
		scene.dcs(112, true, 14.5, 4, 0.15, 5);
		scene.pad(26);
		const { records } = receive(scene, { offsetHz: 300 });
		expect(records.map((r) => r.text)).toEqual(['DCS 023 (or 047 inverted)', 'DCS 047 (or 023 inverted)', 'DCS 112 (inverted)']);
		expect(records.map((r) => field(r, 'Value'))).toEqual(['D023N', 'D047N', 'D112I']);
		expect(field(records[0], 'Detail')).toBe('standard code; the same waveform reads as D047I');
		expect(field(records[2], 'Detail')).toBe('not in the usual list of 83 codes');
		for (const record of records) expect(seconds(record)).toBeGreaterThan(2.5);
	});
	it('collects DTMF keys into one record per group', () => {
		const scene = new ToneScene(TONES_RATE, 4);
		scene.dtmf('1234#', 0.5, 0.1, 0.08, 0.5);
		scene.dtmf('*72', 5, 0.08, 0.06, 0.4);
		scene.dtmf('0037061234567', 9, 0.06, 0.05, 0.5);
		scene.pad(15);
		const { records, statuses } = receive(scene, { offsetHz: -450 });
		expect(records.map((r) => r.text)).toEqual(['DTMF 1234#', 'DTMF *72', 'DTMF 0037061234567']);
		expect(records.map((r) => field(r, 'Kind'))).toEqual([
			'code (ends in #)',
			'feature or access code (starts with *)',
			'number (7 digits or more)',
		]);
		expect(field(records[0], 'First key')).toBe('697 + 1209 Hz');
		expect(seconds(records[0])).toBeCloseTo(0.8, 0);
		expect(statuses.map((s) => s.message)).toContain('DTMF 123');
	});
	it('decodes five-tone calls of every plan and lists a repeated call once', () => {
		const scene = new ToneScene(TONES_RATE, 5);
		scene.sequential('zvei1', '12345', 0.5, 70, 0.5);
		scene.sequential('zvei1', '12345', 1.2, 70, 0.5);
		scene.sequential('ccir', '55123', 3, 100, 0.5);
		scene.sequential('eea', '20409', 5, 40, 0.5);
		scene.sequential('zvei2', '11234', 7, 70, 0.5);
		scene.sequential('eia', '12345', 9, 33, 0.5);
		scene.sequential('dzvei', '12345', 11, 70, 0.5);
		scene.pad(13);
		const { records } = receive(scene, { offsetHz: 350 });
		expect(records.map((r) => r.text)).toEqual(['ZVEI1 12345', 'CCIR 55123', 'EEA 20409', 'ZVEI2 11234', 'EIA 12345', 'DZVEI 12345']);
		expect(field(records[1], 'Detail')).toBe('CCIR, 5 tones of about 104 ms, sent as 5E123; the tones also fit EEA');
		expect(field(records[2], 'Detail')).toMatch(/^EEA, 5 tones of about 40 ms/);
		expect(records.map((r) => field(r, 'Value'))).toEqual(['12345', '55123', '20409', '11234', '12345', '12345']);
	});
	it('decodes SELCAL and a two-tone page', () => {
		const scene = new ToneScene(TONES_RATE, 6);
		scene.selcal('AMCP', 0.5, 0.5);
		scene.twoTone(682.5, 1000, 4, 1, 3, 0.5);
		scene.pad(10);
		const { records } = receive(scene, { offsetHz: 200 });
		expect(records.map((r) => r.text)).toEqual(['SELCAL AM-CP', 'Two-tone 682.2 + 1000.0 Hz']);
		expect(field(records[0], 'Detail')).toBe('312.6 / 977.2 / 384.6 / 1083.9 Hz');
		expect(field(records[1], 'Detail')).toBe('tone A 1.0 s, tone B 3.0 s');
	});
	it('stays quiet on noise without a carrier and on speech', () => {
		const silent = new ToneScene(TONES_RATE, 7);
		silent.pad(20);
		const noise = receive(silent, { offsetHz: 0, carrier: () => false });
		expect(noise.records).toHaveLength(0);
		expect(noise.statuses.some((s) => s.locked)).toBe(false);
		const talk = new ToneScene(TONES_RATE, 8);
		talk.speech(0.5, 12, 0.4);
		talk.noise(13, 5, 0.1);
		talk.pad(20);
		const speech = receive(talk, { offsetHz: 250, snrDb: 8 });
		expect(speech.records).toHaveLength(0);
		expect(speech.statuses.some((s) => s.locked)).toBe(false);
	});
});
