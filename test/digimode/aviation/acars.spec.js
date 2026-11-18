// Multi-block ACARS on VDL2 and HFDL: the decoders send each good block with its record, the app reassembles the
// messages and interprets them with the ACARS library (its decoder session). The CPDLC message is libacars' real one
// (Tomasz Lemiech, MIT), as test/digimode/cpdlc.spec.js uses it; the other texts are made up.

import { describe, expect, it } from 'vitest';
import { readAviation, resetAviation } from '@/app/decoders/digimode/aviation';
import { validDigimodeMessage } from '@/worker/decoders/digimode/validation';
import { VDL2_RATE, Vdl2Decoder } from '@/worker/decoders/digimode/vdl2';
import { avlcFrame, controlI } from '@/worker/decoders/digimode/vdl2/avlc';
import { HfdlDecoder } from '@/worker/decoders/digimode/hfdl';
import { burstSeconds, payloadOctets } from '@/worker/decoders/digimode/hfdl/phy';
import { acarsBuildFrame, vdl2AcarsInfo, vdl2Signal } from '../vdl2-fixtures';
import { mpduDown, play, unnumbered } from '../hfdl/fixtures';

const POSITION_REPORT = '/SOUCAYA.AT1.HL8251243F880C3D903BB412903604FE326C2479F4A64F7F62528B1A9CF8382738186AC28B16668E013DF464D8A7F0';
const GS = { addr: 0x10a000, type: 4, status: false };
const AIR = { addr: 0x71be19, type: 1, status: false };
const AIR2 = { addr: 0x4ca1f4, type: 1, status: false };
const T0 = Date.UTC(2026, 10, 18, 12, 0);
const field = (r, label) => r.fields?.find(([name]) => name === label)?.[1];

/** A downlink block as AVLC information: message number and flight, then the text. */
const block = (reg, blockId, number, text, last, label = 'H1') =>
	vdl2AcarsInfo(reg, label, blockId, `${number}${reg === 'HL8251' ? 'KE0907' : 'EI0105'}${text}`, { lastBlock: last });

/** VDL2 frames of one aircraft -> the decoder's records (one burst each). */
function vdl2Records(frames) {
	const iq = vdl2Signal(
		frames.map((frame) => ({ frames: [frame] })),
		{ rate: VDL2_RATE, snrDb: 25 },
	);
	const records = [];
	const decoder = new Vdl2Decoder({ record: (r) => records.push(r), status: () => {} });
	for (let i = 0; i < iq.length; i += 8192) decoder.process(iq.subarray(i, i + 8192));
	return records;
}

/** The app's side: one VFO's records in order, as the controller reads them. */
function app(mode = 'vdl2', freq = 136.975) {
	const receiver = {};
	let id = 0;
	return (records) => records.map((r) => readAviation(receiver, 0, mode, freq, { ...r, id: ++id, time: T0 + id * 3000, mode }));
}

const down = (air, info, ns) => avlcFrame(GS, air, controlI(ns, 0, false), info);

describe('ACARS blocks in the VDL2 records', () => {
	it('carry the block envelope, with the aircraft address', () => {
		const [r] = vdl2Records([down(AIR, block('HL8251', '3', 'M01A', 'FIRST PART ', false), 0)]);
		expect(r.application).toEqual({
			kind: 'acars',
			aircraft: '71BE19',
			block: {
				label: 'H1',
				text: 'FIRST PART ',
				direction: 'downlink',
				registration: 'HL8251',
				mode: '2',
				acknowledgement: 'NAK',
				blockId: '3',
				messageNumber: 'M01A',
				flight: 'KE0907',
				continuation: true,
			},
		});
	});
	it('are left out when the block check fails', () => {
		const info = block('HL8251', '3', 'M01A', 'FIRST PART', true);
		info[info.length - 3] ^= 0x01; // a check byte: the AVLC frame is good, the ACARS block is not
		const [r] = vdl2Records([down(AIR, info, 0)]);
		expect(r.damaged).toBe(true);
		expect(r.application).toBeUndefined();
	});
});

