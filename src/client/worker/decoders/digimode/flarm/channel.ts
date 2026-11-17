// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/flarm/flarm_rx.cpp (Chan, processChan: chip values, sync hunt and
// waiting packets; blockEnd, commitGroup and the packet level of tryJob) and core/src/adsl/adsl_rx.cpp (the M-band
// channel of processChan, commitGroup, readByte, packetLevel), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: one channel path serves FLARM, the ADS-L M-band and the OGN tracker protocol, as the three share the 868.2 /
// 868.4 MHz channels, the 100 kchip/s Manchester GFSK and OnAir's channel filter (front.ts): the chip values (tone
// energy at ±50 kHz, or the FM discriminator) and the sync register of each sampling phase serve both the FLARM and the
// ADS-L sync hunt (OnAir runs a receiver each), and the filtered samples feed the OGN demodulator (OnAir's OGN Chain is
// the same filter at the same 400 kS/s). 4 samples per chip (OnAir's FLARM and ADS-L: 8; measured on the generator's
// packets, the same packets pass to within about 0.3 dB at half the work); one ring of 8192 chips for both protocols
// (FLARM's is 1024); a fast reject (at most two bits apart) before the sync words are counted; no packet level before the
// noise floor is known (OnAir takes a floor of 1e-12 then).

import { ADSL_SYNC, ADSL_SYNC_BITS, STATUS_NET_BYTES, TRAFFIC_NET_BYTES } from './adsl-proto';
import { FLARM_SYNC, FRAME_BYTES } from './flarm-proto';
import { fastAtan2 } from './dsp';
import { FLARM_RATE, SPS } from './front';
import { OgnDemod } from './ogn';
import { popcount } from './ogn-proto';
import type { ChipSink, FlarmOptions, SyncCand } from './types';

/** Chips kept per phase; a 255-byte Manchester packet is 4096. */
export const RING = 8192;
const MASK = RING - 1;
const DATA_CHIPS = FRAME_BYTES * 16;
/** Chips of an OGN packet after its sync word. */
const OGN_CHIPS = 416;
/** 20 ms noise blocks, the floor from the last 250 of them. */
const BLOCK = FLARM_RATE / 50;
const NOISE_BLOCKS = 250;
/** +50 kHz: e^{jπn/SPS}. */
const LO_RE = Float64Array.from({ length: 2 * SPS }, (_, n) => Math.cos((Math.PI * n) / SPS));
const LO_IM = Float64Array.from({ length: 2 * SPS }, (_, n) => Math.sin((Math.PI * n) / SPS));
const LO_MASK = 2 * SPS - 1;
const PH_MASK = SPS - 1;
/** Discriminator radians to ±1 at the nominal ±50 kHz. */
const KD = FLARM_RATE / (2 * Math.PI) / 50000;

/** At most two bits set. */
const few = (x: number): boolean => {
	const y = x & (x - 1);
	return (y & (y - 1)) === 0;
};

const newCand = (n: number, p: number, k0: number, inv: boolean, err: number, score: number): SyncCand => ({
	n,
	p,
	k0,
	inv,
	err,
	score,
	need: 0,
});

/** One sync hunt (FLARM or ADS-L): the best phase of a group of matches, the packets waiting for their chips. */
class Hunt {
	open = false;
	n0 = 0;
	best = newCand(0, 0, 0, false, 0, 0);
	readonly jobs: SyncCand[] = [];
	readonly done: number[] = [];
	syncs = 0;

	reset(): void {
		this.open = false;
		this.jobs.length = 0;
		this.done.length = 0;
	}

	isDuplicate(k: number, span: number): boolean {
		return this.done.some((d) => Math.abs(d - k) <= span);
	}

	offer(c: SyncCand): void {
		if (!this.open) {
			this.open = true;
			this.n0 = c.n;
			this.best = c;
		} else if (c.score > this.best.score) this.best = c;
	}

	commit(need: number): void {
		this.open = false;
		this.syncs++;
		this.best.need = need;
		this.jobs.push(this.best);
		this.done.push(this.best.k0);
		if (this.done.length > 8) this.done.shift();
	}
}

/** One of the two 200 kHz-spaced channels: chip values, noise floor, the sync hunts and the OGN demodulator. */
export class FlarmChannel {
	/** Samples since the start; a reset carries on counting, so the times of the aircraft stay valid. */
	n = 0;
	/** The sample of the last reset: no sync is taken in the first 50 chips after it. */
	private start = 0;
	private prevRe = 1;
	private prevIm = 0;
	private readonly dring = new Float64Array(SPS);
	private readonly t1 = new Float64Array(2 * SPS);
	private readonly t0 = new Float64Array(2 * SPS);
	private b1r = 0;
	private b1i = 0;
	private b0r = 0;
	private b0i = 0;
	private s = 0;
	private chipS = new Float64Array(0);
	/** Chip values per phase: soft[p * RING + (k & MASK)]. */
	readonly soft = new Float32Array(SPS * RING);
	private readonly pw = new Float32Array(RING);
	private readonly reg = new Int32Array(2 * SPS);
	private pwAcc = 0;
	private blkSum = 0;
	private blkN = 0;
	private readonly blocks: number[] = [];
	nf = 0;
	nfKnown = false;
	lastEnergyN = -1e12;
	readonly flarm = new Hunt();
	readonly adsl = new Hunt();
	readonly ogn: OgnDemod;

