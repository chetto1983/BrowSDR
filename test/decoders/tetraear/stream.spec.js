import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { TetraEarStream } from '@/worker/decoders/tetraear/stream';
import { routeTetraEar, setTetraEarCallback } from '@/worker/decoders/tetraear/routing';
import { needsVfoInput, planSharedBands } from '@/worker/streams/channel-plan';
import * as dsp from '../../../wasm/dsp/pkg/browsdr_dsp.js';
import { downlinkBits, tetraSignal } from '../tetra/fixtures';

const wasm = dsp.initSync({ module: readFileSync(new URL('../../../wasm/dsp/pkg/browsdr_dsp_bg.wasm', import.meta.url)) });

describe('TetraEar production symbol stream', () => {
	it.each([false, true])('channelizes a muted VFO with real WASM, float=%s', (float) => {
		const messages = [];
		const stream = new TetraEarStream(dsp.DspProcessor, wasm.memory, (message) => messages.push(message));
		const params = { freq: 391, enabled: false, tetraear: 7 };
		stream.configure(params, 288000, 391.025);
		const iq = tetraSignal(downlinkBits(), { rate: 288000, offsetHz: -25000 });
		const ptr = dsp.alloc_float_buffer(32768);
		for (let index = 0, chunk = 1; index < iq.length; index += 32768, chunk++) {
			const part = iq.subarray(index, index + 32768);
			if (float) new Float32Array(wasm.memory.buffer, ptr, part.length).set(part);
			else new Int8Array(wasm.memory.buffer, ptr, part.length).set(part.map((value) => Math.round(value * 127)));
			stream.process(ptr, part.length, float, chunk);
		}
		const packets = messages.filter((message) => message.bits);
		expect(packets.length).toBeGreaterThanOrEqual(2);
		expect(packets.every((message) => message.session === 7 && message.freq === 391 && message.bits.byteLength === 2040)).toBe(true);
		// The Python integration test consumes the output of the actual WASM channelizer + demodulator.
		mkdirSync('.cache/tetraear-test', { recursive: true });
		writeFileSync(
			`.cache/tetraear-test/${float ? 'float' : 'int8'}.soft`,
			Buffer.concat(packets.map((packet) => Buffer.from(packet.bits))),
		);
		stream.configure({ ...params, tetraear: 0 }, 288000, 391.025);
		const count = messages.length;
		stream.process(ptr, 100, float, 100);
		expect(messages).toHaveLength(count);
		stream.reset();
	});

	it('resets on sample gaps and rejects out of band channels without silently decoding', () => {
		const post = vi.fn();
		const stream = new TetraEarStream(dsp.DspProcessor, wasm.memory, post);
		stream.configure({ freq: 391, tetraear: 1 }, 288000, 391);
		const ptr = dsp.alloc_float_buffer(100);
		new Float32Array(wasm.memory.buffer, ptr, 100).fill(0);
		stream.process(ptr, 100, true, 1);
		stream.process(ptr, 100, true, 3);
		expect(post.mock.calls.filter(([value]) => value.reset)).toHaveLength(2);
		stream.configure({ freq: 392, tetraear: 1 }, 288000, 391);
		expect(post.mock.lastCall[0].error).toContain('inside the received band');
		stream.reset();
	});

	it('keeps symbol reception active while audio is off and rejects callbacks from stale sessions', () => {
		const params = { freq: 391, mode: 'nfm', bandwidth: 25000, enabled: false, tetraear: 9 };
		expect(needsVfoInput(params)).toBe(true);
		expect(planSharedBands(2400000, 391, [params], true).direct).toEqual([0]);
		const worker = {},
			backend = { dspWorkers: [worker], vfoParams: [params] },
			callback = vi.fn();
		setTetraEarCallback.call(backend, callback);
		routeTetraEar(backend, worker, { type: 'tetraear_symbols', session: 8, freq: 391, reset: true });
		routeTetraEar(backend, worker, { type: 'tetraear_symbols', session: 9, freq: 390, reset: true });
		expect(callback).not.toHaveBeenCalled();
		routeTetraEar(backend, worker, { type: 'tetraear_symbols', session: 9, freq: 391, reset: true });
		expect(callback).toHaveBeenCalledOnce();
		setTetraEarCallback.call(backend, null);
	});
});
