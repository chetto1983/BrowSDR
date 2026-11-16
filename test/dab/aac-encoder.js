// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir core/src/dab/dab_gen_aac.cpp (AacLcEncoder: AAC-LC with the 960
// transform, long blocks, sine window, one scale factor per channel; superframeLayout, buildSuperframe),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: bits are collected in a plain array; the Reed-Solomon
// encoder is the test transmitter's own (gen-coding.js).

import { cbIndex, cbInfo, SCALE_BITS, SCALE_CODE } from './aac-tables.js';
import { DrmFft } from './drm-fft.js';
import { fireCode, rsEncode } from './gen-coding.js';

const N = 960,
	W = 1920;
const PCM_SCALE = 32768;
// scale factor bands of the 960 transform at 48 kHz (and 32 kHz): 49 bands
// prettier-ignore
const SWB = [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 80, 88, 96, 108, 120, 132, 144, 160, 176, 196, 216, 240, 264, 292, 320,
	352, 384, 416, 448, 480, 512, 544, 576, 608, 640, 672, 704, 736, 768, 800, 832, 864, 896, 928, 960];
const NUM_SFB = 49;

const put = (bits, v, n) => {
	for (let i = n - 1; i >= 0; i--) bits.push(Math.floor(v / 2 ** i) & 1);
};

/** The bits of one code word (a pair or a quad): Huffman code, sign bits of an unsigned codebook, codebook 11 escapes. */
function unitBits(cb, v, out) {
	const ci = cbInfo(cb);
	const t = [];
	const esc = [0, 0];
	for (let i = 0; i < ci.dim; i++) t.push(ci.isSigned ? v[i] : Math.abs(v[i]));
	if (cb === 11)
		for (let i = 0; i < 2; i++)
			if (t[i] > 15) {
				esc[i] = t[i];
				t[i] = 16;
			}
	const idx = cbIndex(cb, t);
	put(out, ci.code[idx], ci.bits[idx]);
	if (!ci.isSigned) for (let i = 0; i < ci.dim; i++) if (v[i]) put(out, v[i] < 0 ? 1 : 0, 1);
	if (cb !== 11) return;
	for (let i = 0; i < 2; i++) {
		if (!esc[i]) continue;
		let nb = 4;
		while (esc[i] >> (nb + 1) !== 0) nb++;
		for (let k = 4; k < nb; k++) put(out, 1, 1);
		put(out, 0, 1);
		put(out, esc[i] - (1 << nb), nb);
	}
}

function unitLength(cb, v) {
	const ci = cbInfo(cb);
	const t = [];
	let escLen = 0;
	for (let i = 0; i < ci.dim; i++) t.push(ci.isSigned ? v[i] : Math.abs(v[i]));
	if (cb === 11)
		for (let i = 0; i < 2; i++)
			if (t[i] > 15) {
				let nb = 4;
				while (t[i] >> (nb + 1) !== 0) nb++;
				escLen += nb - 4 + 1 + nb;
				t[i] = 16;
			}
	let len = ci.bits[cbIndex(cb, t)] + escLen;
	if (!ci.isSigned) for (let i = 0; i < ci.dim; i++) if (v[i]) len++;
	return len;
}

/** AAC-LC encoder with the 960 transform (DAB+ uses frameLengthFlag = 1), long blocks only. */
export class AacLcEncoder {
	constructor(rate, channels) {
		this.rate = rate === 32000 ? 32000 : 48000;
		this.ch = channels === 1 ? 1 : 2;
		this.fft = new DrmFft(W);
		this.win = Float64Array.from({ length: W }, (_, n) => Math.sin((Math.PI * (n + 0.5)) / W));
		this.preR = Float64Array.from({ length: W }, (_, n) => Math.cos((-Math.PI * n) / W));
		this.preI = Float64Array.from({ length: W }, (_, n) => Math.sin((-Math.PI * n) / W));
		const n0 = (N + 1) / 2;
		this.postR = Float64Array.from({ length: N }, (_, k) => Math.cos((-2 * Math.PI * n0 * (k + 0.5)) / W));
		this.postI = Float64Array.from({ length: N }, (_, k) => Math.sin((-2 * Math.PI * n0 * (k + 0.5)) / W));
		this.prev = Array.from({ length: this.ch }, () => new Float64Array(N));
		this.spec = Array.from({ length: this.ch }, () => new Float64Array(N));
		this.yr = new Float64Array(W);
		this.yi = new Float64Array(W);
	}

