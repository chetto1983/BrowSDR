// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir core/src/dab/dab_gen.cpp (the DAB test transmitter: testSound,
// frequencyInterleaver, phaseReferenceSymbol, Transmitter::Impl buildAac / codeFrame / fig00 / fig01 / fig02 / figLabel /
// makeFibs / makeSymbols / nextFrame, and DabSynth's noise, carrier offset and clipping), https://github.com/adswill/OnAir;
// see third_party/onair. Changes: no MP2 encoder, so a DAB (MP2) service carries pseudo-random frames; no melody, slide
// show, DMB, TII, FIG 0/7, 0/10, 0/13, 0/17-0/19 or FIG 2; the output is complex baseband at 2.048 MS/s only (no sample
// clock error); the noise is a seeded Gaussian generator.

import { Fft } from '@/worker/decoders/dab/ofdm/fft';
import { puncture, subchannelProfile, uepGeometry } from '@/worker/decoders/dab/fec/puncture';
import { AacLcEncoder, buildSuperframe, superframeLayout } from './aac-encoder.js';
import { convEncode, crc16, eepSize, prbs, punctureEep, punctureFic, scramble } from './gen-coding.js';
import { dlsDse } from './gen-pad.js';

export const RATE = 2048000;
const TU = 2048,
	TG = 504,
	TS = 2552,
	TNULL = 2656,
	SYMBOLS = 76,
	CARRIERS = 1536,
	FRAME = 196608,
	CIF_BITS = 55296;
const floorMod = (a, b) => ((a % b) + b) % b;
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
const lcm = (a, b) => (a / gcd(a, b)) * b;

/** Sample i of channel ch of a service's test tones (a pure function of i, periodic with the 12 s loop). */
export function testSound(sv, ch, i) {
	const n = floorMod(i, 12 * sv.sampleRate);
	const f = ch ? sv.rightHz : sv.leftHz;
	return sv.amplitude * Math.sin((2 * Math.PI * ((f * n) % sv.sampleRate)) / sv.sampleRate);
}

/** Carrier number k (-768..768) of the n-th QPSK symbol of an OFDM symbol (EN 300 401 clause 14.6.1). */
const FREQ_INTERLEAVER = (() => {
	const out = [];
	for (let i = 0, p = 0; i < TU; i++) {
		if (i) p = (13 * p + 511) % TU;
		if (p >= 256 && p <= 1792 && p !== 1024) out.push(p - 1024);
	}
	return out;
})();

/** The phase reference symbol (clause 14.3.2) as a phase index 0..3 per bin (bin = k mod 2048), -1 for an empty bin. */
const PHASE_REF = (() => {
	const h = [
		[0, 2, 0, 0, 0, 0, 1, 1, 2, 0, 0, 0, 2, 2, 1, 1, 0, 2, 0, 0, 0, 0, 1, 1, 2, 0, 0, 0, 2, 2, 1, 1],
		[0, 3, 2, 3, 0, 1, 3, 0, 2, 1, 2, 3, 2, 3, 3, 0, 0, 3, 2, 3, 0, 1, 3, 0, 2, 1, 2, 3, 2, 3, 3, 0],
		[0, 0, 0, 2, 0, 2, 1, 3, 2, 2, 0, 2, 2, 0, 1, 3, 0, 0, 0, 2, 0, 2, 1, 3, 2, 2, 0, 2, 2, 0, 1, 3],
		[0, 1, 2, 1, 0, 3, 3, 2, 2, 3, 2, 1, 2, 1, 3, 2, 0, 1, 2, 1, 0, 3, 3, 2, 2, 3, 2, 1, 2, 1, 3, 2],
	];
	// table 23: carriers kmin .. kmin + 31, row index i, parameter n
	// prettier-ignore
	const rows = [
		[-768, 0, 1], [-736, 1, 2], [-704, 2, 0], [-672, 3, 1], [-640, 0, 3], [-608, 1, 2], [-576, 2, 2], [-544, 3, 3],
		[-512, 0, 2], [-480, 1, 1], [-448, 2, 2], [-416, 3, 3], [-384, 0, 1], [-352, 1, 2], [-320, 2, 3], [-288, 3, 3],
		[-256, 0, 2], [-224, 1, 2], [-192, 2, 2], [-160, 3, 1], [-128, 0, 1], [-96, 1, 3], [-64, 2, 1], [-32, 3, 2],
		[1, 0, 3], [33, 3, 1], [65, 2, 1], [97, 1, 1], [129, 0, 2], [161, 3, 2], [193, 2, 1], [225, 1, 0],
		[257, 0, 2], [289, 3, 2], [321, 2, 3], [353, 1, 3], [385, 0, 0], [417, 3, 2], [449, 2, 1], [481, 1, 3],
		[513, 0, 3], [545, 3, 3], [577, 2, 3], [609, 1, 0], [641, 0, 3], [673, 3, 0], [705, 2, 1], [737, 1, 1],
	];
	const z = new Int8Array(TU).fill(-1);
	for (const [k0, i, n] of rows) for (let j = 0; j < 32; j++) z[(k0 + j + TU) % TU] = (h[i][j] + n) & 3;
	return z;
})();

