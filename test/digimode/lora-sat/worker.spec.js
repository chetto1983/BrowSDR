// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir tests/lorasat/test_lorasat_rx.cpp (436.8 MHz beacons through a
// pass, the pass planner's satellite on every frame), https://github.com/adswill/OnAir; see third_party/onair. Changes:
// through BrowSDR's production DSP worker: the 250 kS/s channel cut at 436.8 MHz from a 2.4 MS/s band centred 150 kHz
// lower (as the Satellites tool tunes), 8-bit samples, the tracked satellite and the orbit's Doppler hint in the VFO
// parameters, one frame in inverted IQ with a sync word of its own.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MeteorModule from '../../../wasm/meteor/pkg/meteor.js';
import { validDigimodeMessage } from '@/worker/decoders/digimode/validation';
import { streamSignal } from '../lora/phy';
import { LoraSatPass, beaconParams, field, fieldNumber, framesAt } from './gen';

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

describe('LoRa satellites through the production DSP worker', () => {
	it('decodes a pass on 436.8 MHz 150 kHz above the centre at 2.4 MS/s, named and with the expected Doppler', async () => {
		const { messages, send } = await startWorker();
		const pass = new LoraSatPass({ carrierMhz: 436.8 });
		const rate = 2400000;
		// the Satellites tool tunes the VFO to the nominal frequency, the receiver 150 kHz below, and keeps both there
		const frames = [
			...framesAt(pass, beaconParams(10, 125000, 0x12), [120], 0.05, { snrDb: 0, cfoHz: 150000 }),
			...framesAt(pass, beaconParams(9, 125000, 0x5a), [121], 0.05, { snrDb: 0, cfoHz: 150000, inverted: true, first: 1 }).map((f) => ({
				...f,
				startSec: f.startSec + 0.6,
				endSec: f.endSec + 0.6,
			})),
		];
		const hint = { offsetHz: pass.dopplerHz(120), rateHzS: pass.rateHzS(120) };
		const params = {
			freq: 436.8,
			mode: 'nfm',
			bandwidth: 12500,
			enabled: false,
			digimode: 'lora-sat',
			digimodeLoraSat: { satellite: { name: 'FossaSat-2E19', norad: 62676 }, hint },
		};
		await send({ type: 'init', sampleRate: rate, centerFreq: 436.65, params });
		let clock = performance.now();
		vi.spyOn(performance, 'now').mockImplementation(() => (clock += 300));
		const chunks = [];
		streamSignal(frames, (iq) => chunks.push(Int8Array.from(iq, (v) => Math.max(-127, Math.min(127, Math.round(v * 60))))), {
			rate,
			bwHz: 125000,
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
		expect(records.map((r) => [r.mode, r.damaged, field(r, 'Text')])).toEqual([
			['lora-sat', false, 'SAT-BCN #0000 bat=3.'],
			['lora-sat', false, 'SAT-BCN #0001 bat=3.'],
		]);
		expect(records[0].text).toMatch(
			/^FossaSat-2E19 · SF10 · 125 kHz · 4\/8 · sync 0x12 · Doppler \+10\.\d\d kHz, [+−]\d+ Hz\/s · 20 bytes: "SAT-BCN #0000/,
		);
		expect(records[1].text).toMatch(/^FossaSat-2E19 · SF9 · 125 kHz · 4\/8 · sync 0x5A · inverted IQ · Doppler \+10\.\d\d kHz/);
		for (const r of records) {
			expect(field(r, 'Satellite')).toBe('FossaSat-2E19 (NORAD 62676, from Tools → Satellites)');
			expect(Math.abs(fieldNumber(r, 'Measured − expected'))).toBeLessThan(0.15);
			expect(Math.abs(fieldNumber(r, 'Frequency') - (436.8 + fieldNumber(r, 'Doppler') / 1000))).toBeLessThan(6e-6);
		}
		expect(output.at(-1).status).toMatchObject({ state: 'receiving' });
		expect(output.at(-1).status.message).toMatch(/^2 frame\(s\), last SF9 \+10\.\d\d kHz · pass of FossaSat-2E19, expected Doppler/);
	}, 60_000);
});
