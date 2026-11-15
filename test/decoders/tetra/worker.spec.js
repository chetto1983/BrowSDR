import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validTetraMessage } from '@/worker/decoders/tetra/validation';
import { REAL_SYNC_BURSTS } from './real-bursts';
import { downlinkBits, tetraSignal } from './fixtures';

const binary = readFileSync(new URL('../../../wasm/dsp/pkg/browsdr_dsp_bg.wasm', import.meta.url));
vi.mock('/wasm/dsp/browsdr_dsp.js', async () => {
	const dsp = await vi.importActual('../../../wasm/dsp/pkg/browsdr_dsp.js');
	const wasm = dsp.initSync({ module: binary });
	return { ...dsp, default: async () => wasm };
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

async function startWorker() {
	vi.resetModules();
	const messages = [];
	vi.stubGlobal('self', { postMessage: (message) => messages.push(message) });
	await import('@/worker/dsp-worker');
	return { messages, send: (data) => self.onmessage({ data }) };
}

describe('TETRA through the production DSP worker', () => {
	it.each([false, true])('channelizes an offset carrier at 2.4 MS/s and reports the cell (float=%s)', async (float) => {
		const { messages, send } = await startWorker();
		const params = { freq: 391, mode: 'nfm', bandwidth: 25000, enabled: false, tetra: true };
		await send({ type: 'init', sampleRate: 2400000, centerFreq: 390.65, params });
		const signal = tetraSignal(downlinkBits(REAL_SYNC_BURSTS.cellA, 2), { rate: 2400000, offsetHz: 350000 + 180, amplitude: 0.5 });
		const input = float ? signal : Int8Array.from(signal, (value) => Math.round(value * 127));
		let clock = performance.now();
		vi.spyOn(performance, 'now').mockImplementation(() => (clock += 600));
		let chunkId = 0;
		for (let i = 0; i < input.length; i += 65536) {
			const chunk = input.slice(i, i + 65536);
			chunkId++;
			await send({ type: 'process', params, chunk: chunk.buffer, chunkLen: chunk.length, floatIq: float, chunkId });
		}
		const last = messages.findLast((message) => message.type === 'tetra');
		expect(validTetraMessage(last)).toBe(true);
		expect(last.status).toMatchObject({ state: 'receiving', frames: 2 });
		expect(last.status.message).toContain('Locked');
		expect(last.cells).toHaveLength(1);
		expect(last.cells[0]).toMatchObject({ mcc: 222, mnc: 55, colourCode: 31, syncCount: 2 });
		expect(last.cells[0].sysinfo).toMatchObject({ mainCarrierMHz: 391, locationArea: 440 });
		expect(last.cells[0].sysinfo.services.airEncryption).toBe(true);
		await send({ type: 'configure', centerFreq: 390.65, params: { ...params, tetra: false } });
		expect(messages.findLast((message) => message.type === 'tetra').status.state).toBe('off');
	});
	it('refuses a carrier outside the received band', async () => {
		const { messages, send } = await startWorker();
		const params = { freq: 393, mode: 'nfm', bandwidth: 25000, enabled: false, tetra: true };
		await send({ type: 'init', sampleRate: 2400000, centerFreq: 390.65, params });
		const status = messages.findLast((message) => message.type === 'tetra')?.status;
		expect(status?.state).toBe('error');
		expect(status?.message).toContain('72 kHz channel');
	});
});

describe('TETRA remote telemetry validation', () => {
	const message = {
		type: 'tetra',
		freq: 391,
		status: { state: 'receiving', message: 'Locked', samples: 1, bursts: 1, frames: 1, quality: 0.9, freqOffsetHz: -200 },
		cells: [],
	};
	it('accepts a bounded message and rejects malformed peers', () => {
		expect(validTetraMessage(message)).toBe(true);
		expect(validTetraMessage({ ...message, status: { ...message.status, state: 'hacked' } })).toBe(false);
		expect(validTetraMessage({ ...message, cells: Array(33).fill({}) })).toBe(false);
		expect(validTetraMessage({ ...message, cells: [{ id: 'x', mcc: 5000 }] })).toBe(false);
	});
});