/** The number of 960-sample blocks after which both tones repeat. */
function toneFrames(sv) {
	let per = 1;
	for (const f of [sv.leftHz, sv.rightHz]) per = lcm(per, sv.sampleRate / gcd(sv.sampleRate, f));
	return lcm(per, 960) / 960;
}

/** The access units (without CRC) and the logical frames of a DAB+ service's loop. */
function buildAac(sv) {
	const nAu = sv.sampleRate === 48000 ? 6 : 4;
	const K = toneFrames(sv);
	const Kp = lcm(K, nAu);
	const { auLen } = superframeLayout(sv.bitrate, nAu);
	const enc = new AacLcEncoder(sv.sampleRate, 2);
	const pcm = new Float64Array(960 * 2);
	const block = (j) => {
		for (let i = 0; i < 960; i++) for (let c = 0; c < 2; c++) pcm[i * 2 + c] = testSound(sv, c, floorMod(j, K) * 960 + i);
	};
	const dse = sv.dls ? dlsDse(Kp, sv.dls) : [];
	block(Kp - 1); // the block before the loop starts (the loop is periodic)
	enc.encode(pcm, auLen[0] - 2);
	const withCrc = [];
	for (let j = 0; j < Kp; j++) {
		block(j);
		const budget = auLen[j % nAu] - 2;
		const pad = dse[j] ?? new Uint8Array(0); // the PAD takes its bytes from the audio
		const raw = new Uint8Array(budget + 2);
		raw.set(pad);
		raw.set(enc.encode(pcm, budget - pad.length), pad.length);
		const crc = crc16(raw, budget);
		raw[budget] = crc >> 8;
		raw[budget + 1] = crc & 0xff;
		withCrc.push(raw);
	}
	const frames = [];
	const fb = sv.bitrate * 3;
	for (let sf = 0; sf < Kp / nAu; sf++) {
		const bytes = buildSuperframe(withCrc.slice(sf * nAu, (sf + 1) * nAu), sv.bitrate, sv.sampleRate === 48000, true);
		for (let q = 0; q < 5; q++) frames.push(bytes.slice(q * fb, (q + 1) * fb));
	}
	return { aus: withCrc.map((a) => a.slice(0, a.length - 2)), frames };
}

/** A DAB (MP2) service without an encoder: 25 pseudo-random logical frames, repeated. */
function noiseFrames(sv) {
	let x = sv.sid * 2654435761;
	return Array.from({ length: 25 }, () =>
		Uint8Array.from({ length: sv.bitrate * 3 }, () => {
			x = (Math.imul(x, 1103515245) + 12345) >>> 0;
			return x >>> 24;
		}),
	);
}

function subSize(sv) {
	if (sv.uepIndex < 0) return eepSize(sv.bitrate, sv.option, sv.level);
	const g = uepGeometry(sv.uepIndex);
	return g && g.bitrate === sv.bitrate ? g.size : 0;
}

