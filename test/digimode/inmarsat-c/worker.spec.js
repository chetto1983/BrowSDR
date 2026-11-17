// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir tests/inmc/test_inmc_engine.cpp (the mode through the whole engine,
// the radio tuned beside the channel), https://github.com/adswill/OnAir; see third_party/onair. Changes: through
// BrowSDR's production DSP worker: the 96 kS/s channel cut at 1537.1 MHz from a 240 kS/s band centred 60 kHz lower,
// 8-bit samples, a carrier 4 kHz off; the SAR notice of the test loop comes out as an alert.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MeteorModule from '../../../wasm/meteor/pkg/meteor.js';
import { validDigimodeMessage } from '@/worker/decoders/digimode/validation';
import { InmcSignal } from './fixtures';

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

describe('Inmarsat-C through the production DSP worker', () => {
	it('decodes the NCS channel 60 kHz above the centre of a 240 kS/s band, 4 kHz off tune', async () => {
		const { messages, send } = await startWorker();
		const params = { freq: 1537.1, mode: 'nfm', bandwidth: 12500, enabled: false, digimode: 'inmarsat-c' };
		const rate = 240000;
		await send({ type: 'init', sampleRate: rate, centerFreq: 1537.04, params });
		const gen = new InmcSignal({ rate, offsetHz: 60000, cfoHz: 4000, ebn0Db: 9, perFrame: 10, seed: 3, rms: 0.25 });
		let clock = performance.now();
		vi.spyOn(performance, 'now').mockImplementation(() => (clock += 300));
		const block = rate / 4;
		for (let done = 0, chunkId = 1; done < 19 * rate; done += block, chunkId++) {
			const input = Int8Array.from(gen.generate(block), (v) => Math.max(-127, Math.min(127, Math.round(v * 127))));
			await send({ type: 'process', params, chunk: input.buffer, chunkLen: input.length, floatIq: false, chunkId });
		}
		const output = messages.filter((message) => message.type === 'digimode');
		expect(output.every(validDigimodeMessage)).toBe(true);
		const records = output.flatMap((message) => message.records);
		const sar = records.find((r) => r.text.includes('SAR COORDINATION MRCC MUSCAT'));
		expect(sar).toMatchObject({ mode: 'inmarsat-c', alert: true, damaged: false });
		expect(sar.text.startsWith('Urgency · Search and rescue')).toBe(true);
		const status = output.at(-1).status;
		expect(status).toMatchObject({ state: 'receiving', locked: true });
		expect(status.message).toMatch(/^IOR NCS · frame 1001 · Eb\/N0 \d+\.\d dB · carrier \+40\d\d Hz/);
	}, 120_000);
});
