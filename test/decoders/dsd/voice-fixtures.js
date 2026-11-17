// Shared by the Yaesu System Fusion and dPMR tests: valid AMBE+2 and IMBE voice frames (written from mbelib's
// decoder: Golay, Hamming and the pseudo-random modulation in reverse), the real mbelib WASM, and an FM channel with
// noise and a channel filter in front of BrowSDR's DSD stream.
import { readFile } from 'node:fs/promises';
import { DMR_W, DMR_X, DMR_Y, DMR_Z, P25_IW, P25_IX, P25_IY, P25_IZ } from '@/worker/decoders/dsd/constants';

// mbelib ecc_const.h generator rows, data bit 0 (the most significant) first.
const GOLAY_GENERATOR = [0x63a, 0x31d, 0x7b4, 0x3da, 0x1ed, 0x6cc, 0x366, 0x1b3, 0x6e3, 0x54b, 0x49f, 0x475];
const HAMMING_GENERATOR = [0x7f08, 0x78e4, 0x66d2, 0x55b1];

export function randomBits(seed, n) {
	let s = seed >>> 0 || 1;
	return Uint8Array.from({ length: n }, () => {
		s ^= s << 13;
		s ^= s >>> 17;
		s ^= s << 5;
		return (s >>> 7) & 1;
	});
}

/** Golay (23,12) as mbelib reads it: row[22..11] data (most significant first), row[10..0] parity. */
function golay2312(row, data) {
	let parity = 0;
	for (let i = 0; i < 12; i++) {
		row[22 - i] = data[i];
		if (data[i]) parity ^= GOLAY_GENERATOR[i];
	}
	for (let b = 0; b < 11; b++) row[b] = (parity >> b) & 1;
}

/** Hamming (15,11) as mbelib reads it: row[14..4] data, row[3..0] parity. */
function hamming1511(row, data) {
	let block = 0;
	for (let i = 0; i < 11; i++) {
		row[14 - i] = data[i];
		block |= data[i] << (14 - i);
	}
	for (let i = 0; i < 4; i++) {
		let p = block & HAMMING_GENERATOR[i];
		let parity = 0;
		for (; p; p &= p - 1) parity ^= 1;
		row[3 - i] = parity;
	}
}

function prSequence(seed12, n) {
	const pr = new Uint16Array(n);
	pr[0] = 16 * seed12;
	for (let i = 1; i < n; i++) pr[i] = (173 * pr[i - 1] + 13849) % 65536;
	return Uint8Array.from(pr, (v, i) => (i === 0 ? 0 : v >> 15));
}

/** 49 AMBE 3600x2450 parameter bits (mbelib ambe_d order) -> the 72 channel bits of a DMR / NXDN / Fusion / dPMR frame. */
export function ambeEncode(d) {
	const fr = [new Uint8Array(24), new Uint8Array(24), new Uint8Array(24), new Uint8Array(24)];
	const c0 = new Uint8Array(23);
	golay2312(c0, d.subarray(0, 12));
	fr[0].set(c0, 1);
	let weight = 0;
	for (const bit of c0) weight ^= bit;
	fr[0][0] = weight;
	golay2312(fr[1], d.subarray(12, 24));
	let seed = 0;
	for (let i = 0; i < 12; i++) seed = (seed << 1) | d[i];
	const pr = prSequence(seed, 24);
	for (let j = 22, k = 1; j >= 0; j--, k++) fr[1][j] ^= pr[k];
	for (let i = 0; i < 11; i++) fr[2][10 - i] = d[24 + i];
	for (let i = 0; i < 14; i++) fr[3][13 - i] = d[35 + i];
	const bits = new Uint8Array(72);
	for (let j = 0; j < 36; j++) {
		bits[2 * j] = fr[DMR_W[j]][DMR_X[j]];
		bits[2 * j + 1] = fr[DMR_Y[j]][DMR_Z[j]];
	}
	return bits;
}

