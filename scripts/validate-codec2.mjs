import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Codec2Module from '../wasm/codec2/pkg/codec2.js';

const wasmBinary = readFileSync(new URL('../wasm/codec2/pkg/codec2.wasm', import.meta.url));
const codec = await Codec2Module({ wasmBinary });
const init = codec.cwrap('browsdr_codec2_init', 'number', []);
const decode = codec.cwrap('browsdr_codec2_decode', 'number', ['number', 'number', 'number']);
assert.equal(init(), 1);
const bits = codec._malloc(16);
const output = codec._malloc(320 * 4);
codec.HEAPU8.fill(0, bits, bits + 16);
for (const [rate, count] of [
	[3200, 160],
	[1600, 320],
]) {
	assert.equal(decode(rate, bits, output), count);
	assert.ok(Array.from(new Float32Array(codec.HEAPF32.buffer, output, count)).every(Number.isFinite));
}
codec._free(bits);
codec._free(output);
console.log('Codec2 M17 3200 and 1600 decoders initialized and produced finite audio.');