describe('multi-block ACARS over VDL2', () => {
	it('reassembles a message of three blocks on the last one', () => {
		const frames = [
			down(AIR, block('HL8251', '3', 'M01A', 'FIRST BLOCK OF A LONG TEXT, ', false), 0),
			down(AIR, block('HL8251', '4', 'M01B', 'THE SECOND ONE, ', false), 1),
			down(AIR, block('HL8251', '5', 'M01C', 'AND THE LAST.', true), 2),
		];
		const out = app()(vdl2Records(frames));
		expect(out).toHaveLength(3);
		expect(out[0].text).toContain('part 1 of a message, waiting for more blocks');
		expect(out[1].text).toContain('part 2 of a message, waiting for more blocks');
		expect(field(out[1], 'ACARS reassembly')).toBe('part 2 of a message (blocks M01A, M01B so far), waiting for more blocks');
		expect(out[2].text).toContain('message of 3 blocks');
		expect(field(out[2], 'ACARS reassembly')).toMatch(/^the last of 3 blocks \(M01A, M01B, M01C\)/);
		expect(field(out[2], 'Assembled text')).toBe('FIRST BLOCK OF A LONG TEXT, THE SECOND ONE, AND THE LAST.');
		expect(field(out[2], 'ACARS notes')).toContain('Reassembled 3 consecutive blocks');
		for (const r of out) expect(field(r, 'ACARS message')).toBeTruthy();
	});
	it('never fills a missing middle block', () => {
		const read = app();
		const [first, last] = read(
			vdl2Records([down(AIR, block('HL8251', '3', 'M02A', 'ONE ', false), 0), down(AIR, block('HL8251', '5', 'M02C', 'THREE', true), 2)]),
		);
		expect(first.text).toContain('waiting for more blocks');
		expect(last.text).toContain('not reassembled');
		expect(field(last, 'ACARS reassembly')).toBe('not reassembled: Expected message block M02B; received M02C.');
		expect(field(last, 'Assembled text')).toBeUndefined();
		// the middle block arriving late completes nothing
		const [late] = read(vdl2Records([down(AIR, block('HL8251', '4', 'M02B', 'TWO ', false), 1)]));
		expect(field(late, 'Assembled text')).toBeUndefined();
		expect(late.text).not.toContain('message of');
	});
	it('keeps the blocks of two aircraft apart', () => {
		const out = app()(
			vdl2Records([
				down(AIR, block('HL8251', '3', 'M01A', 'KOREAN ', false), 0),
				down(AIR2, block('EI-DUO', '7', 'M01A', 'IRISH ', false), 0),
				down(AIR, block('HL8251', '4', 'M01B', 'AIR', true), 1),
				down(AIR2, block('EI-DUO', '8', 'M01B', 'SEA', true), 1),
			]),
		);
		expect(out.map((r) => field(r, 'Assembled text'))).toEqual([undefined, undefined, 'KOREAN AIR', 'IRISH SEA']);
	});
	it('decodes a FANS-1/A CPDLC message split over two blocks once it is complete', () => {
		const out = app()(
			vdl2Records([
				down(AIR, block('HL8251', '3', 'M01A', POSITION_REPORT.slice(0, 50), false, 'AA'), 0),
				down(AIR, block('HL8251', '4', 'M01B', POSITION_REPORT.slice(50), true, 'AA'), 1),
			]),
		);
		expect(out[0].text).not.toContain('POSITION REPORT');
		expect(out[1].text).toMatch(/message of 2 blocks: POSITION REPORT Position 52\.123333°, 3\.641667°/);
		expect(field(out[1], 'ACARS message')).toBe('CPDLC message (decoded)');
		expect(field(out[1], 'CPDLC time')).toBe('15:56:32 UTC');
		expect(field(out[1], 'Application CRC')).toBe('A7F0 · Verified');
	});
	it('reads a single block on its own', () => {
		const [r] = app()(vdl2Records([down(AIR, block('HL8251', '3', 'M01A', POSITION_REPORT, true, 'AA'), 0)]));
		expect(r.text).toMatch(/: POSITION REPORT /);
		expect(field(r, 'ACARS reassembly')).toBeUndefined();
	});
	it('starts again when the VFO changes frequency or decoder', () => {
		const receiver = {};
		const [a, b] = vdl2Records([
			down(AIR, block('HL8251', '3', 'M03A', 'ONE ', false), 0),
			down(AIR, block('HL8251', '4', 'M03B', 'TWO', true), 1),
		]);
		const at = (r, t) => ({ ...r, id: t, time: T0 + t * 1000, mode: 'vdl2' });
		readAviation(receiver, 0, 'vdl2', 136.975, at(a, 1));
		expect(field(readAviation(receiver, 0, 'vdl2', 136.875, at(b, 2)), 'Assembled text')).toBeUndefined();
		readAviation(receiver, 0, 'vdl2', 136.975, at(a, 3));
		resetAviation(receiver, 0);
		expect(field(readAviation(receiver, 0, 'vdl2', 136.975, at(b, 4)), 'Assembled text')).toBeUndefined();
		readAviation(receiver, 0, 'vdl2', 136.975, at(a, 5));
		expect(field(readAviation(receiver, 0, 'vdl2', 136.975, at(b, 6)), 'Assembled text')).toBe('ONE TWO');
	});
});

