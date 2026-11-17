// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir core/src/inmc/inmc_gen.cpp (InmcFrameSource, the RRC modulator Gen)
// and core/src/inmc/inmc_pkt.cpp (buildBulletinBoard, buildSignalling, buildEgc), https://github.com/adswill/OnAir; see
// third_party/onair. Changes: a seeded xorshift generator in place of std::mt19937 (other message numbers and address
// bytes than OnAir's), Gaussian noise by Box-Muller; the number of EGC packets per frame is an option (OnAir sends up to
// three) so that a test hears the whole loop in fewer frames; the signal comes out in blocks of complex float samples.
//
// The NCS common channel of the Indian Ocean Region: continuous BPSK at 1200 symbols/s (root raised cosine, roll-off 1),
// frames of 8.64 s with the unique word, interleaver, rate 1/2 code and scrambler. Every frame starts with a bulletin board
// packet (the frame number grows by one) and a signalling channel packet, followed by EGC packets of a loop of five
// messages: a NAVAREA IX warning, a METAREA IX gale warning, a SAR notice, a long weather forecast and a FleetNET message in
// ITA2. The text is made up.

import { encodeFrame, FRAME_BYTES, FRAME_SYMS, packetCheckSet, SYMBOL_RATE } from '@/worker/decoders/digimode/inmarsat-c/code';
import { addressLength, textToIta2 } from '@/worker/decoders/digimode/inmarsat-c/tables';

/** Seeded uniform numbers in [0, 2^32). */
export function xorshift(seed) {
	let x = (seed * 2654435761) >>> 0 || 1;
	return () => {
		x ^= x << 13;
		x >>>= 0;
		x ^= x >>> 17;
		x ^= x << 5;
		return (x >>>= 0);
	};
}

/**
 * Seeded normal numbers of unit variance, low-pass filtered to `bandHz` of `rate` when both are given (as after BrowSDR's
 * channel filter); white otherwise.
 */
export function bandNoise(seed, rate, bandHz) {
	const white = gaussian(seed);
	if (!bandHz || bandHz >= rate) return white;
	const fc = bandHz / 2 / rate;
	const taps = Array.from({ length: 63 }, (_, i) => {
		const t = i - 31;
		const sinc = t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t);
		return sinc * (0.42 - 0.5 * Math.cos((2 * Math.PI * i) / 62) + 0.08 * Math.cos((4 * Math.PI * i) / 62));
	});
	const sum = taps.reduce((a, v) => a + v, 0);
	const h = taps.map((v) => v / sum);
	const gain = 1 / Math.sqrt(h.reduce((a, x) => a + x * x, 0)); // unit variance: the density of `rate / bandHz` white noise in the band
	const line = new Float64Array(126);
	let at = 0;
	return () => {
		line[at] = line[at + 63] = white();
		at = at === 62 ? 0 : at + 1;
		let v = 0;
		for (let k = 0; k < 63; k++) v += h[k] * line[at + k];
		return v * gain;
	};
}

/** Seeded standard normal numbers. */
export function gaussian(seed) {
	const u = xorshift(seed);
	let spare = null;
	return () => {
		if (spare !== null) {
			const s = spare;
			spare = null;
			return s;
		}
		const a = (u() + 1) / 4294967297,
			b = u() / 4294967296;
		const r = Math.sqrt(-2 * Math.log(a));
		spare = r * Math.sin(2 * Math.PI * b);
		return r * Math.cos(2 * Math.PI * b);
	};
}

// ---------------------------------------------------------------- packet builders (inmc_pkt.cpp)

export function buildBulletinBoard({
	networkVersion = 1,
	frameNo = 0,
	signallingChannel = 0,
	count = 0,
	channelType = 1,
	local = 0,
	sat = 3,
	les = 44,
	status = 0x70,
	services = 0xe001,
	randomInterval = 8,
} = {}) {
	const p = new Uint8Array(14);
	p[0] = 0x7d;
	p[1] = networkVersion;
	p[2] = (frameNo >> 8) & 0xff;
	p[3] = frameNo & 0xff;
	p[4] = signallingChannel << 2;
	p[5] = ((count / 2) & 15) << 4;
	p[6] = (channelType << 5) | ((local & 7) << 2);
	p[7] = (sat << 6) | (les & 63);
	p[8] = status;
	p[9] = services >> 8;
	p[10] = services & 0xff;
	p[11] = randomInterval;
	packetCheckSet(p, 14);
	return p;
}

