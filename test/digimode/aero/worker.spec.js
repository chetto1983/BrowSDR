// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir tests/aero/test_aero_engine.cpp (the mode through the whole engine,
// the radio tuned beside the P channels), https://github.com/adswill/OnAir; see third_party/onair. Changes: through
// BrowSDR's production DSP worker: the 48 kS/s channel cut at the Alphasat 25E preset (1545.1225 MHz) from a 240 kS/s band
// centred 80 kHz lower, 8-bit samples, the two P channels of the preset with carrier errors of a few kHz, the station
// location from the VFO parameters.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MeteorModule from '../../../wasm/meteor/pkg/meteor.js';
import { validDigimodeMessage } from '@/worker/decoders/digimode/validation';
import { field } from './fixtures';
import { AeroSignal } from './signal';

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

describe('Inmarsat Aero through the production DSP worker', () => {
	it('decodes the two P channels of the Alphasat preset 80 kHz above the centre of a 240 kS/s band', async () => {
		const { messages, send } = await startWorker();
		const params = {
			freq: 1545.1225,
			mode: 'nfm',
			bandwidth: 12500,
			enabled: false,
			digimode: 'aero',
			digimodeStation: { lat: 25.25, lon: 55.36 },
		};
		const rate = 240000;
		await send({ type: 'init', sampleRate: rate, centerFreq: 1545.0425, params });
		const sig = new AeroSignal({
			rate,
			ebn0Db: 12,
			channels: [
				{ bitRate: 1200, offsetHz: 80000 - 7500, cfoHz: -2460 },
				{ bitRate: 600, offsetHz: 80000 + 7500, cfoHz: 970 },
			],
		});
		let clock = performance.now();
		vi.spyOn(performance, 'now').mockImplementation(() => (clock += 300));
		const block = rate / 4;
		for (let done = 0, chunkId = 1; done < 22 * rate; done += block, chunkId++) {
			const input = Int8Array.from(sig.generate(block), (v) => Math.max(-127, Math.min(127, Math.round(v * 127))));
			await send({ type: 'process', params, chunk: input.buffer, chunkLen: input.length, floatIq: false, chunkId });
		}
		const output = messages.filter((message) => message.type === 'digimode');
		expect(output.every(validDigimodeMessage)).toBe(true);
		const records = output.flatMap((message) => message.records);
		const wx = records.find((r) => r.text.startsWith('Uplink to A6-EUA (896411) · ACARS H1'));
		expect(wx).toMatchObject({ mode: 'aero', damaged: false });
		expect(field(wx, 'Channel')).toMatch(/^1200 bit\/s P channel at -9\.9\d\d kHz from the VFO/);
		const adsc = records.find((r) => r.text.startsWith('Downlink from A6-EUA (896411) · ADS-C report'));
		expect(adsc.text).toMatch(/· \d+ km$/);
		expect(records.some((r) => r.text.startsWith('Log-on:'))).toBe(true);
		const status = output.at(-1).status;
		expect(status).toMatchObject({ state: 'receiving', locked: true });
		expect(status.message).toMatch(/^1200 bit\/s at -9\.9\d kHz, Eb\/N0 \d+\.\d dB; 600 bit\/s at \+8\.4\d kHz/);
	}, 120_000);
});