describe('multi-block ACARS over HFDL', () => {
	/** ACARS blocks of one aircraft, a burst each, through the HFDL decoder. */
	function hfdlRecords(blocks) {
		let t = 0.3;
		const tx = blocks.map(({ reg, blockId, text, last }) => {
			const info = [0xff, 0xff, ...acarsBuildFrame({ reg, label: 'H1', blockId, text, lastBlock: last }).slice(2)];
			const pdu = mpduDown(7, 45, [unnumbered(info)]);
			const m1 = [0, 1, 2, 3, 4, 5, 6, 7].find((m) => payloadOctets(m) >= pdu.length);
			const burst = { m1, pdu, t };
			t += burstSeconds(m1) + 0.5;
			return burst;
		});
		const records = [];
		const decoder = new HfdlDecoder({ record: (r) => records.push(r), status: () => {} }, Infinity);
		play(tx, { snrDb: 30, secs: t + 1, chunk: 4096, each: (b) => decoder.process(b) });
		decoder.flush();
		return records.filter((r) => r.application);
	}

	it('reassembles three blocks and keeps a message with a gap unassembled', () => {
		const records = hfdlRecords([
			{ reg: 'N123UA', blockId: '2', text: 'M01AUA0901POSITION AT ', last: false },
			{ reg: 'N123UA', blockId: '3', text: 'M01BUA0901FL350 AND THEN ', last: false },
			{ reg: 'N123UA', blockId: '4', text: 'M01CUA0901DESCENDING', last: true },
			{ reg: 'N123UA', blockId: '5', text: 'M02AUA0901GAP ', last: false },
			{ reg: 'N123UA', blockId: '7', text: 'M02CUA0901AFTER', last: true },
		]);
		expect(records).toHaveLength(5);
		expect(records[0].application).toMatchObject({ kind: 'acars', block: { registration: 'N123UA', messageNumber: 'M01A' } });
		expect(records[0].application.aircraft).toBeUndefined();
		const out = app('hfdl', 8.942)(records);
		expect(out[1].text).toContain('part 2 of a message, waiting for more blocks');
		expect(field(out[2], 'Assembled text')).toBe('POSITION AT FL350 AND THEN DESCENDING');
		expect(field(out[4], 'Assembled text')).toBeUndefined();
		expect(field(out[4], 'ACARS reassembly')).toBe('not reassembled: Expected message block M02B; received M02C.');
	});
});

describe('the ACARS block check', () => {
	const message = (application) => ({
		type: 'digimode',
		mode: 'vdl2',
		freq: 136.975,
		status: { state: 'receiving', message: '', records: 1, locked: true },
		records: [{ id: 1, time: T0, mode: 'vdl2', text: 'ACARS', application }],
	});
	const good = {
		kind: 'acars',
		aircraft: '71BE19',
		block: {
			label: 'H1',
			text: 'FIRST PART',
			direction: 'downlink',
			registration: 'HL8251',
			mode: '2',
			acknowledgement: 'NAK',
			blockId: '3',
			messageNumber: 'M01A',
			flight: 'KE0907',
			continuation: true,
		},
	};
	it('passes a good block, with or without the optional parts', () => {
		expect(validDigimodeMessage(message(good))).toBe(true);
		const { messageNumber: _n, flight: _f, ...uplink } = { ...good.block, direction: 'uplink', blockId: 'A' };
		expect(validDigimodeMessage(message({ kind: 'acars', block: uplink }))).toBe(true);
	});
	it('refuses malformed blocks', () => {
		const bad = (change) => ({ ...good, block: { ...good.block, ...change } });
		for (const application of [
			{ ...good, aircraft: '71be19' },
			{ ...good, aircraft: '71BE1' },
			{ kind: 'acars', aircraft: '71BE19' },
			bad({ label: 'H' }),
			bad({ text: 'X'.repeat(241) }),
			bad({ direction: 'sideways' }),
			bad({ registration: 'TOOLONG1' }),
			bad({ mode: '22' }),
			bad({ blockId: 12 }),
			bad({ acknowledgement: 'NAKS' }),
			bad({ messageNumber: 'M01AB' }),
			bad({ flight: 'KE09070' }),
			bad({ continuation: 'yes' }),
			{ ...good, kind: 'acarsx' },
		])
			expect(validDigimodeMessage(message(application))).toBe(false);
	});
});