	constructor(
		readonly index: number,
		private readonly sink: ChipSink,
		private readonly options: FlarmOptions,
	) {
		this.ogn = new OgnDemod((bytes, soft, sec) => {
			const k = Math.floor((sec * FLARM_RATE) / SPS);
			sink.ognFrame(index, bytes, soft, sec, this.level(k - OGN_CHIPS, k));
		}, FLARM_RATE);
	}

	reset(): void {
		this.start = this.n;
		this.prevRe = 1;
		this.prevIm = 0;
		this.dring.fill(0);
		this.t1.fill(0);
		this.t0.fill(0);
		this.b1r = this.b1i = this.b0r = this.b0i = this.s = 0;
		this.soft.fill(0);
		this.pw.fill(0);
		this.reg.fill(0);
		this.pwAcc = this.blkSum = this.blkN = 0;
		this.blocks.length = 0;
		this.nf = 0;
		this.nfKnown = false;
		this.lastEnergyN = -1e12;
		this.flarm.reset();
		this.adsl.reset();
		this.ogn.reset();
	}

	/** Chip value of phase p, chip k. */
	at(p: number, k: number): number {
		return this.soft[p * RING + (k & MASK)];
	}

	/** The channel's filtered samples (front.ts). */
	process(re: Float64Array, im: Float64Array, count: number): void {
		if (this.chipS.length < count) this.chipS = new Float64Array(count);
		if (this.options.toneDetect) this.toneChips(re, im, count);
		else this.discriminatorChips(re, im, count);
		this.sequence(re, im, count);
		this.ogn.process(re, im, count);
	}

	/**
	 * Chip values: the energy at +50 kHz minus that at -50 kHz over the last chip, the noncoherent detector of
	 * h = 1 FSK. The sample turned by -50 kHz is s * conj(lo), by +50 kHz s * lo.
	 */
	private toneChips(re: Float64Array, im: Float64Array, count: number): void {
		const out = this.chipS;
		const t1 = this.t1;
		const t0 = this.t0;
		let { b1r, b1i, b0r, b0i } = this;
		for (let i = 0, n = this.n; i < count; i++, n++) {
			const p2 = 2 * (n & PH_MASK);
			const c = LO_RE[n & LO_MASK];
			const s = LO_IM[n & LO_MASK];
			const xc = re[i] * c;
			const ys = im[i] * s;
			const xs = re[i] * s;
			const yc = im[i] * c;
			const n1r = xc + ys;
			const n1i = yc - xs;
			const n0r = xc - ys;
			const n0i = xs + yc;
			b1r += n1r - t1[p2];
			b1i += n1i - t1[p2 + 1];
			b0r += n0r - t0[p2];
			b0i += n0i - t0[p2 + 1];
			t1[p2] = n1r;
			t1[p2 + 1] = n1i;
			t0[p2] = n0r;
			t0[p2 + 1] = n0i;
			if ((n & 1023) === 0) {
				// rounding: the sums again from scratch now and then
				b1r = b1i = b0r = b0i = 0;
				for (let j = 0; j < 2 * SPS; j += 2) {
					b1r += t1[j];
					b1i += t1[j + 1];
					b0r += t0[j];
					b0i += t0[j + 1];
				}
			}
			out[i] = b1r * b1r + b1i * b1i - (b0r * b0r + b0i * b0i);
		}
		Object.assign(this, { b1r, b1i, b0r, b0i });
	}

	/** Chip values: the sum of the last chip's discriminator samples. */
	private discriminatorChips(re: Float64Array, im: Float64Array, count: number): void {
		const out = this.chipS;
		let { prevRe, prevIm, s } = this;
		for (let i = 0, n = this.n; i < count; i++, n++) {
			const d = fastAtan2(im[i] * prevRe - re[i] * prevIm, re[i] * prevRe + im[i] * prevIm) * KD;
			prevRe = re[i];
			prevIm = im[i];
			s += d - this.dring[n & PH_MASK];
			this.dring[n & PH_MASK] = d;
			out[i] = s;
		}
		Object.assign(this, { prevRe, prevIm, s });
	}

