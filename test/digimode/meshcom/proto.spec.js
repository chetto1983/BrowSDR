// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir tests/mesh/test_mesh_loraaprs.cpp (packetLayer, the MeshCom part:
// a relayed position with battery and altitude, a text to a call, the checksum, an ack, LoRa APRS and MeshCom told apart,
// random and truncated frames, the MeshCom EU preset) and rust/onair_mesh/src/tests.rs (lora_aprs_and_meshcom: the ack),
// https://github.com/adswill/OnAir; see third_party/onair. Protocol facts as credited there: MeshCom firmware
// (icssw-org/MeshCom-Firmware, MIT). Changes: through BrowSDR's record of the frame (the position parsed by BrowSDR's
// APRS decoder); added HEY, UTF-8 cleaning and the 125 kHz presets.

import { describe, expect, it } from 'vitest';
import { MESHCOM_125_MODE, MESHCOM_MODE, meshcomReport } from '@/worker/decoders/digimode/meshcom';
import { cleanText, meshcom } from '@/worker/decoders/digimode/meshcom/proto';
import { meshcomPresets } from '@/worker/decoders/digimode/lora/presets';
import { digimodeInfo } from '@/worker/decoders/digimode/catalog';
import { loraAprsReport } from '@/worker/decoders/digimode/lora-aprs';
import { loraAprsFrame } from '../lora/builders';
import { field, meshcomBuild } from './fixtures';

describe('MeshCom frames (OnAir packetLayer)', () => {
	it('reads a relayed position with battery and altitude', () => {
		const b = meshcomBuild({
			type: '!',
			msgId: 0x11223344,
			maxHop: 4,
			sourcePath: 'A61MC-2,A61MC-1',
			dest: '*',
			payload: '2506.00N/05512.00E[/B=064/A=000123',
		});
		const m = meshcom(b);
		expect(m).toMatchObject({ ok: true, typeName: 'POSITION', src: 'A61MC-2', aprsPath: 'A61MC-1', packetId: 0x11223344, hopLimit: 4 });
		expect(m.batteryPct).toBe(64);
		const r = meshcomReport(b);
		expect(r.text).toBe('A61MC-2 via A61MC-1 → all · POSITION · 25.10000°N 55.20000°E · 37 m · battery 64 %');
		expect([field(r, 'Position'), field(r, 'Symbol'), field(r, 'Altitude'), field(r, 'Battery')]).toEqual([
			'25.10000°N 55.20000°E',
			'/[',
			'37 m',
			'64 %',
		]);
		expect(field(r, 'Node info')).toBe('HW 4, MOD 3, country 0, FW 35, mesh');
		expect(field(r, 'Comment')).toBeUndefined();
	});
	it('reads a text to a call and refuses a wrong checksum', () => {
		const b = meshcomBuild({ type: ':', msgId: 7, sourcePath: 'A61MC-1', dest: 'A61MC-2', payload: 'QSL, 59 here' });
		const m = meshcom(b);
		expect(m).toMatchObject({ ok: true, typeName: 'TEXT', text: 'QSL, 59 here', destCall: 'A61MC-2', channel: 'MeshCom A61MC-2' });
		expect(meshcomReport(b).text).toBe('A61MC-1 → A61MC-2 · TEXT · QSL, 59 here');
		b[10] ^= 0x01;
		expect(meshcom(b)).toMatchObject({ ok: false, note: 'MeshCom: checksum wrong' });
	});
	it('reads an ack (OnAir and the Rust test)', () => {
		const a = meshcom(Uint8Array.from([0x41, 1, 2, 3, 4, 0x84, 0x44, 0x33, 0x22, 0x11, 0x01, 0x00]));
		expect(a).toMatchObject({ ok: true, typeName: 'ACK', detail: 'ack of 11223344', hopLimit: 4, packetId: 0x04030201 });
		const r = meshcom(Uint8Array.from([0x41, 1, 0, 0, 0, 0x83, 9, 0, 0, 0, 1, 0]));
		expect([r.ok, r.hopLimit, r.packetId, r.detail]).toEqual([true, 3, 1, 'ack of 00000009']);
		expect(meshcomReport(Uint8Array.from([0x41, 1, 0, 0, 0, 0x83, 9, 0, 0, 0, 1, 0])).text).toBe('ACK · ack of 00000009');
		expect(meshcom(Uint8Array.from([0x41, 1, 0, 0, 0, 0x83, 9, 0, 0, 0, 2, 0])).note).toBe('not a MeshCom ack');
	});
	it('reads a HEY beacon and cleans broken text', () => {
		const h = meshcomBuild({ type: '@', sourcePath: 'DL1ABC-1', payload: 'MeshCom 4.34 \xff', server: true, track: true });
		const m = meshcom(h);
		expect(m.detail).toBe('MeshCom 4.34 ÿ (HW 4, MOD 3, country 0, FW 35, server, track, mesh)');
		expect(meshcomReport(h).text).toBe('DL1ABC-1 → all · HEY · MeshCom 4.34 ÿ (HW 4, MOD 3, country 0, FW 35, server, track, mesh)');
		expect(cleanText(Uint8Array.from([0x33, 0x35, 0xc2, 0xb0, 0x43, 0x20, 0xff, 0x01, 0x20, 0x65]))).toBe('35°C ?? e');
	});
	it('tells LoRa APRS and MeshCom apart', () => {
		expect(meshcom(loraAprsFrame('A61AB-7>APLRT1:>x')).ok).toBe(false);
		const mc = meshcomBuild({ type: ':', sourcePath: 'A61MC-1', payload: 'hi' });
		expect(loraAprsReport(mc).ok).toBe(false);
		expect(meshcomReport(loraAprsFrame('A61AB-7>APLRT1:>x'))).toMatchObject({
			ok: false,
			text: 'Not a MeshCom packet: not a MeshCom packet · <\\xff\\x01A61AB-7>APLRT1:>x',
		});
	});
	it('almost never takes random bytes for a frame and never throws on cut ones', () => {
		let x = 5;
		const next = () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0) >>> 24;
		let accepted = 0;
		for (let i = 0; i < 20000; i++) {
			const v = Uint8Array.from({ length: next() }, next);
			if (i % 4 === 0 && v.length) v[0] = '!:@A'.charCodeAt(next() & 3);
			accepted += +meshcom(v).ok;
		}
		expect(accepted).toBeLessThanOrEqual(2);
		const b = meshcomBuild({ type: '!', sourcePath: 'A61MC-1', payload: '2505.10N/05510.20E#/B=085/A=000040' });
		for (let k = 0; k < b.length; k++) expect(typeof meshcomReport(b.subarray(0, k)).text).toBe('string');
	});
	it('has the presets of the firmware profiles', () => {
		const p = meshcomPresets();
		expect(p[0]).toMatchObject({ name: 'MeshCom EU', freqHz: 433.175e6, sf: 11, bwHz: 250000, cr: 6, syncWord: 0x2b, preamble: 32 });
		expect([MESHCOM_MODE.sfs, MESHCOM_125_MODE.sfs]).toEqual([[11], [10]]);
		const listed = [...digimodeInfo('meshcom').presets, ...digimodeInfo('meshcom-125').presets].map((x) => x.freqMHz * 1e6);
		expect(listed.sort()).toEqual(p.map((x) => x.freqHz).sort());
		for (const s of p)
			expect(digimodeInfo(s.bwHz === 250000 ? 'meshcom' : 'meshcom-125').presets.some((x) => x.freqMHz * 1e6 === s.freqHz)).toBe(true);
	});
});