export function buildSignalling(servicesByte, uplinkMhz, slots) {
	const p = new Uint8Array(13);
	p[0] = 0x6c;
	p[1] = servicesByte;
	const ch = Math.round((uplinkMhz - 1626.5) / 0.0025) + 6000;
	p[2] = ch >> 8;
	p[3] = ch & 0xff;
	for (let i = 0; i < 28; i++) p[4 + (i >> 2)] |= (slots[i] & 3) << (6 - 2 * (i % 4));
	packetCheckSet(p, 13);
	return p;
}

export function buildEgc({
	desc = 0xb1,
	service = 0x31,
	continuation = false,
	priority = 1,
	repetition = 0,
	msgId = 0,
	packetNo = 1,
	presentation = 0,
	address = [],
	payload = [],
}) {
	const al = addressLength(service);
	const len = 8 + al + payload.length + 2;
	const p = new Uint8Array(len);
	p[0] = desc;
	p[1] = len - 2;
	p[2] = service;
	p[3] = (continuation ? 0x80 : 0) | ((priority & 3) << 5) | (repetition & 31);
	p[4] = msgId >> 8;
	p[5] = msgId & 0xff;
	p[6] = packetNo;
	p[7] = presentation;
	for (let i = 0; i < al && i < address.length; i++) p[8 + i] = address[i];
	p.set(payload, 8 + al);
	packetCheckSet(p, len);
	return p;
}

/** A text cut into EGC packets of `chunk` bytes: 0xB1 first, then 0xB2 and 0xB1 in turn. */
export function egcPackets({ service = 0x31, msgId, text, chunk = 48, priority = 1, presentation = 0, address }) {
	const raw = presentation === 6 ? textToIta2(text) : [...text].map((c) => c.charCodeAt(0));
	const n = Math.ceil(raw.length / chunk);
	const addr = address ?? new Array(addressLength(service)).fill(0x11);
	return Array.from({ length: n }, (_, i) => ({
		desc: i % 2 ? 0xb2 : 0xb1,
		service,
		continuation: i + 1 < n,
		priority,
		msgId,
		packetNo: i + 1,
		presentation,
		address: addr,
		payload: raw.slice(i * chunk, (i + 1) * chunk),
	}));
}

/** A frame of the given packets, zero filled. */
export function frameOf(packets) {
	const f = new Uint8Array(FRAME_BYTES);
	let at = 0;
	for (const p of packets) {
		f.set(p, at);
		at += p.length;
	}
	return f;
}

// ---------------------------------------------------------------- the loop of messages (InmcFrameSource)

const LOOP = [
	[
		0x31,
		1,
		0,
		'NAVAREA IX 231/26\r\nPERSIAN GULF.\r\nSTRAIT OF HORMUZ.\r\nTRAFFIC SEPARATION SCHEME OFF RAS AL KHAIMAH.\r\nDREDGING OPERATIONS IN PROGRESS WITHIN 2 MILES OF 25-34.2N 056-24.6E. VESSELS REQUESTED TO KEEP CLEAR AND PASS AT SLOW SPEED.\r\nCANCEL THIS MESSAGE 15 DAYS AFTER DATE OF ISSUE.\r\n',
		9,
	],
	[
		0x31,
		1,
		0,
		'METAREA IX\r\nGALE WARNING 118/26\r\nNORTHERLY WINDS 7 TO 8 BEAUFORT EXPECTED IN THE GULF OF OMAN AND THE STRAIT OF HORMUZ WITHIN 24 HOURS. SEA ROUGH TO VERY ROUGH. VISIBILITY REDUCED IN BLOWING DUST.\r\n',
		9,
	],
	[
		0x34,
		2,
		0,
		'SAR COORDINATION\r\nMRCC MUSCAT\r\nDHOW REPORTED OVERDUE ON PASSAGE FROM SUR TO KARACHI WITH 6 PERSONS ON BOARD. LAST KNOWN POSITION 22-10N 060-05E. ALL SHIPS IN THE AREA ARE REQUESTED TO KEEP A SHARP LOOKOUT AND REPORT ANY SIGHTING TO MRCC MUSCAT.\r\n',
		4,
	],
	[
		0x31,
		0,
		0,
		'METAREA IX\r\nFORECAST FOR THE GULF OF OMAN AND THE ARABIAN SEA VALID 24 HOURS.\r\nGULF OF OMAN: NORTHEAST WINDS 15 TO 20 KNOTS, BECOMING NORTH 20 TO 25 KNOTS IN THE EVENING. SEAS 6 TO 8 FEET. HAZE, VISIBILITY 3 TO 5 NM.\r\nNORTHERN ARABIAN SEA: SOUTHWEST WINDS 20 TO 25 KNOTS WITH GUSTS TO 30 KNOTS. SEAS 8 TO 10 FEET, SWELL 7 FEET FROM THE SOUTHWEST. SCATTERED SHOWERS AND ISOLATED THUNDERSTORMS NEAR THE COAST OF PAKISTAN.\r\nOUTLOOK: WINDS EASING DURING THE NEXT 48 HOURS.\r\n',
		9,
	],
	[0x02, 0, 6, 'FLEETNET OPERATIONS BULLETIN 14. NO REPLY REQUIRED. PORT CALL SCHEDULE FOR DUBAI AND FUJAIRAH UNCHANGED.\r\n', 0],
];

