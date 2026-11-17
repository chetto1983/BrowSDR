// PSK31 through the production DSP worker: the 24 kHz channel cut from the received band at the catalog's rate and
// offset, two signals of the passband at once.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MeteorModule from '../../../wasm/meteor/pkg/meteor.js';
import { pskBand, sig } from './fixtures';
import { validDigimodeMessage } from '@/worker/decoders/digimode/validation';

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

describe('PSK31 through the production DSP worker', () => {
	it('decodes two PSK31 signals on 14.070 MHz, 10 kHz above the centre at 96 kS/s', async () => {
		const rate = 96000;
		const dialOffset = 10000;
		const signals = [
			sig(900, 'CQ CQ DE LY2ABC LY2ABC KO24 PSE K\n', 12),
			sig(1830, 'DL1XYZ DE G4ABC UR RST 599 BK\n', 11, 0, { startSec: 0.8 }),
		];
		// the noise of the 24 kHz channel (0.02 per component) spread over 96 kHz
		const iq = pskBand(15, signals, { rate, dialOffsetHz: dialOffset, noiseSigma: 0.02 * Math.sqrt(rate / 24000), seed: 6 });
		const input = Int8Array.from(iq, (v) => Math.max(-127, Math.min(127, Math.round(400 * v))));
		const { messages, send } = await startWorker();
		const params = { freq: 14.07, mode: 'usb', bandwidth: 2700, enabled: false, digimode: 'psk31' };
		await send({ type: 'init', sampleRate: rate, centerFreq: 14.07 - dialOffset / 1e6, params });
		const block = 2 * 9600;
		for (let i = 0, chunkId = 1; i < input.length; i += block, chunkId++) {
			const part = input.slice(i, i + block);
			await send({ type: 'process', params, chunk: part.buffer, chunkLen: part.length, floatIq: false, chunkId });
		}
		// two quiet seconds end the lines; the last records go out with the next message
		const quiet = new Int8Array(block);
		for (let k = 0; k < 25; k++)
			await send({
				type: 'process',
				params,
				chunk: quiet.slice().buffer,
				chunkLen: block,
				floatIq: false,
				chunkId: input.length / block + 1 + k,
			});
		await new Promise((resolve) => setTimeout(resolve, 300));
		await send({
			type: 'process',
			params,
			chunk: quiet.slice().buffer,
			chunkLen: block,
			floatIq: false,
			chunkId: input.length / block + 26,
		});
		const output = messages.filter((message) => message.type === 'digimode');
		expect(output.every(validDigimodeMessage)).toBe(true);
		const records = output.flatMap((message) => message.records);
		expect(records.every((r) => r.mode === 'psk31')).toBe(true);
		const texts = records.map((r) => r.text);
		expect(
			texts.some((t) => /^(899|900|901) Hz: CQ CQ DE LY2ABC LY2ABC KO24 PSE K$/.test(t)),
			texts.join(' | '),
		).toBe(true);
		expect(
			texts.some((t) => /^18(29|30|31) Hz: DL1XYZ DE G4ABC UR RST 599 BK$/.test(t)),
			texts.join(' | '),
		).toBe(true);
		expect(output.some((m) => m.status.locked && /^BPSK31: \d+ signals?, [12] decoding/.test(m.status.message))).toBe(true);
	}, 60_000);
});