/** Energy dispersal, convolutional code and puncturing of one logical frame (UEP through the receiver's table, as OnAir). */
function codeFrame(sv, bytes) {
	const info = bytes.length * 8;
	const bits = new Uint8Array(info);
	for (let i = 0; i < info; i++) bits[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
	scramble(bits, info);
	const mother = convEncode(bits, info);
	if (sv.uepIndex < 0) return punctureEep(mother, sv.bitrate, sv.option, sv.level);
	const profile = subchannelProfile(false, 0, 0, 0, sv.uepIndex);
	const out = new Uint8Array(profile.bits);
	puncture(profile, mother, out);
	return out;
}

const SERVICE_DEFAULTS = {
	sampleRate: 48000,
	leftHz: 1000,
	rightHz: 3000,
	amplitude: 0.5,
	option: 0,
	level: 2,
	uepIndex: -1,
	dabPlus: true,
};

/** The test transmitter: a complete DAB mode I signal carrying a small ensemble. */
export class Transmitter {
	constructor(cfg) {
		this.cfg = { ensembleLabel: 'BrowSDR Test', eid: 0xce15, ...cfg };
		this.subs = [];
		let start = 0;
		for (const s of cfg.services) {
			const sv = { ...SERVICE_DEFAULTS, ...s };
			const size = subSize(sv);
			if (!size || start + size > 864) continue;
			const built = sv.dabPlus ? buildAac(sv) : { aus: [], frames: noiseFrames(sv) };
			const coded = built.frames.map((f) => codeFrame(sv, f));
			this.subs.push({ sv, start, size, aus: built.aus, frames: built.frames, coded });
			start += size;
		}
		this.fft = new Fft(TU);
		this.frame = 0;
		this.fill = prbs(511);
	}

	fig(type, body) {
		return [(type << 5) | body.length, ...body];
	}

	fig00(cif) {
		const c = cif % 5000;
		// change flags 00, alarm flag 0, CIF count high (0..19) and low (0..249)
		return this.fig(0, [0x00, this.cfg.eid >> 8, this.cfg.eid & 0xff, Math.floor(c / 250), c % 250]);
	}

	/** Sub-channel organisation: long form (EEP) or short form (UEP, table switch 0), 7 per FIG. */
	fig01() {
		const out = [];
		for (let i = 0; i < this.subs.length; i += 7) {
			const b = [0x01];
			for (const { sv, start, size } of this.subs.slice(i, i + 7)) {
				b.push((sv.subId << 2) | (start >> 8), start & 0xff);
				if (sv.uepIndex >= 0) b.push(sv.uepIndex);
				else b.push(0x80 | (sv.option << 4) | (sv.level << 2) | (size >> 8), size & 0xff);
			}
			out.push(this.fig(0, b));
		}
		return out;
	}

	/** Service organisation: one audio stream component per service (ASCTy 63 for DAB+), primary, 5 per FIG. */
	fig02() {
		const out = [];
		for (let i = 0; i < this.subs.length; i += 5) {
			const b = [0x02];
			for (const { sv } of this.subs.slice(i, i + 5)) b.push(sv.sid >> 8, sv.sid & 0xff, 0x01, sv.dabPlus ? 63 : 0, (sv.subId << 2) | 0x02);
			out.push(this.fig(0, b));
		}
		return out;
	}

	/** FIG 1/0 (idx 0, the ensemble) or 1/1 (the services): 16 characters, the first 8 make the short label. */
	figLabel(idx) {
		const [ext, id, text] =
			idx === 0 ? [0, this.cfg.eid, this.cfg.ensembleLabel] : [1, this.subs[idx - 1].sv.sid, this.subs[idx - 1].sv.label];
		const b = [ext, id >> 8, id & 0xff];
		for (let i = 0; i < 16; i++) b.push(i < text.length ? text.charCodeAt(i) : 0x20);
		b.push(0xff, 0x00);
		return this.fig(1, b);
	}

	/** The 12 FIBs (32 bytes each, CRC included) of frame m. */
	fibs(m) {
		const fib = Array.from({ length: 12 }, () => []);
		const place = (from, f) => {
			for (let i = from; i < 12; i++)
				if (fib[i].length + f.length <= 30) {
					fib[i].push(...f);
					return;
				}
		};
		place(0, this.fig00(4 * m));
		for (const f of this.fig01()) place(1, f);
		for (const f of this.fig02()) place(1, f);
		const nl = this.subs.length + 1;
		for (let k = 0; k < 3; k++) place(1, this.figLabel((m * 3 + k) % nl));
		return fib.map((f) => {
			const out = new Uint8Array(32);
			out.set(f);
			if (f.length < 30) out[f.length] = 0xff;
			const c = crc16(out, 30);
			out[30] = c >> 8;
			out[31] = c & 0xff;
			return out;
		});
	}

	/** The 75 x 3072 bits of the data symbols of frame m: the FIC, then the 4 CIFs of the MSC. */
	frameBits(m) {
		const bits = new Uint8Array(75 * 3072);
		const fibs = this.fibs(m);
		for (let c = 0; c < 4; c++) {
			// the FIC: 3 FIBs per CIF, scrambled, coded, punctured
			const inBits = new Uint8Array(768);
			for (let i = 0; i < 768; i++) inBits[i] = (fibs[3 * c + (i >> 8)][(i >> 3) & 31] >> (7 - (i & 7))) & 1;
			scramble(inBits, 768);
			bits.set(punctureFic(convEncode(inBits, 768)), c * 2304);
		}
		const delay = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15]; // table 21
		for (let c = 0; c < 4; c++) {
			const n = 4 * m + c;
			const cif = 3 * 3072 + c * CIF_BITS;
			// capacity not used by a service: noise-like padding
			for (let i = 0; i < CIF_BITS; i++) bits[cif + i] = this.fill[(i + 37 * (n % 511)) % 511];
			for (const s of this.subs) {
				const dst = cif + s.start * 64;
				// logical frames n - 0 .. n - 15
				const src = Array.from({ length: 16 }, (_, d) => s.coded[floorMod(n - d, s.coded.length)]);
				for (let i = 0; i < s.size * 64; i++) bits[dst + i] = src[delay[i & 15]][i];
			}
		}
		return bits;
	}

	/** The next transmission frame: 196608 samples (null symbol first), rms 0.2 over the active symbols, interleaved. */
	nextFrame() {
		const bits = this.frameBits(this.frame++);
		const out = new Float32Array(2 * FRAME);
		const re = new Float64Array(TU),
			im = new Float64Array(TU);
		const zr = new Float64Array(TU),
			zi = new Float64Array(TU);
		const scale = 0.2 / Math.sqrt(CARRIERS);
		const r = Math.SQRT1_2;
		const unit = [
			[1, 0],
			[0, 1],
			[-1, 0],
			[0, -1],
		];
		for (let k = 0; k < TU; k++) if (PHASE_REF[k] >= 0) [zr[k], zi[k]] = unit[PHASE_REF[k]];
		for (let l = 0; l < SYMBOLS; l++) {
			if (l > 0) {
				// DQPSK: every symbol is the one before times the QPSK symbol of its bits
				const p = (l - 1) * 3072;
				for (let n = 0; n < CARRIERS; n++) {
					const b = (FREQ_INTERLEAVER[n] + TU) % TU;
					const qr = r * (1 - 2 * bits[p + n]),
						qi = r * (1 - 2 * bits[p + n + CARRIERS]);
					const t = zr[b] * qr - zi[b] * qi;
					zi[b] = zr[b] * qi + zi[b] * qr;
					zr[b] = t;
				}
			}
			re.set(zr);
			im.set(zi);
			this.fft.inverse(re, im);
			const dst = 2 * (TNULL + l * TS);
			for (let i = 0; i < TS; i++) {
				const j = (i + TU - TG) % TU; // the guard interval repeats the end of the symbol
				out[dst + 2 * i] = re[j] * scale;
				out[dst + 2 * i + 1] = im[j] * scale;
			}
		}
		return out;
	}
}