/** The frames of the test channel; `messages` is what the loop sends (the receiver drops carriage returns). */
export class InmcFrameSource {
	constructor({ seed = 1, firstFrame = 1000, les = 44, channelType = 1, perFrame = 3 } = {}) {
		const rng = xorshift(seed * 7919 + 17);
		this.frame = firstFrame;
		this.les = les;
		this.channelType = channelType;
		this.perFrame = perFrame;
		const lesByte = (3 << 6) | (les === 44 ? 4 : les); // IOR and a station: the guess for the first address byte
		this.messages = LOOP.map(([service, priority, presentation, text, areaByte]) => {
			const address = new Array(addressLength(service)).fill(0);
			address[0] = lesByte;
			if (address.length > 1) address[1] = areaByte;
			for (let i = 2; i < address.length; i++) address[i] = rng() & 0x7f;
			return { id: 1000 + (rng() % 8000), service, priority, presentation, address, text };
		});
		this.packets = this.messages.flatMap((m) =>
			egcPackets({ ...m, msgId: m.id, chunk: 48 }).map((p) => buildEgc({ ...p, address: m.address, repetition: 0 })),
		);
		this.cursor = 0;
	}

	/** The next frame's 640 bytes. */
	next() {
		const slots = Array.from({ length: 28 }, (_, i) => (i + this.frame) & 3);
		const parts = [
			buildBulletinBoard({ frameNo: this.frame & 0xffff, les: this.les, channelType: this.channelType }),
			buildSignalling(0xe0, 1626.5 + 0.0025 * 120, slots),
		];
		let used = parts.reduce((n, p) => n + p.length, 0);
		for (let k = 0; k < this.perFrame; k++) {
			const p = this.packets[this.cursor];
			if (used + p.length > FRAME_BYTES - 1) break;
			parts.push(p);
			used += p.length;
			this.cursor = (this.cursor + 1) % this.packets.length;
		}
		this.frame++;
		return frameOf(parts);
	}
}

// ---------------------------------------------------------------- the modulator (Gen)

const SPS = 40;
const SPAN = 4;
const BASE_RATE = 48000;

function rrc(t) {
	if (Math.abs(t) < 1e-9) return 4 / Math.PI;
	if (Math.abs(Math.abs(4 * t) - 1) < 1e-9)
		return (1 / Math.SQRT2) * ((1 + 2 / Math.PI) * Math.sin(Math.PI / 4) + (1 - 2 / Math.PI) * Math.cos(Math.PI / 4));
	return (4 * t * Math.cos(2 * Math.PI * t)) / (Math.PI * t * (1 - 16 * t * t));
}

/**
 * The test signal at `rate`: the channel at `offsetHz` + `cfoHz` (+ `driftHzS` per second), Eb/N0 `ebn0Db` with the noise
 * in the whole sampled band (none when `noiseless`; only in `noiseBandHz` around 0 Hz when given, as BrowSDR's channel
 * filter leaves it), total rms `rms`; `invert` sends the symbols turned over.
 */
