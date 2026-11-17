// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir tests/mesh/test_mesh_loraaprs.cpp (scene: the MeshCom nodes of the
// 70 cm scene through the receiver tuned to MeshCom EU, 433.175 MHz, at a wider capture rate) and core/src/mesh/mesh_gen.cpp
// (kMcom), https://github.com/adswill/OnAir; see third_party/onair. Protocol facts as credited there: MeshCom firmware
// (icssw-org/MeshCom-Firmware, MIT). Changes: through BrowSDR's production DSP worker: the 500 kS/s channel cut at
// 433.175 MHz from a 2 MS/s band centred 300 kHz higher, 8-bit samples; the first three frames of the scene.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MeteorModule from '../../../wasm/meteor/pkg/meteor.js';
import { validDigimodeMessage } from '@/worker/decoders/digimode/validation';
import { streamSignal } from '../lora/phy';
import { MeshScene, schedule } from '../lora/scene';
import { field, MCOM_EVENTS, meshcomEvent, meshcomLora } from './fixtures';

const binary = readFileSync(new URL('../../../wasm/dsp/pkg/browsdr_dsp_bg.wasm', import.meta.url));
vi.mock('/wasm/dsp/browsdr_dsp.js', async () => {
	const dsp = await vi.importActual('../../../wasm/dsp/pkg/browsdr_dsp.js');
	const wasm = dsp.initSync({ module: binary });
	return { ...dsp, default: async () => wasm };
});
const pkg = (file) => fileURLToPath(new URL(`../../../wasm/meteor/pkg/${file}`, import.meta.url));
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

async function startWorker() {
	vi.resetModules();
	const messages = [];
	vi.stubGlobal('self', { postMessage: (message) => messages.push(message) });
	const { provideMeteorFactory } = await import('@/worker/decoders/meteor-init');
	provideMeteorFactory((options) => MeteorModule({ ...options, locateFile: pkg }));
	await import('@/worker/dsp-worker');
	return { messages, send: (data) => self.onmessage({ data }) };
}

describe('MeshCom through the production DSP worker', () => {
	it('decodes MeshCom EU on 433.175 MHz, 300 kHz below the centre at 2 MS/s', async () => {
		const { messages, send } = await startWorker();
		const params = { freq: 433.175, mode: 'nfm', bandwidth: 12500, enabled: false, digimode: 'meshcom' };
		const rate = 2000000;
		await send({ type: 'init', sampleRate: rate, centerFreq: 433.475, params });
		const scene = new MeshScene(8);
		let id = 0x1234;
		const frames = schedule(MCOM_EVENTS.slice(0, 3), {
			p: () => meshcomLora(),
			bytes: (e) => meshcomEvent(e, id++),
			radio: (e) => scene.radio(`mcm${e.node}`, -6),
			cfoHz: -300000 + 2500,
			scene,
		});
		let clock = performance.now();
		vi.spyOn(performance, 'now').mockImplementation(() => (clock += 300));
		const chunks = [];
		streamSignal(frames, (iq) => chunks.push(Int8Array.from(iq, (v) => Math.max(-127, Math.min(127, Math.round(v * 60))))), {
			rate,
			bwHz: 250000,
			noiseRms: 0.1,
			chunk: 65536,
			tailSec: 0.4,
		});
		let chunkId = 1;
		for (const block of chunks)
			await send({ type: 'process', params, chunk: block.buffer, chunkLen: block.length, floatIq: false, chunkId: chunkId++ });
		const output = messages.filter((message) => message.type === 'digimode');
		expect(output.every(validDigimodeMessage)).toBe(true);
		const records = output.flatMap((message) => message.records);
		expect(records.map((r) => [r.mode, r.text, r.damaged])).toEqual([
			['meshcom', 'A61MC-1 → all · POSITION · 25.08500°N 55.17000°E · 12 m · battery 85 %', false],
			['meshcom', 'A61MC-1 → all · TEXT · Hello MeshCom from the Marina', false],
			['meshcom', 'A61MC-2 via A61MC-1 → all · POSITION · 25.10000°N 55.20000°E · battery 64 %', false],
		]);
		expect(field(records[1], 'Message ID')).toBe('00001235');
		expect(output.at(-1).status).toMatchObject({ state: 'receiving', message: '3 packet(s), last A61MC-2 POSITION' });
	}, 60_000);
});
