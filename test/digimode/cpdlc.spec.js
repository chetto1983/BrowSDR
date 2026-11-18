// FANS-1/A CPDLC bodies carried by Aero, HFDL and VDL2 ACARS messages and decoded in the app with the ACARS library
// (Aero sends the CPDLC body; VDL2 and HFDL send the ACARS block, which the app interprets as a whole).
// The CPDLC messages are libacars' real ones (Tomasz Lemiech, MIT), as OnAir's tests/aero/test_aero_cpdlc.cpp and
// tests/hfdl/test_hfdl_fans.cpp use them.

import { describe, expect, it } from 'vitest';
import { readApplication } from '@/app/decoders/digimode/application';
import { readAviation } from '@/app/decoders/digimode/aviation';
import { cpdlcApplication } from '@/worker/decoders/digimode/aero/arinc';
import { validDigimodeMessage } from '@/worker/decoders/digimode/validation';
import { VDL2_RATE, Vdl2Decoder } from '@/worker/decoders/digimode/vdl2';
import { avlcFrame, controlI } from '@/worker/decoders/digimode/vdl2/avlc';
import { HfdlDecoder } from '@/worker/decoders/digimode/hfdl';
import { burstSeconds } from '@/worker/decoders/digimode/hfdl/phy';
import { vdl2AcarsInfo, vdl2Signal } from './vdl2-fixtures';
import { acarsHfnpdu, mpduDown, play, unnumbered } from './hfdl/fixtures';

/** A position report sent down by HL8251 to Incheon (SOUCAYA), body and CRC as hex. */
const POSITION_REPORT = '/SOUCAYA.AT1.HL8251243F880C3D903BB412903604FE326C2479F4A64F7F62528B1A9CF8382738186AC28B16668E013DF464D8A7F0';
const BODY = POSITION_REPORT.slice('/SOUCAYA.AT1.HL8251'.length, -4);
const record = (application, fields = [['Label', 'H1']]) => ({
	id: 1,
	time: 0,
	mode: 'aero',
	text: 'Downlink from HL8251 · CPDLC AT1',
	fields,
	application,
});
const field = (r, label) => r.fields?.find(([name]) => name === label)?.[1];

describe('CPDLC body of an ACARS text', () => {
	it('is taken with its direction when its ARINC 622 CRC is good', () => {
		expect(cpdlcApplication(POSITION_REPORT, false)).toEqual({ kind: 'cpdlc', uplink: false, hex: BODY });
		expect(cpdlcApplication(`M01AKE0907${POSITION_REPORT}`, false)?.hex).toBe(BODY);
	});
	it('is left out when the CRC fails or there is no application', () => {
		expect(cpdlcApplication(`${POSITION_REPORT.slice(0, -1)}1`, false)).toBeUndefined();
		expect(cpdlcApplication('#DFB/FUEL 145/ETA 1230', false)).toBeUndefined();
	});
	it('passes the message check, and a malformed one does not', () => {
		const message = (application) => ({
			type: 'digimode',
			mode: 'aero',
			freq: 1545.1225,
			status: { state: 'receiving', message: '', records: 1, locked: true },
			records: [record(application)],
		});
		expect(validDigimodeMessage(message({ kind: 'cpdlc', uplink: false, hex: BODY }))).toBe(true);
		for (const bad of [
			{ kind: 'adsc', uplink: false, hex: BODY },
			{ kind: 'cpdlc', uplink: 'no', hex: BODY },
			{ kind: 'cpdlc', uplink: false, hex: `${BODY}0` },
			{ kind: 'cpdlc', uplink: false, hex: BODY.toLowerCase() },
			{ kind: 'cpdlc', uplink: false, hex: 'AB'.repeat(2001) },
		])
			expect(validDigimodeMessage(message(bad))).toBe(false);
	});
});

describe('CPDLC decoding in the app', () => {
	it('reads the message elements into the fields and the summary into the text', () => {
		const r = readApplication(record({ kind: 'cpdlc', uplink: false, hex: BODY }));
		expect(r.text).toMatch(/^Downlink from HL8251 · CPDLC AT1: POSITION REPORT/);
		expect(field(r, 'Label')).toBe('H1');
		expect(field(r, 'CPDLC message')).toMatch(/^POSITION REPORT Position 52\.123333°, 3\.641667° .*FL340/);
		expect(field(r, 'CPDLC message')).not.toContain('partly decoded');
		expect(field(r, 'CPDLC time')).toBe('15:56:32 UTC');
		expect(field(r, 'CPDLC notes')).toBeUndefined();
	});
	it('says so when the body only partly decodes (here: read in the wrong direction)', () => {
		const r = readApplication(record({ kind: 'cpdlc', uplink: true, hex: BODY }));
		expect(field(r, 'CPDLC message')).toContain('(partly decoded)');
		expect(field(r, 'CPDLC notes')).toBeTruthy();
	});
	it('leaves a record without an application as it is', () => {
		const plain = record(undefined);
		expect(readApplication(plain)).toBe(plain);
	});
});

/** The app's reading of a VDL2 or HFDL record that carries an ACARS block. */
const inApp = (r, mode) => readAviation({}, 0, mode, 1, { ...r, id: 1, time: Date.UTC(2026, 10, 18), mode });

describe('CPDLC in the decoders’ records', () => {
	it('VDL2: an ACARS downlink carries its block, whose CPDLC message the app decodes', () => {
		const GS = { addr: 0x10a000, type: 4, status: false };
		const AIR = { addr: 0x71be19, type: 1, status: false };
		const frame = avlcFrame(GS, AIR, controlI(2, 1, false), vdl2AcarsInfo('HL8251', 'AA', '3', `M01AKE0907${POSITION_REPORT}`));
		const iq = vdl2Signal([{ frames: [frame] }], { rate: VDL2_RATE, snrDb: 25 });
		const records = [];
		const decoder = new Vdl2Decoder({ record: (r) => records.push(r), status: () => {} });
		for (let i = 0; i < iq.length; i += 8192) decoder.process(iq.subarray(i, i + 8192));
		expect(records).toHaveLength(1);
		expect(records[0].application).toMatchObject({ kind: 'acars', aircraft: '71BE19', block: { label: 'AA', text: POSITION_REPORT } });
		const r = inApp(records[0], 'vdl2');
		expect(r.text).toContain(': POSITION REPORT Position 52.123333°, 3.641667°');
		expect(field(r, 'CPDLC time')).toBe('15:56:32 UTC');
	});
	it('HFDL: an ACARS downlink carries its block, whose CPDLC message the app decodes', () => {
		const records = [];
		const decoder = new HfdlDecoder({ record: (r) => records.push(r), status: () => {} }, Infinity);
		const pdu = mpduDown(7, 45, [unnumbered(acarsHfnpdu('HL8251', 'AA', '2', `M01AKE0907${POSITION_REPORT}`))]);
		play([{ m1: 2, pdu, t: 0.3 }], { snrDb: 30, secs: 0.3 + burstSeconds(2) + 1, chunk: 4096, each: (b) => decoder.process(b) });
		decoder.flush();
		const acars = records.filter((r) => r.application);
		expect(acars).toHaveLength(1);
		expect(acars[0].application).toMatchObject({ kind: 'acars', block: { registration: 'HL8251', text: POSITION_REPORT } });
		expect(inApp(acars[0], 'hfdl').text).toContain(': POSITION REPORT Position 52.123333°, 3.641667°');
	});
});
