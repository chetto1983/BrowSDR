// Node stand-in for '/wasm/rtl433/rtl433.js': the committed Emscripten module with its WASM read from disk.
import { readFileSync } from 'node:fs';
import Rtl433Module from '../../wasm/rtl433/pkg/rtl433.js';

const wasmBinary = readFileSync(new URL('../../wasm/rtl433/pkg/rtl433.wasm', import.meta.url));

export default function createRtl433(options) {
	return Rtl433Module({ ...options, wasmBinary });
}
