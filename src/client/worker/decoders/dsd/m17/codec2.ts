// Codec2 1.2.0 (LGPL-2.1) runs in its own WASM module; see wasm/codec2/.
import { isRecord } from '@/platform/data';
import type { Codec2Module, Codec2Factory } from './types';

let module: Codec2Module | null = null;
let pending: Promise<void> | null = null;
let decode: ((rate: number, bits: number, output: number) => number) | null = null;
let reset: (() => number) | null = null;
let bitsPointer = 0;
let outputPointer = 0;

export async function ensureM17Codec2(factory?: Codec2Factory): Promise<void> {
	if (module) return;
	if (pending) return pending;
	pending = (async () => {
		let create = factory;
		if (!create) {
			const url = new URL('/wasm/codec2/codec2.js', location.origin).href;
			const loaded: unknown = await import(/* @vite-ignore */ url);
			if (!isRecord(loaded) || typeof loaded.default !== 'function') throw new Error('Codec2 module factory missing');
			create = loaded.default as Codec2Factory;
		}
		const created = await create({ locateFile: (path) => `/wasm/codec2/${path}` });
		const init = created.cwrap('browsdr_codec2_init', 'number', []);
		if (!init()) throw new Error('Codec2 M17 voice modes unavailable');
		bitsPointer = created._malloc(16);
		outputPointer = created._malloc(320 * 4);
		if (!bitsPointer || !outputPointer) {
			if (bitsPointer) created._free(bitsPointer);
			if (outputPointer) created._free(outputPointer);
			throw new Error('Codec2 voice buffers unavailable');
		}
		decode = created.cwrap('browsdr_codec2_decode', 'number', ['number', 'number', 'number']);
		reset = created.cwrap('browsdr_codec2_reset', null, []);
		module = created;
	})();
	try {
		await pending;
	} catch (error) {
		pending = null;
		throw error;
	}
}

export function m17Codec2Ready(): boolean {
	return module !== null;
}

/** One M17 40 ms voice payload, decoded to 320 samples at 8 kHz. */
export function decodeM17Voice(payload: Uint8Array, rate: 1600 | 3200): Float32Array {
	if (!module || !decode || payload.length !== 16) throw new Error('Codec2 M17 voice unavailable');
	module.HEAPU8.set(payload, bitsPointer);
	const output = new Float32Array(320);
	const frames = rate === 1600 ? 1 : 2;
	for (let index = 0; index < frames; index++) {
		const count = decode(rate, bitsPointer + index * 8, outputPointer);
		if (count !== 320 / frames) throw new Error('Codec2 M17 frame size mismatch');
		output.set(new Float32Array(module.HEAPF32.buffer, outputPointer, count), index * count);
	}
	return output;
}

export function resetM17Voice(): void {
	reset?.();
}
