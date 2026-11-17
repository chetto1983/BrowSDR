import { describe, expect, it } from 'vitest';
import { DSTAR_W, DSTAR_X } from '@/worker/decoders/dsd/constants';
import { loadMbelib } from '../voice-fixtures.js';

// D-STAR's "silence" voice frame, which repeaters and gateways send when there is no audio: 9 bytes, sent least
// significant bit first, spread over the AMBE matrix by DSD's dW/dX schedule as processDSTARVoice does.
const SILENCE = [0x9e, 0x8d, 0x32, 0x88, 0x26, 0x1a, 0x3f, 0x61, 0xe8];

function matrix(bytes) {
	const frame = new Int8Array(96);
	for (let i = 0; i < 72; i++) frame[DSTAR_W[i] * 24 + DSTAR_X[i]] = (bytes[i >> 3] >> (i & 7)) & 1;
	return frame;
}
const rms = (audio) => Math.sqrt(audio.reduce((sum, v) => sum + v * v, 0) / audio.length);

/** The loudest of 20 decoded silence frames, and the codec errors counted over them. */
function decodeSilence(mbe, decode) {
	mbe.resetMbe();
	let [loudest, errors] = [0, 0];
	for (let n = 0; n < 20; n++) {
		loudest = Math.max(loudest, rms(decode(matrix(SILENCE))));
		errors += mbe.getMbeErrors();
	}
	return { loudest, errors };
}

describe('D-STAR voice codec (real mbelib WASM)', () => {
	it('decodes the silence frame as silence with AMBE 3600x2400, and not with AMBE+2', async () => {
		const mbe = await loadMbelib();
		const ambe = decodeSilence(mbe, mbe.decodeAmbe2400);
		expect(ambe.errors).toBe(0);
		expect(ambe.loudest).toBeLessThan(0.005);
		// The AMBE+2 decoder BrowSDR used for D-STAR before turns the same frames into audible sound.
		expect(decodeSilence(mbe, mbe.decodeAmbe).loudest).toBeGreaterThan(5 * ambe.loudest);
	});
});
