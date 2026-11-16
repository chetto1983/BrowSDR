import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import FaadModule from '../../wasm/faad2/pkg/faad.js';
import { provideFaadFactory } from '@/worker/decoders/dabplus/faad';
import { DabStream, provideDabReceiver } from '@/worker/decoders/dabplus/stream';
import { DabReceiver } from '@/worker/decoders/dab/receiver';
import { RationalResampler } from '@/worker/streams/dsp-pipeline';
import { DabSignal } from './transmitter.js';
import { ENSEMBLE, rms } from './fixtures.js';

const binary = readFileSync(new URL('../../wasm/dsp/pkg/browsdr_dsp_bg.wasm', import.meta.url));
const dsp = await import('../../wasm/dsp/pkg/browsdr_dsp.js');
const wasm = dsp.initSync({ module: binary });
const pkg = (file) => fileURLToPath(new URL(`../../wasm/faad2/pkg/${file}`, import.meta.url));

const INPUT_RATE = 2_400_000;
/** The ensemble sits 100 kHz above the centre of the received band. */
const OFFSET_HZ = 100_000;
const CHUNK = 40960;

/** The test signal as a radio at 2.4 MS/s tuned 100 kHz below the block hears it. */
function radio(signal) {
	const resamplers = [new RationalResampler(2_048_000, INPUT_RATE), new RationalResampler(2_048_000, INPUT_RATE)];
	const dph = (2 * Math.PI * OFFSET_HZ) / INPUT_RATE;
	let count = 0;
	return () => {
		const iq = signal.generate(CHUNK);
		const parts = [0, 1].map((c) => {
			const x = new Float32Array(CHUNK);
			for (let i = 0; i < CHUNK; i++) x[i] = iq[2 * i + c];
			return resamplers[c].process(x).slice();
		});
		const n = Math.min(parts[0].length, parts[1].length);
		const out = new Float32Array(2 * n);
		for (let i = 0; i < n; i++, count++) {
			const c = Math.cos(dph * count),
				s = Math.sin(dph * count);
			out[2 * i] = parts[0][i] * c - parts[1][i] * s;
			out[2 * i + 1] = parts[0][i] * s + parts[1][i] * c;
		}
		return out;
	};
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeAll(() => {
	provideFaadFactory((options) => FaadModule({ ...options, locateFile: pkg }));
	provideDabReceiver((events) => new DabReceiver(events));
});

describe('DAB+ through the stream', () => {
	it('locks at 2.4 MS/s through the DDC, lists the services and plays the audio', async () => {
		const messages = [];
		const dab = new DabStream(dsp.DspProcessor, wasm.memory, (message) => messages.push(message));
		dab.configure({ freq: 223.936, mode: 'dab', bandwidth: 1536000, enabled: true, dabService: 0 }, INPUT_RATE, 223.936 - OFFSET_HZ / 1e6);
		const next = radio(new DabSignal(ENSEMBLE, { snrDb: 14, cfoHz: 1200, seed: 2 }));
		const pointer = wasm.alloc_float_buffer(2 * Math.ceil((CHUNK * INPUT_RATE) / 2_048_000) + 256);
		let played = 0,
			loud = 0;
		// 2 s of signal
		for (let sequence = 1; sequence <= 100; sequence++) {
			const iq = next();
			new Float32Array(wasm.memory.buffer, pointer, iq.length).set(iq);
			const audio = dab.process(pointer, iq.length, true, sequence);
			if (audio) {
				played += audio.length / 2;
				loud = Math.max(loud, rms(audio));
			}
			if (sequence % 10 === 0) await flush(); // faad2 opens asynchronously
		}
		const status = messages.at(-1).status;
		expect(messages.some((m) => m.status.state === 'synced')).toBe(true);
		expect(status).toMatchObject({
			state: 'synced',
			ensemble: 'BrowSDR DAB Test',
			eid: 0xc0de,
			service: 0xc221,
			serviceLabel: 'BrowSDR Plus',
		});
		expect(status.services.map((s) => s.label)).toEqual(['BrowSDR Plus', 'BrowSDR MP2']);
		expect(status.codec).toBe('AAC-LC stereo 48 kHz');
		expect(status.label).toContain('BrowSDR test tones');
		expect(status.audioUnits).toBeGreaterThan(30);
		expect(status.audioErrors).toBe(0);
		expect(played).toBeGreaterThan(24000);
		expect(loud).toBeGreaterThan(0.1);
	}, 20000);
});
