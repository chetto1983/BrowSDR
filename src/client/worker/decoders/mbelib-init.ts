import type { MbelibModule, MbelibFactory } from './types';
import { isRecord } from '@/platform/data';

/*
 * Lazy loader for the mbelib WASM module.
 * Provides typed wrappers around the C functions for AMBE/IMBE decoding.
 */

let mbelibModule: MbelibModule | null = null;
let initPromise: Promise<void> | null = null;
let lastErrors = 0;

// C function wrappers (set after init)
let _decode_ambe: (frPtr: number, audioPtr: number) => number;
let _decode_ambe2400: (frPtr: number, audioPtr: number) => number;
let _decode_imbe: (frPtr: number, audioPtr: number) => number;
let _decode_ambe2450_data: (dataPtr: number, errors: number, audioPtr: number) => number;
let _mbelib_init: () => void;
let _mbelib_reset: () => void;
let _malloc: (size: number) => number;
let _free: (ptr: number) => void;

// Persistent WASM heap pointers for zero-alloc decode calls
let ambeFramePtr = 0; // 4*24 = 96 bytes
let imbeFramePtr = 0; // 8*23 = 184 bytes
let ambeDataPtr = 0; // 49 bytes
let audioOutPtr = 0; // 160 * 4 = 640 bytes (float32)

export async function ensureMbelibInitialized(factory?: MbelibFactory): Promise<void> {
	if (mbelibModule) return;
	if (initPromise) {
		await initPromise;
		return;
	}

	initPromise = (async () => {
		const MbelibModuleFactory = factory ?? (await loadMbelibFactory());

		const module = await MbelibModuleFactory({
			locateFile: (path: string) => '/wasm/mbelib/' + path,
		});

		_decode_ambe = module.cwrap('mbelib_decode_ambe', 'number', ['number', 'number']);
		_decode_ambe2400 = module.cwrap('mbelib_decode_ambe2400', 'number', ['number', 'number']);
		_decode_imbe = module.cwrap('mbelib_decode_imbe', 'number', ['number', 'number']);
		_decode_ambe2450_data = module.cwrap('mbelib_decode_ambe2450_data', 'number', ['number', 'number', 'number']);
		_mbelib_init = module.cwrap('mbelib_init', null, []);
		_mbelib_reset = module.cwrap('mbelib_reset', null, []);
		_malloc = module._malloc;
		_free = module._free;

		// Allocate persistent buffers
		ambeFramePtr = _malloc(96);
		imbeFramePtr = _malloc(184);
		ambeDataPtr = _malloc(49);
		audioOutPtr = _malloc(160 * 4);
		if (!ambeFramePtr || !imbeFramePtr || !ambeDataPtr || !audioOutPtr) {
			for (const ptr of [ambeFramePtr, imbeFramePtr, ambeDataPtr, audioOutPtr]) if (ptr) _free(ptr);
			throw new Error('mbelib could not allocate its voice buffers');
		}

		_mbelib_init();
		mbelibModule = module;
		console.log('mbelib WASM initialized');
	})();
	try {
		await initPromise;
	} catch (error) {
		initPromise = null; // Permit a later retry after a transient asset failure.
		throw error;
	}
}

/**
 * Decode an AMBE+2 3600x2450 voice frame (DMR, NXDN, dPMR, YSF V/D mode 1).
 * @param ambeFr 4x24 bit matrix as flat Int8Array (96 bytes, row-major)
 * @returns Float32Array of 160 audio samples at 8 kHz
 */
export function decodeAmbe(ambeFr: Int8Array | Uint8Array): Float32Array {
	return decodeAmbeFrame(ambeFr, _decode_ambe);
}

/**
 * Decode an AMBE 3600x2400 voice frame (D-STAR's original AMBE codec, not AMBE+2).
 * @param ambeFr 4x24 bit matrix as flat Int8Array (96 bytes, row-major), as DSD's dW/dX schedule fills it
 * @returns Float32Array of 160 audio samples at 8 kHz
 */
export function decodeAmbe2400(ambeFr: Int8Array | Uint8Array): Float32Array {
	return decodeAmbeFrame(ambeFr, _decode_ambe2400);
}

function decodeAmbeFrame(ambeFr: Int8Array | Uint8Array, decode: (frPtr: number, audioPtr: number) => number): Float32Array {
	if (!mbelibModule) throw new Error('mbelib is not ready');
	if (ambeFr.length !== 96) throw new Error('AMBE frame must contain 96 bits');
	const heap8 = new Int8Array(mbelibModule.HEAP8.buffer);
	heap8.set(ambeFr.subarray(0, 96), ambeFramePtr);

	lastErrors = decode(ambeFramePtr, audioOutPtr);

	const heapF32 = new Float32Array(mbelibModule.HEAPF32.buffer);
	return new Float32Array(heapF32.buffer, audioOutPtr, 160).slice();
}

/**
 * Decode an IMBE 7200x4400 voice frame (P25 Phase 1).
 * @param imbeFr 8x23 bit matrix as flat Int8Array (184 bytes, row-major)
 * @returns Float32Array of 160 audio samples at 8 kHz
 */
export function decodeImbe(imbeFr: Int8Array | Uint8Array): Float32Array {
	if (!mbelibModule) throw new Error('mbelib is not ready');
	if (imbeFr.length !== 184) throw new Error('IMBE frame must contain 184 bits');
	const heap8 = new Int8Array(mbelibModule.HEAP8.buffer);
	heap8.set(imbeFr.subarray(0, 184), imbeFramePtr);

	lastErrors = _decode_imbe(imbeFramePtr, audioOutPtr);

	const heapF32 = new Float32Array(mbelibModule.HEAPF32.buffer);
	return new Float32Array(heapF32.buffer, audioOutPtr, 160).slice();
}

/**
 * Decode 49 AMBE 3600x2450 parameter bits that were already error-corrected (Yaesu System Fusion V/D mode 2).
 * @param bits 49 bits, one per byte, in mbelib's ambe_d order
 * @param errors bit errors found by the caller's own error check
 * @returns Float32Array of 160 audio samples at 8 kHz
 */
export function decodeAmbe2450(bits: Uint8Array, errors: number): Float32Array {
	if (!mbelibModule) throw new Error('mbelib is not ready');
	if (bits.length !== 49) throw new Error('AMBE parameters must contain 49 bits');
	const heap8 = new Int8Array(mbelibModule.HEAP8.buffer);
	heap8.set(bits, ambeDataPtr);

	lastErrors = _decode_ambe2450_data(ambeDataPtr, errors, audioOutPtr);

	const heapF32 = new Float32Array(mbelibModule.HEAPF32.buffer);
	return new Float32Array(heapF32.buffer, audioOutPtr, 160).slice();
}

/** Reset the mbelib decoder state (call on mode change / sync loss). */
export function resetMbe(): void {
	lastErrors = 0;
	if (mbelibModule) _mbelib_reset();
}

/** Error count returned by the most recent voice codec call. */
export function getMbeErrors(): number {
	return lastErrors;
}

/** Check if mbelib is loaded and ready. */
export function isMbelibReady(): boolean {
	return mbelibModule !== null;
}

async function loadMbelibFactory(): Promise<MbelibFactory> {
	const url = new URL('/wasm/mbelib/mbelib.js', location.origin).href;
	const loaded: unknown = await import(/* @vite-ignore */ url);
	if (!isRecord(loaded) || typeof loaded.default !== 'function') throw new Error('mbelib.js did not produce a factory');
	return loaded.default as MbelibFactory;
}
