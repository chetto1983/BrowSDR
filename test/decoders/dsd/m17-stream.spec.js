import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DSDDecoder } from '@/worker/decoders/dsd/dsd-decoder';
import { ensureM17Codec2 } from '@/worker/decoders/dsd/m17/codec2';
import { ensureMbelibInitialized } from '@/worker/decoders/mbelib-init';
import Codec2Module from '../../../wasm/codec2/pkg/codec2.js';
import MbelibModule from '../../../wasm/mbelib/pkg/mbelib.js';

const [lsfLine, streamLine] = readFileSync(new URL('./m17-onair-fixture.txt', import.meta.url), 'utf8')
	.trim()
	.split(/\r?\n/);
const symbols = [...Array(100).fill(0), ...lsfLine.split(',').map(Number), ...streamLine.split(',').map(Number), ...Array(100).fill(0)];

describe('M17 through DSD audio sampler', () => {
	it('recognizes OnAir frames and produces Codec2 audio after the 48 kHz sampler', async () => {
		const codecBinary = readFileSync(new URL('../../../wasm/codec2/pkg/codec2.wasm', import.meta.url));
		const mbelibBinary = readFileSync(new URL('../../../wasm/mbelib/pkg/mbelib.wasm', import.meta.url));
		await ensureM17Codec2((options) => Codec2Module({ ...options, wasmBinary: codecBinary }));
		await ensureMbelibInitialized((options) => MbelibModule({ ...options, wasmBinary: mbelibBinary }));
		let recognized = false;
		for (let phase = 0; phase < 10 && !recognized; phase++) {
			const statuses = [];
			const audio = [];
			const decoder = new DSDDecoder(
				(samples) => audio.push(samples),
				(status) => statuses.push(status),
			);
			const fm = new Float32Array(symbols.length * 10 + phase);
			for (let i = 0; i < symbols.length; i++) fm.fill((symbols[i] * 800 * 2 * Math.PI) / 48000, phase + i * 10, phase + (i + 1) * 10);
			for (let i = 0; i < fm.length; i += 2048) decoder.process(fm.subarray(i, i + 2048));
			recognized =
				statuses.some((status) => status.mode === 'm17' && status.m17?.src === 'N0CALL' && status.voiceFrameCount === 2) &&
				audio.some((samples) => samples.length >= 320 && samples.every(Number.isFinite));
		}
		expect(recognized).toBe(true);
	});
});