/** 88 IMBE 7200x4400 parameter bits (mbelib imbe_d order) -> the 144 channel bits of a P25 / Fusion voice FR frame. */
export function imbeEncode(d) {
	const fr = Array.from({ length: 8 }, () => new Uint8Array(23));
	for (let i = 0; i < 4; i++) golay2312(fr[i], d.subarray(12 * i, 12 * i + 12));
	for (let i = 0; i < 3; i++) hamming1511(fr[4 + i], d.subarray(48 + 11 * i, 59 + 11 * i));
	for (let i = 0; i < 7; i++) fr[7][6 - i] = d[81 + i];
	let seed = 0;
	for (let i = 0; i < 12; i++) seed = (seed << 1) | d[i];
	const pr = prSequence(seed, 115);
	let k = 1;
	for (let i = 1; i < 4; i++) for (let j = 22; j >= 0; j--) fr[i][j] ^= pr[k++];
	for (let i = 4; i < 7; i++) for (let j = 14; j >= 0; j--) fr[i][j] ^= pr[k++];
	const bits = new Uint8Array(144);
	for (let i = 0; i < 72; i++) {
		bits[2 * i] = fr[P25_IW[i]][P25_IX[i]];
		bits[2 * i + 1] = fr[P25_IY[i]][P25_IZ[i]];
	}
	return bits;
}

export function packBits(bits, nbytes) {
	const out = new Uint8Array(nbytes);
	for (let i = 0; i < bits.length; i++) if (bits[i]) out[i >> 3] |= 0x80 >> (i & 7);
	return out;
}

/** The real mbelib WASM of the app, run in Node. */
export async function loadMbelib() {
	const wasm = await readFile(new URL('../../../wasm/mbelib/pkg/mbelib.wasm', import.meta.url));
	const { default: factory } = await import('../../../wasm/mbelib/pkg/mbelib.js');
	const mbe = await import('@/worker/decoders/mbelib-init');
	await mbe.ensureMbelibInitialized((options) => factory({ ...options, wasmBinary: wasm }));
	return mbe;
}

function gaussian(rng) {
	let u = 0;
	while (u === 0) u = rng();
	return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

export function rngOf(seed) {
	let s = seed >>> 0 || 1;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 4294967296;
	};
}

/** Windowed-sinc low pass, as BrowSDR's DDC channel filter in front of the DSD stream. */
function lowpassTaps(cutoffHz, rate, n) {
	const taps = new Float32Array(n);
	const mid = (n - 1) / 2;
	let sum = 0;
	for (let k = 0; k < n; k++) {
		const t = k - mid;
		const x = (2 * cutoffHz * t) / rate;
		const sinc = t === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
		const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * k) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * k) / (n - 1));
		taps[k] = sinc * w;
		sum += taps[k];
	}
	return taps.map((v) => v / sum);
}

/**
 * Complex white noise for a carrier-to-noise ratio in the channel bandwidth, then the channel filter.
 * iq: interleaved I/Q at rate; a constant-envelope carrier of amplitude amp.
 */
export function channel(iq, { rate = 48000, cnrDb = 99, bandwidthHz = 12500, amp = 1, seed = 1 } = {}) {
	const out = new Float32Array(iq.length);
	const rng = rngOf(seed);
	const sigma = cnrDb >= 99 ? 0 : Math.sqrt(((amp * amp) / 10 ** (cnrDb / 10)) * (rate / bandwidthHz) * 0.5);
	for (let i = 0; i < iq.length; i++) out[i] = iq[i] + sigma * gaussian(rng);
	const taps = lowpassTaps(bandwidthHz / 2, rate, 63);
	const filtered = new Float32Array(out.length);
	for (let n = 0; n < out.length / 2; n++) {
		let re = 0;
		let im = 0;
		for (let k = 0; k < taps.length; k++) {
			const m = n - k;
			if (m < 0) break;
			re += taps[k] * out[2 * m];
			im += taps[k] * out[2 * m + 1];
		}
		filtered[2 * n] = re;
		filtered[2 * n + 1] = im;
	}
	return filtered;
}

/** Interleaved I/Q of an FM signal from its instantaneous frequency in Hz (NaN: no carrier). */
export function fmIq(freqHz, rate = 48000, amp = 1, phase0 = 0) {
	const iq = new Float32Array(freqHz.length * 2);
	let phase = phase0;
	for (let i = 0; i < freqHz.length; i++) {
		if (Number.isNaN(freqHz[i])) continue;
		phase = (phase + (2 * Math.PI * freqHz[i]) / rate) % (2 * Math.PI);
		iq[2 * i] = amp * Math.cos(phase);
		iq[2 * i + 1] = amp * Math.sin(phase);
	}
	return iq;
}

/** Interleaved I/Q of complex noise alone. */
export function noiseIq(samples, sigma, seed) {
	const rng = rngOf(seed);
	return Float32Array.from({ length: samples * 2 }, () => sigma * gaussian(rng));
}