export class InmcSignal {
	constructor({
		rate = 96000,
		seed = 1,
		ebn0Db = 10,
		noiseless = false,
		cfoHz = 0,
		driftHzS = 0,
		offsetHz = 0,
		invert = false,
		rms = 0.2,
		noiseBandHz = 0,
		...source
	} = {}) {
		this.source = new InmcFrameSource({ seed, ...source });
		this.rate = rate;
		this.invert = invert;
		this.freq = offsetHz + cfoHz;
		this.drift = driftHzS;
		this.g = Float64Array.from({ length: 2 * SPAN * SPS + 1 }, (_, i) => rrc((i - SPAN * SPS) / SPS));
		const ps = this.g.reduce((a, v) => a + v * v, 0) / SPS;
		const esn0 = 10 ** ((ebn0Db - 10 * Math.log10(2)) / 10);
		const n0 = noiseless ? 0 : ps / SYMBOL_RATE / esn0;
		const pn = n0 * (noiseBandHz || rate);
		this.scale = rms / Math.sqrt(ps + pn);
		this.sigma = Math.sqrt(pn / 2) * this.scale;
		this.noiseI = bandNoise(seed * 31 + 5, rate, noiseBandHz);
		this.noiseQ = bandNoise(seed * 31 + 6, rate, noiseBandHz);
		this.step = BASE_RATE / rate;
		this.pos = 0;
		this.phase = 0;
		this.t = 0;
		this.base = [];
		this.baseStart = -4;
		for (let i = 0; i < 4; i++) this.base.push(0);
		this.symbols = [];
		this.symStart = 0;
		this.bits = null;
		this.bitPos = FRAME_SYMS;
	}

	symbol(k) {
		while (this.symStart + this.symbols.length <= k) {
			if (this.bitPos === FRAME_SYMS) {
				this.bits = encodeFrame(this.source.next());
				this.bitPos = 0;
			}
			this.symbols.push((this.bits[this.bitPos++] !== 0) !== this.invert ? 1 : -1);
		}
		return this.symbols[k - this.symStart];
	}

	baseAt(n) {
		while (this.baseStart + this.base.length <= n) {
			const m = this.baseStart + this.base.length;
			const lo = Math.max(0, Math.ceil((m - SPAN * SPS) / SPS)),
				hi = Math.floor((m + SPAN * SPS) / SPS);
			let v = 0;
			for (let j = lo; j <= hi; j++) v += this.symbol(j) * this.g[m - j * SPS + SPAN * SPS];
			this.base.push(v);
		}
		return this.base[n - this.baseStart];
	}

	/** The next `n` complex samples, interleaved. */
	generate(n) {
		const out = new Float32Array(2 * n);
		for (let i = 0; i < n; i++) {
			const i0 = Math.floor(this.pos);
			const mu = this.pos - i0;
			const y0 = this.baseAt(i0 - 1),
				y1 = this.baseAt(i0),
				y2 = this.baseAt(i0 + 1),
				y3 = this.baseAt(i0 + 2);
			const v =
				(y0 * (-mu * (mu - 1) * (mu - 2))) / 6 +
				(y1 * ((mu + 1) * (mu - 1) * (mu - 2))) / 2 +
				(y2 * (-(mu + 1) * mu * (mu - 2))) / 2 +
				(y3 * ((mu + 1) * mu * (mu - 1))) / 6;
			out[2 * i] = v * Math.cos(this.phase) * this.scale + this.sigma * this.noiseI();
			out[2 * i + 1] = v * Math.sin(this.phase) * this.scale + this.sigma * this.noiseQ();
			this.phase += (2 * Math.PI * (this.freq + this.drift * this.t)) / this.rate;
			if (this.phase > Math.PI) this.phase -= 2 * Math.PI;
			this.t += 1 / this.rate;
			this.pos += this.step;
		}
		this.trim();
		return out;
	}

	trim() {
		const keepFrom = Math.floor(this.pos) - 2;
		if (keepFrom > this.baseStart + 4096) {
			this.base.splice(0, keepFrom - this.baseStart);
			this.baseStart = keepFrom;
		}
		const drop = Math.floor((this.baseStart - SPAN * SPS - 2 * SPS) / SPS);
		if (drop > this.symStart + 4096) {
			this.symbols.splice(0, drop - this.symStart);
			this.symStart = drop;
		}
	}
}

/** The loop's messages as the receiver gives them back (carriage returns dropped). */
export const expectedTexts = (source) => source.messages.map((m) => ({ ...m, text: m.text.replace(/\r/g, '') }));
