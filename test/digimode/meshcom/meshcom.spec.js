// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir tests/mesh/test_mesh_loraaprs.cpp (scene: every MeshCom packet of
// the 70 cm scene at -15 dB, +22 kHz and +100 ppm, the positions, battery and messages exact, no CRC error) and
// core/src/mesh/mesh_gen.cpp (the MeshCom nodes' SNRs: the strong one and the weak one; a crystal offset each),
// https://github.com/adswill/OnAir; see third_party/onair. Protocol facts as credited there: MeshCom firmware
// (icssw-org/MeshCom-Firmware, MIT). Changes: through BrowSDR's MeshComDecoder on its 250 kHz VFO channel (OnAir: the
// mesh receiver at 1.2 MS/s); frames back to back; added the 125 kHz profiles, noise alone, chunk sizes and the time.

import { describe, expect, it } from 'vitest';
import { MESHCOM_125_MODE, MESHCOM_125_RATE, MESHCOM_RATE, MeshComDecoder } from '@/worker/decoders/digimode/meshcom';
import { decodeFrames } from '../lora/phy';
import { MeshScene, schedule } from '../lora/scene';
import { field, MCOM_EVENTS, meshcomEvent, meshcomLora } from './fixtures';

const cpu = ({ ms, seconds }, what) =>
	console.log(`${what}: ${seconds.toFixed(1)} s of signal in ${ms.toFixed(0)} ms (${((ms / seconds) * 0.1).toFixed(1)} % of a core)`);

/** OnAir's 70 cm MeshCom nodes: node 0 at the scene's strong SNR, node 1 at the weak one. */
function sceneFrames({ strong = -15, weak = -15, cfoHz = 22000, sroPpm = 100, seed = 5, p = meshcomLora() } = {}) {
	const scene = new MeshScene(seed);
	let id = 0x5a000000;
	return schedule(MCOM_EVENTS, {
		p: () => p,
		bytes: (e) => meshcomEvent(e, (id += 0x10101) >>> 0),
		radio: (e) => scene.radio(`mcm${e.node}`, e.node ? weak : strong),
		cfoHz,
		sroPpm,
		scene,
	});
}

class MeshCom125 extends MeshComDecoder {
	constructor(sink) {
		super(sink, MESHCOM_125_MODE);
	}
}

describe('MeshCom receiver (OnAir 70 cm scene)', () => {
	it('decodes every MeshCom packet at -15 dB, +22 kHz and +100 ppm', () => {
		const frames = sceneFrames();
		const out = decodeFrames(MeshComDecoder, frames, { rate: MESHCOM_RATE, bwHz: 250000 });
		cpu(out, 'MeshCom 250 kHz');
		const { records } = out;
		for (const r of records) console.log(r.text);
		expect(records.map((r) => [r.text, r.damaged])).toEqual([
			['A61MC-1 → all · POSITION · 25.08500°N 55.17000°E · 12 m · battery 85 %', false],
			['A61MC-1 → all · TEXT · Hello MeshCom from the Marina', false],
			['A61MC-2 via A61MC-1 → all · POSITION · 25.10000°N 55.20000°E · battery 64 %', false],
			['A61MC-2 → A61MC-1 · TEXT · QSL, 59 here', false],
			['A61MC-2 → 262 · TEXT · Group 262 check-in', false],
		]);
		expect(records.map((r) => field(r, 'Channel'))).toEqual([undefined, 'MeshCom all', undefined, 'MeshCom A61MC-1', 'MeshCom 262']);
		expect([field(records[2], 'Hop limit'), field(records[0], 'Hop limit'), field(records[2], 'Relays')]).toEqual(['4', '5', 'A61MC-1']);
		expect([field(records[0], 'Spreading factor'), field(records[0], 'Coding rate'), field(records[0], 'Sync word')]).toEqual([
			'SF11',
			'4/6',
			'0x2B',
		]);
		expect(records.every((r) => Math.abs(parseFloat(field(r, 'Carrier offset')) - 22) < 2)).toBe(true);
		expect(out.status.at(-1)[0]).toBe('5 packet(s), last A61MC-2 TEXT');
	}, 120_000);
	it('decodes the UK and LA profiles (SF10, 125 kHz)', () => {
		const frames = sceneFrames({ strong: -10, weak: -12, cfoHz: -9000, sroPpm: -40, p: meshcomLora(10, 125000) }).slice(0, 2);
		const out = decodeFrames(MeshCom125, frames, { rate: MESHCOM_125_RATE, bwHz: 125000 });
		cpu(out, 'MeshCom 125 kHz');
		expect(out.records.map((r) => [r.text, field(r, 'Spreading factor'), field(r, 'Bandwidth')])).toEqual([
			['A61MC-1 → all · POSITION · 25.08500°N 55.17000°E · 12 m · battery 85 %', 'SF10', '125 kHz'],
			['A61MC-1 → all · TEXT · Hello MeshCom from the Marina', 'SF10', '125 kHz'],
		]);
	}, 60_000);
	it('finds nothing in noise alone', () => {
		const out = decodeFrames(MeshComDecoder, [], { rate: MESHCOM_RATE, bwHz: 250000, durationSec: 6 });
		cpu(out, 'MeshCom 250 kHz, noise alone');
		expect(out.records).toHaveLength(0);
		expect(out.status.at(-1)).toEqual(['Listening for MeshCom (SF11, 250 kHz)', false]);
		expect(decodeFrames(MeshCom125, [], { rate: MESHCOM_125_RATE, bwHz: 125000, durationSec: 6 }).records).toHaveLength(0);
	}, 60_000);
	it('gives the same records from small and large chunks', () => {
		const frames = sceneFrames({ strong: -8, weak: -10 }).slice(1, 4);
		const texts = [1500, 16384, 131072].map((chunk) =>
			decodeFrames(MeshComDecoder, frames, { rate: MESHCOM_RATE, bwHz: 250000, chunk }).records.map((r) => r.text),
		);
		expect(texts[0]).toHaveLength(3);
		expect(texts[1]).toEqual(texts[0]);
		expect(texts[2]).toEqual(texts[0]);
	}, 120_000);
});