	mdct(c, cur) {
		const pv = this.prev[c],
			yr = this.yr,
			yi = this.yi;
		for (let n = 0; n < W; n++) {
			const x = (n < N ? pv[n] : cur[n - N]) * this.win[n] * PCM_SCALE;
			yr[n] = this.preR[n] * x;
			yi[n] = this.preI[n] * x;
		}
		this.fft.forward(yr, yi);
		for (let k = 0; k < N; k++) this.spec[c][k] = 2 * (yr[k] * this.postR[k] - yi[k] * this.postI[k]);
		pv.set(cur);
	}

	/** The individual_channel_stream of channel c with global gain gg; null when a value is too large. */
	channelStream(c, gg) {
		const g = 2 ** ((gg - 100) / 4);
		const spec = this.spec[c];
		const q = new Int32Array(N);
		for (let i = 0; i < N; i++) {
			const v = Math.trunc(Math.abs(spec[i] / g) ** 0.75 + 0.4054);
			if (v > 8000) return null;
			q[i] = spec[i] < 0 ? -v : v;
		}
		let last = -1;
		for (let b = 0; b < NUM_SFB; b++) for (let i = SWB[b]; i < SWB[b + 1]; i++) if (q[i]) last = b;
		const maxSfb = last + 1;
		const cbOf = this.codebooks(q, maxSfb);
		const s = [];
		put(s, gg, 8);
		put(s, 0, 1); // ics_reserved_bit
		put(s, 0, 2); // ONLY_LONG_SEQUENCE
		put(s, 0, 1); // sine window
		put(s, maxSfb, 6);
		put(s, 0, 1); // predictor_data_present
		for (let b = 0; b < maxSfb;) {
			// section_data: codebook (4 bits) and length (5 bits, escape 31)
			let e = b;
			while (e < maxSfb && cbOf[e] === cbOf[b]) e++;
			put(s, cbOf[b], 4);
			let len = e - b;
			for (; len >= 31; len -= 31) put(s, 31, 5);
			put(s, len, 5);
			b = e;
		}
		// every scale factor equals the global gain: difference 0
		for (let b = 0; b < maxSfb; b++) if (cbOf[b]) put(s, SCALE_CODE[60], SCALE_BITS[60]);
		put(s, 0, 3); // pulse_data_present, tns_data_present, gain_control_data_present
		for (let b = 0; b < maxSfb; b++) {
			if (!cbOf[b]) continue;
			const dim = cbInfo(cbOf[b]).dim;
			for (let i = SWB[b]; i < SWB[b + 1]; i += dim) unitBits(cbOf[b], q.subarray(i, i + dim), s);
		}
		return s;
	}

	/** The cheapest codebook of every band (0 for a silent one). */
	codebooks(q, maxSfb) {
		const cbOf = new Array(NUM_SFB).fill(0);
		for (let b = 0; b < maxSfb; b++) {
			let mx = 0;
			for (let i = SWB[b]; i < SWB[b + 1]; i++) mx = Math.max(mx, Math.abs(q[i]));
			if (!mx) continue;
			let bestCb = 0,
				bestBits = Infinity;
			for (let cb = 1; cb <= 11; cb++) {
				const ci = cbInfo(cb);
				if (cb !== 11 && mx > ci.lav) continue;
				let bits = 0;
				for (let i = SWB[b]; i < SWB[b + 1]; i += ci.dim) bits += unitLength(cb, q.subarray(i, i + ci.dim));
				if (bits < bestBits) {
					bestBits = bits;
					bestCb = cb;
				}
			}
			cbOf[b] = bestCb;
		}
		return cbOf;
	}

