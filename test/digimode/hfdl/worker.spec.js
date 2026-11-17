// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir tests/hfdl/test_hfdl_real.cpp (a real 600 bit/s aircraft
// downlink must give its performance data), tests/hfdl/test_hfdl_offset.cpp (the channel off the capture's centre,
// with a tuning error, noise and a strong AM carrier next to it) and tests/hfdl/test_hfdl_rx.cpp (the traffic generator
// through the receiver), https://github.com/adswill/OnAir; see third_party/onair. Changes: through BrowSDR's production
// DSP worker, which cuts the 7200 Hz channel 1440 Hz above the VFO from the capture; the recording is followed by half a
// second of silence (the channel filter's delay); the traffic is one channel's.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MeteorModule from '../../../wasm/meteor/pkg/meteor.js';
import { validDigimodeMessage } from '@/worker/decoders/digimode/validation';
import { digimodeInfo } from '@/worker/decoders/digimode/catalog';
import { field, play, rng, traffic } from './fixtures';

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

/** Feeds int8 I/Q to the worker in blocks; the clock moves 100 ms per block, so messages go out. */
async function feed(send, params, input, block) {
	let clock = performance.now();
	vi.spyOn(performance, 'now').mockImplementation(() => (clock += 100));
	let chunkId = 1;
	for (let i = 0; i < input.length; i += 2 * block) {
		const part = input.slice(i, i + 2 * block);
		await send({ type: 'process', params, chunk: part.buffer, chunkLen: part.length, floatIq: false, chunkId: chunkId++ });
	}
}

const records = (messages) =>
	messages.filter((m) => m.type === 'digimode').flatMap((m) => (expect(validDigimodeMessage(m)).toBe(true), m.records));

describe('HFDL through the production DSP worker', () => {
	it('has a catalog entry: the VFO on the dial, the channel 1440 Hz above it', () => {
		const info = digimodeInfo('hfdl');
		expect(info).toMatchObject({ rate: 7200, offsetHz: 1440, family: 'Aviation' });
		expect(info.presets.find((p) => p.label === 'Shannon').freqMHz).toBe(8.942);
		expect(new Set(info.presets.map((p) => p.freqMHz)).size).toBe(info.presets.length);
	});

	it('decodes a real 600 bit/s downlink from the air: CES202 near Sydney, on 13.351 MHz', async () => {
		const text = readFileSync(new URL('./real-burst.txt', import.meta.url), 'utf8')
			.split('\n')
			.filter((l) => l && !l.startsWith('#'))
			.join('');
		const raw = new Int8Array(Buffer.from(text, 'base64'));
		expect(raw.length).toBe(2 * 32400);
		const input = new Int8Array(raw.length + 2 * 6000);
		input.set(raw);
		const { messages, send } = await startWorker();
		const params = { freq: 13.351, mode: 'usb', bandwidth: 2700, enabled: false, digimode: 'hfdl' };
		await send({ type: 'init', sampleRate: 12000, centerFreq: 13.35514, params });
		await feed(send, params, input, 1000);
		const out = records(messages);
		const perf = out.find((r) => r.text.includes('Performance data CES202'));
		expect(perf).toBeDefined();
		const [lat, lon] = field(perf, 'Position').split(', ').map(parseFloat);
		expect(Math.abs(lat + 33.93)).toBeLessThan(0.1);
		expect(Math.abs(lon - 151.17)).toBeLessThan(0.1);
		expect(field(perf, 'Burst')).toMatch(/^600 bit\/s, 1 slot/);
		expect(Number(field(perf, 'Signal').match(/SNR ([\d.]+) dB/)[1])).toBeGreaterThan(8);
		expect(out.every((r) => !r.damaged)).toBe(true);
		const status = messages.filter((m) => m.type === 'digimode').at(-1).status;
		expect(status).toMatchObject({ state: 'receiving', locked: true });
		expect(status.message).toMatch(/^\d+ PDUs?, 0 bad/);
	}, 60_000);

	it('decodes a busy channel 9 kHz off the centre at 48 kS/s, next to a strong AM carrier', async () => {
		const rate = 48000;
		const centre = 8.933;
		const dial = 8.942;
		const tx = traffic({ gs: 7, other: 3, frames: 2, perFrame: 4, aircraft: 2, seed: 3 });
		const carHz = (dial - centre) * 1e6 + 1440 + 80;
		const iq = play(tx, { snrDb: 20, secs: 65, rate, carHz, seed: 9 });
		// an AM carrier 15 kHz away, 20 dB above the bursts
		const g = rng(4);
		const input = new Int8Array(iq.length);
		for (let n = 0; n < iq.length / 2; n++) {
			const t = n / rate;
			const am = 1 + 0.5 * Math.sin(2 * Math.PI * 400 * t);
			const ph = 2 * Math.PI * (((dial + 0.015 - centre) * 1e6 * t) % 1);
			input[2 * n] = Math.max(-127, Math.min(127, Math.round(60 * (iq[2 * n] + am * Math.cos(ph) + 0.001 * g.gauss()))));
			input[2 * n + 1] = Math.max(-127, Math.min(127, Math.round(60 * (iq[2 * n + 1] + am * Math.sin(ph) + 0.001 * g.gauss()))));
		}
		const { messages, send } = await startWorker();
		const params = { freq: dial, mode: 'usb', bandwidth: 2700, enabled: false, digimode: 'hfdl' };
		await send({ type: 'init', sampleRate: rate, centerFreq: centre, params });
		await feed(send, params, input, 4800);
		const out = records(messages);
		expect(out.every((r) => r.mode === 'hfdl' && !r.damaged)).toBe(true);
		expect(out.filter((r) => r.text.startsWith('Squitter Shannon'))).toHaveLength(2);
		expect(out.filter((r) => r.text.includes('Logon')).length).toBeGreaterThanOrEqual(2);
		expect(out.filter((r) => field(r, 'Position')).length).toBeGreaterThanOrEqual(1);
		expect(out.filter((r) => r.text.includes('ACARS')).length).toBeGreaterThanOrEqual(1);
		expect(out).toHaveLength(tx.length);
		for (const r of out) expect(Math.abs(Number(field(r, 'Signal').match(/carrier ([+-]?\d+) Hz/)[1]) - 80)).toBeLessThan(35);
	}, 120_000);
});