/** Seeded Gaussian noise (mulberry32 and Box-Muller): fills `out` with independent N(0, 1) values. */
function gaussian(seed) {
	let s = seed >>> 0;
	const uniform = () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return (out) => {
		for (let i = 0; i < out.length; i += 2) {
			const g = Math.sqrt(-2 * Math.log(uniform() + 1e-12)),
				a = 2 * Math.PI * uniform();
			out[i] = g * Math.cos(a);
			out[i + 1] = g * Math.sin(a);
		}
	};
}

/**
 * The transmitter's signal as a receiver hears it: noise for `snrDb` (carrier to noise power in the 2.048 MHz band),
 * a carrier offset of `cfoHz`, the rare OFDM peaks clipped at 0.9.
 */
export class DabSignal {
	constructor(cfg, { snrDb = 200, cfoHz = 0, seed = 1 } = {}) {
		this.tx = new Transmitter(cfg);
		this.sigma = snrDb >= 90 ? 0 : Math.sqrt((0.04 * 10 ** (-snrDb / 10)) / 2);
		this.dph = (2 * Math.PI * cfoHz) / RATE;
		this.noise = gaussian(seed);
		this.count = 0;
		this.cur = new Float32Array(0);
		this.pos = 0;
	}

	/** The next n samples (interleaved I/Q). */
	generate(n) {
		const out = new Float32Array(2 * n);
		for (let w = 0; w < 2 * n;) {
			if (this.pos >= this.cur.length) {
				this.cur = this.tx.nextFrame();
				this.pos = 0;
			}
			const take = Math.min(2 * n - w, this.cur.length - this.pos);
			out.set(this.cur.subarray(this.pos, this.pos + take), w);
			w += take;
			this.pos += take;
		}
		const g = new Float64Array(2 * n);
		if (this.sigma) this.noise(g);
		// the carrier offset: the phasor of the block start computed exactly, then turned sample by sample
		let pr = Math.cos((this.dph * this.count) % (2 * Math.PI)),
			pi = Math.sin((this.dph * this.count) % (2 * Math.PI));
		const sr = Math.cos(this.dph),
			si = Math.sin(this.dph);
		for (let i = 0; i < n; i++) {
			const a = out[2 * i] + this.sigma * g[2 * i],
				b = out[2 * i + 1] + this.sigma * g[2 * i + 1];
			let x = a * pr - b * pi,
				y = a * pi + b * pr;
			const t = pr * sr - pi * si;
			pi = pr * si + pi * sr;
			pr = t;
			const p = x * x + y * y;
			if (p > 0.81) {
				const k = 0.9 / Math.sqrt(p);
				x *= k;
				y *= k;
			}
			out[2 * i] = x;
			out[2 * i + 1] = y;
		}
		this.count += n;
		return out;
	}
}