	/** The smallest global gain (finest quantiser) whose channel stream fits in `bits`. */
	fit(c, bits) {
		const fits = (gg) => {
			const s = this.channelStream(c, gg);
			return s && s.length <= bits ? s : null;
		};
		let lo = 40,
			hi = 255;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (fits(mid)) hi = mid;
			else lo = mid + 1;
		}
		// the bisection assumes monotonic sizes: step up until it fits
		for (let gg = lo; gg <= 255; gg++) {
			const s = fits(gg);
			if (s) return s;
		}
		return null;
	}

	/**
	 * pcm: the next 960 samples per channel, interleaved, +-1.0 full scale. Produces the raw_data_block of the block before
	 * this one overlapped with this one, padded with zero bytes to exactly budgetBytes.
	 */
	encode(pcm, budgetBytes) {
		const one = new Float64Array(N);
		for (let c = 0; c < this.ch; c++) {
			for (let i = 0; i < N; i++) one[i] = pcm[i * this.ch + c];
			this.mdct(c, one);
		}
		const total = budgetBytes * 8;
		// single_channel_element: id 0, instance tag; channel_pair_element: id 1, tag, common_window = 0; then ID_END
		const head = (out) => {
			put(out, this.ch === 1 ? 0 : 1, 3);
			put(out, 0, 4);
			if (this.ch === 2) put(out, 0, 1);
		};
		let out = [];
		head(out);
		let left = total - out.length - 3;
		for (let c = 0; c < this.ch && out; c++) {
			const s = this.fit(c, c === this.ch - 1 ? left : Math.floor(left / this.ch));
			if (s) {
				left -= s.length;
				out.push(...s);
			} else out = null;
		}
		if (!out) {
			// nothing fits: a block without bands
			out = [];
			head(out);
			for (let c = 0; c < this.ch; c++) [100, 0, 0, 0, 0, 0, 0, 0, 0].forEach((v, i) => put(out, v, [8, 1, 2, 1, 6, 1, 1, 1, 1][i]));
		}
		put(out, 7, 3); // ID_END
		const block = new Uint8Array(budgetBytes);
		for (let i = 0; i < out.length && i < total; i++) if (out[i]) block[i >> 3] |= 0x80 >> (i & 7);
		return block;
	}
}

/** The first access unit's start and the length of every access unit (with its CRC) of a DAB+ superframe. */
export function superframeLayout(bitrate, nAu) {
	const n = bitrate / 8;
	const firstStart = 3 + Math.floor((12 * (nAu - 1) + 7) / 8);
	const avail = 110 * n - firstStart;
	const auLen = new Array(nAu).fill(Math.floor(avail / nAu));
	auLen[nAu - 1] = avail - (nAu - 1) * Math.floor(avail / nAu);
	return { firstStart, auLen };
}

/** A DAB+ superframe of `aus` (each with its CRC): the 120 * N bytes in the order they are transmitted. */
export function buildSuperframe(aus, bitrate, dac48, stereo) {
	const n = bitrate / 8,
		nAu = aus.length;
	const pay = new Uint8Array(110 * n);
	const { firstStart } = superframeLayout(bitrate, nAu);
	pay[2] = (dac48 ? 0x40 : 0) | (stereo ? 0x10 : 0); // rfa, dac_rate, sbr_flag 0, aac_channel_mode, ps_flag 0, surround 0
	let pos = firstStart;
	for (let k = 0; k < nAu; k++) {
		if (k > 0) {
			// au_start[k], 12 bits each, from byte 3
			const bit = 12 * (k - 1),
				byte = 3 + (bit >> 3);
			if (bit % 8 === 0) {
				pay[byte] = pos >> 4;
				pay[byte + 1] = (pay[byte + 1] & 0x0f) | ((pos & 15) << 4);
			} else {
				pay[byte] = (pay[byte] & 0xf0) | (pos >> 8);
				pay[byte + 1] = pos & 0xff;
			}
		}
		pay.set(aus[k], pos);
		pos += aus[k].length;
	}
	const fc = fireCode(pay.subarray(2), 9);
	pay[0] = fc >> 8;
	pay[1] = fc & 0xff;
	// N RS(120,110) code words, byte interleaved: code word i holds the payload bytes i, i + N, i + 2N ...
	const sf = new Uint8Array(120 * n);
	const data = new Uint8Array(110),
		cw = new Uint8Array(120);
	for (let i = 0; i < n; i++) {
		for (let j = 0; j < 110; j++) data[j] = pay[j * n + i];
		rsEncode(data, cw);
		for (let j = 0; j < 120; j++) sf[j * n + i] = cw[j];
	}
	return sf;
}