	/** Power, noise floor, the chip rings and sync registers, the sync hunts, waiting packets, the OGN demodulator. */
	private sequence(re: Float64Array, im: Float64Array, count: number): void {
		const chips = this.chipS;
		const soft = this.soft;
		const reg = this.reg;
		const pw = this.pw;
		const { flarm, adsl } = this;
		let { pwAcc, blkSum, blkN } = this;
		const n0 = this.n;
		const live = n0 + count - this.start > 50 * SPS;
		for (let i = 0; i < count; i++) {
			const n = n0 + i;
			const p = n & PH_MASK;
			const k = Math.floor(n / SPS);
			const pwr = re[i] * re[i] + im[i] * im[i];
			pwAcc = p === 0 ? pwr : pwAcc + pwr;
			if (p === PH_MASK) pw[k & MASK] = pwAcc;
			blkSum += pwr;
			if (++blkN >= BLOCK) {
				this.blockEnd(n, blkSum / blkN);
				blkSum = blkN = 0;
			}
			const row = p * RING;
			const s = chips[i];
			soft[row + (k & MASK)] = s;
			// the pair that ends at this chip: the second chip above the first is a 1
			const r = (reg[2 * p + (k & 1)] << 1) | (s > soft[row + ((k - 1) & MASK)] ? 1 : 0);
			reg[2 * p + (k & 1)] = r;
			const f = r ^ FLARM_SYNC;
			const a = (r ^ ADSL_SYNC) & 0xffffff;
			if (live && (few(f) || few(~f) || few(a) || few(~a & 0xffffff)) && n - this.start > 50 * SPS) this.hunt(r, n, p, k);
			if (flarm.open && n >= flarm.n0 + 3 * SPS) flarm.commit(0);
			if (adsl.open && n >= adsl.n0 + 3 * SPS) adsl.commit(1 + Math.max(TRAFFIC_NET_BYTES, STATUS_NET_BYTES));
			if (flarm.jobs.length || adsl.jobs.length) {
				this.n = n;
				this.runJobs(n);
			}
		}
		this.n = n0 + count;
		Object.assign(this, { pwAcc, blkSum, blkN });
	}

	private hunt(r: number, n: number, p: number, k: number): void {
		const e = popcount((r ^ FLARM_SYNC) >>> 0);
		if (e <= 2 || e >= 30) this.huntOne(this.flarm, n, p, k, e, 32, 6);
		const a = popcount((r & 0xffffff) ^ ADSL_SYNC);
		if (a <= 2 || a >= ADSL_SYNC_BITS - 2) this.huntOne(this.adsl, n, p, k, a, ADSL_SYNC_BITS, 6);
	}

	/** A sync match at this phase: scored by the chip-pair differences of the sync word. */
	private huntOne(h: Hunt, n: number, p: number, k: number, e: number, bits: number, span: number): void {
		if (h.isDuplicate(k, span)) return;
		let score = 0;
		for (let j = 0; j < bits; j++) score += Math.abs(this.at(p, k - 2 * j) - this.at(p, k - 2 * j - 1));
		const ei = bits - e;
		h.offer(newCand(n, p, k, ei < e, Math.min(e, ei), score));
	}

	private runJobs(n: number): void {
		const f = this.flarm.jobs;
		while (f.length && n >= SPS * (f[0].k0 + DATA_CHIPS) + f[0].p + 1) this.sink.flarmJob(this, f.shift()!);
		const a = this.adsl.jobs;
		while (a.length) {
			const j = a[0];
			if (n < SPS * (j.k0 + j.need * 16 + 1) + j.p + 1) break;
			if (j.need <= 1 + TRAFFIC_NET_BYTES) {
				// the length byte is in: wait for all of a longer packet
				const len = this.byteAt(j, 0);
				if (len > TRAFFIC_NET_BYTES) {
					j.need = 1 + len;
					continue;
				}
			}
			this.sink.adslJob(this, a.shift()!);
		}
	}

	/** A byte of a Manchester frame after the sync; margin receives each bit's chip difference. */
	byteAt(c: SyncCand, index: number, margin?: Float32Array, at = 0): number {
		let v = 0;
		for (let i = 0; i < 8; i++) {
			const base = c.k0 + 1 + (index * 8 + i) * 2;
			const a = this.at(c.p, base);
			const b = this.at(c.p, base + 1);
			v = (v << 1) | ((b > a ? 1 : 0) ^ (c.inv ? 1 : 0));
			if (margin) margin[at + i] = Math.abs(b - a);
		}
		return v;
	}

	/** Mean chip power from chip `from` to `to` over the noise floor, dB; NaN until the floor is known (60 ms). */
	level(from: number, to: number): number {
		if (!this.nfKnown) return NaN;
		let pwr = 0;
		for (let k = from; k <= to; k++) pwr += this.pw[k & MASK];
		pwr /= (to - from + 1) * SPS;
		return 10 * Math.log10(Math.max(pwr - this.nf, this.nf * 0.01) / this.nf);
	}

	private blockEnd(n: number, mean: number): void {
		this.blocks.push(mean);
		if (this.blocks.length > NOISE_BLOCKS) this.blocks.shift();
		if (this.blocks.length >= 3) {
			const s = [...this.blocks].sort((x, y) => x - y);
			this.nf = Math.max(s[Math.floor(s.length / 10)] * 1.05, 1e-12);
			this.nfKnown = true;
		}
		if (this.nfKnown && mean > 1.6 * this.nf) this.lastEnergyN = n;
	}
}
