import { isRecord } from '@/platform/data';
import { RationalResampler } from '@/worker/streams/dsp-pipeline';
import type { AacDecoder, FaadFactory, FaadModule } from './types';

/*
 * Loads faad2 (wasm/faad2) for DAB+ audio. The browser imports /wasm/faad2/faad.js; Node hosts (tests) hand in a
 * factory that reads the committed pkg/ from disk. One module instance is shared: faad2 keeps its state per handle.
 */

const AUDIO_RATE = 48000;
/** An access unit decodes to at most 2048 frames (960 x 2 with SBR); room for more. */
const MAX_FRAMES = 4096;

let providedFactory: FaadFactory | null = null;
let shared: Promise<FaadModule> | null = null;

/** Lets a Node host supply the module factory, since there is no /wasm/ origin to import from. */
export function provideFaadFactory(factory: FaadFactory): void {
	providedFactory = factory;
	shared = null;
}

async function browserFactory(): Promise<FaadFactory> {
	const url = new URL('/wasm/faad2/faad.js', location.origin).href;
	const loaded: unknown = await import(/* @vite-ignore */ url);
	if (!isRecord(loaded) || typeof loaded.default !== 'function') throw new Error('faad.js did not produce a factory');
	return loaded.default as FaadFactory;
}

function faadModule(): Promise<FaadModule> {
	shared ??= (async () => {
		const create = providedFactory ?? (await browserFactory());
		return create({ locateFile: (path) => '/wasm/faad2/' + path });
	})();
	return shared;
}

/** Opens a decoder for a DAB+ AudioSpecificConfig (AAC-LC 960, optionally SBR / PS). Rejects when faad2 refuses it. */
export async function createAacDecoder(asc: Uint8Array): Promise<AacDecoder> {
	const module = await faadModule();
	const ascPointer = module._malloc(asc.length);
	module.HEAPU8.set(asc, ascPointer);
	const handle = module._dab_aac_open(ascPointer, asc.length);
	module._free(ascPointer);
	if (!handle) throw new Error('faad2 refused the DAB+ audio configuration');
	const auPointer = module._malloc(1024);
	const outPointer = module._malloc(MAX_FRAMES * 2 * 4);
	let rate = module._dab_aac_rate(handle);
	let resampler = rate === AUDIO_RATE ? null : [new RationalResampler(rate, AUDIO_RATE), new RationalResampler(rate, AUDIO_RATE)];
	let closed = false;
	return {
		get rate() {
			return rate;
		},
		decode(au) {
			if (closed || au.length > 1024) return null;
			module.HEAPU8.set(au, auPointer);
			const frames = module._dab_aac_decode(handle, auPointer, au.length, outPointer, MAX_FRAMES);
			if (frames < 0) return null;
			const stereo = module.HEAPF32.slice(outPointer / 4, outPointer / 4 + frames * 2);
			const now = module._dab_aac_rate(handle);
			if (now !== rate) {
				rate = now;
				resampler = rate === AUDIO_RATE ? null : [new RationalResampler(rate, AUDIO_RATE), new RationalResampler(rate, AUDIO_RATE)];
			}
			return resampler ? resampleStereo(stereo, resampler) : stereo;
		},
		close() {
			if (closed) return;
			closed = true;
			module._dab_aac_close(handle);
			module._free(auPointer);
			module._free(outPointer);
		},
	};
}

function resampleStereo(stereo: Float32Array, [left, right]: RationalResampler[]): Float32Array {
	const frames = stereo.length / 2;
	const l = new Float32Array(frames);
	const r = new Float32Array(frames);
	for (let i = 0; i < frames; i++) {
		l[i] = stereo[2 * i];
		r[i] = stereo[2 * i + 1];
	}
	const outL = left.process(l);
	const outR = right.process(r);
	const count = Math.min(outL.length, outR.length);
	const out = new Float32Array(count * 2);
	for (let i = 0; i < count; i++) {
		out[2 * i] = outL[i];
		out[2 * i + 1] = outR[i];
	}
	return out;
}
