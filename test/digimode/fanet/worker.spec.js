// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir tests/avroad/test_avroad_air.cpp (testFanet: tracking frames
// through the receiver at a wider capture rate), https://github.com/adswill/OnAir; see third_party/onair. Format facts
// as credited there: the FANET protocol description (protocol.txt of Skytraxx's fanet-stm32). Changes: through BrowSDR's
// production DSP worker: the 500 kS/s channel cut at 868.2 MHz from a 2.4 MS/s band centred 200 kHz lower, 8-bit
// samples, the station location from the VFO parameters, a name, a pilot's distress call and a paced aircraft.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MeteorModule from '../../../wasm/meteor/pkg/meteor.js';
import { validDigimodeMessage } from '@/worker/decoders/digimode/validation';
import { streamSignal } from '../lora/phy';
import { fanetFrames, fanetGround, fanetName, fanetTrack, field } from './fixtures';

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

describe('FANET through the production DSP worker', () => {
	it('lists a pilot, an aircraft and a distress call on 868.2 MHz, 200 kHz above the centre at 2.4 MS/s', async () => {
		const { messages, send } = await startWorker();
		const params = {
			freq: 868.2,
			mode: 'nfm',
			bandwidth: 12500,
			enabled: false,
			digimode: 'fanet',
			digimodeStation: { lat: 46.45, lon: 7.85 },
		};
		const rate = 2400000;
		await send({ type: 'init', sampleRate: rate, centerFreq: 868.0, params });
		const frames = fanetFrames(
			[
				{ payload: fanetName(0x11, 0x2233, 'Bob'), at: 0.05 },
				{ payload: fanetTrack(0x11, 0x2233, 46.5, 7.9, 1200), at: 0.15 },
				{ payload: fanetTrack(0x11, 0x2233, 46.501, 7.9, 1210), at: 1.15 },
				{ payload: fanetGround(0x07, 0x0abc, 46.48, 7.88, 14), at: 1.4 },
			],
			{ snrDb: 0, freqHz: 200000 + 4000 },
		);
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
		expect(records.map((r) => [r.mode, r.text, !!r.alert])).toEqual([
			['fanet', 'FANET 11:2233 · name: Bob', false],
			['fanet', 'FANET 11:2233 · paraglider · 46.50000, 7.90001 · 1200 m · 20 km/h · heading 90° · +1.2 m/s · 6.8 km', false],
			['fanet', 'FANET 07:0ABC · on the ground: distress call · 46.48000, 7.88001 · 4.1 km', true],
		]);
		expect(field(records[1], 'Name')).toBe('Bob');
		expect(Math.abs(parseFloat(field(records[1], 'Carrier offset')) - 4)).toBeLessThan(0.3);
		expect(output.at(-1).status).toMatchObject({ state: 'receiving', locked: true, message: '1 aircraft · 4 frames' });
	}, 60_000);
});
