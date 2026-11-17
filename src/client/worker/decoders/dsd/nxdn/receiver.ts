// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/nxdn/nxdn_rx.cpp (NxdnReceiver::Impl: pearson, lsFit,
// nearestLevel, Chain init / push / at / fswAt, syncOk, chainStep, decodeFrame up to the LICH),
// https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the input is the FM discriminator output of BrowSDR's DSD stream at 48 kHz (BrowSDR's DDC is the channel
// filter), so OnAir's mixer, decimator, channel filters and frequency capture are left out; only the NXDN48 chain runs
// here, its symbol filter output kept at 24 kHz (10 samples per symbol, OnAir 20) like the dPMR receiver's. NXDN96
// stays on BrowSDR's 4800 symbols/s chain (its clock recovery and frame sync): frame96 fits the levels of a frame found
// there on its sync word and hands it to the same calls, the first frame of a grid read back from the buffer.
import { SyncType } from '@/worker/decoders/dsd/types';
import type { DsdChain, DsdSink } from '@/worker/decoders/dsd/types';
import { chainLevels, lsFit, nearestLevel } from '@/worker/decoders/dsd/frame-timing';
import { DSD_IF_RATE } from '@/worker/decoders/dsd/constants';
import { NxdnCalls } from './calls';
import { FRAME_SYM, FSW, FSW_SYM, PAYLOAD_SYM, PN9 } from './proto';
import type { NxdnFrame } from './types';

/** The symbol filter keeps every second sample: 24 kHz, 10 samples per NXDN48 symbol. */
const DECIM = 2;
const SPS = 10;
/** The symbol filter's delay in (kept) samples: two symbols. */
const SD = 2 * SPS;
const Y_MASK = 16383;
/** Hz per level of NXDN48 (+3 = 1050 Hz). */
const UNIT = 350;
const HZ = DSD_IF_RATE / (2 * Math.PI);
const FSW_T = Float64Array.from(FSW);
/** The FSW's energy (its mean is zero). */
const FSW_NORM = Math.sqrt(FSW.reduce((a, s) => a + s * s, 0));

/** Pearson correlation with the FSW (whose mean is zero). */
function pearson(v: ArrayLike<number>): number {
	let mv = 0;
	let c = 0;
	let e = 0;
	for (let i = 0; i < FSW_SYM; i++) {
		mv += v[i];
		c += v[i] * FSW[i];
		e += v[i] * v[i];
	}
	const a = e - (mv * mv) / FSW_SYM;
	return a > 0 ? c / Math.sqrt(a) / FSW_NORM : 0;
}

/** The levels of a whole frame, refitted on its decisions; the 182 symbols after the FSW descrambled, in level units. */
function frameSymbols(v: Float32Array, g0: number, d0: number): { sym: Float32Array; g: number; d: number } {
	const lv = new Int8Array(FRAME_SYM);
	for (let k = 0; k < FRAME_SYM; k++) lv[k] = k < FSW_SYM ? FSW[k] : nearestLevel((v[k] - d0) / g0);
	let { g, d } = lsFit(v, lv, FRAME_SYM);
	if (!(g * g0 > 0 && Math.abs(g) > 0.5 * Math.abs(g0) && Math.abs(g) < 2 * Math.abs(g0))) ({ g, d } = { g: g0, d: d0 });
	const sym = new Float32Array(PAYLOAD_SYM);
	for (let k = 0; k < PAYLOAD_SYM; k++) {
		const x = (v[FSW_SYM + k] - d) / g;
		sym[k] = PN9[k] ? -x : x;
	}
	return { sym, g, d };
}

/** Symbol filter: a windowed-sinc low pass to 0.625 of the symbol rate (1500 Hz) at 48 kHz, two symbols each side. */
function symbolFilter(): Float32Array {
	const half = SD * DECIM;
	const taps = new Float32Array(2 * half + 1);
	let sum = 0;
	for (let k = 0; k < taps.length; k++) {
		const t = k - half;
		const x = ((2 * 0.625 * 2400) / DSD_IF_RATE) * t;
		const sc = t === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
		const w = 0.42 + 0.5 * Math.cos((Math.PI * t) / (half + 1)) + 0.08 * Math.cos((2 * Math.PI * t) / (half + 1));
		taps[k] = sc * w;
		sum += taps[k];
	}
	return taps.map((v) => v / sum);
}

/** NXDN48 (2400 symbols/s) beside the DSD chain, NXDN96 frames of the chain, and their calls. */
export class NxdnReceiver {
	readonly calls: NxdnCalls;
	private taps = symbolFilter();
	private hist = new Float32Array(2 * this.taps.length);
	private hPos = 0;
	private phase = 0;
	private y = new Float32Array(Y_MASK + 1);
	/** The search's FSW values (no allocation per sample). */
	private fsw = new Float32Array(FSW_SYM);
	private yN = 0;
	private tracking = false;
	private candN = -1;
	private candR = 0;
	/** The sample of the current frame's last FSW symbol; its level and offset (Hz); missed syncs; frames on the grid. */
	private fs = 0;
	private g = 1;
	private d = 0;
	private miss = 0;
	private fly = false;
	private run = 0;
	private bad = 0;
	private decoded = false;
	/** Where the last NXDN96 frame of the 4800 chain started. */
	private last96 = -1e9;

	constructor(sink: DsdSink) {
		this.calls = new NxdnCalls(sink);
	}

	reset(): void {
		this.hist.fill(0);
		this.y.fill(0);
		this.hPos = this.phase = this.yN = 0;
		this.tracking = false;
		this.candN = -1;
		this.candR = 0;
		this.last96 = -1e9;
		this.calls.reset();
	}

	/** The NXDN48 chain starts a new search. */
	private rest(): void {
		this.tracking = false;
		this.candN = -1;
		this.candR = 0;
	}

	/** FM discriminator output (radians per sample at 48 kHz); on: false while another protocol holds the lock. */
	process(fm: Float32Array, on: boolean): void {
		if (!on) {
			this.rest();
			this.calls.tick(fm.length);
			return;
		}
		const { taps, hist } = this;
		const n = taps.length;
		const half = n >> 1;
		for (let i = 0; i < fm.length; i++) {
			hist[this.hPos] = hist[this.hPos + n] = fm[i] * HZ;
			if (++this.hPos === n) this.hPos = 0;
			if (++this.phase < DECIM) continue;
			this.phase = 0;
			// The filter is symmetric: each pair of taps once.
			const j = this.hPos;
			let acc = hist[j + half] * taps[half];
			for (let k = 0; k < half; k++) acc += (hist[j + k] + hist[j + n - 1 - k]) * taps[k];
			this.y[this.yN++ & Y_MASK] = acc;
			this.step();
		}
		this.calls.tick(fm.length);
	}

	private at(i: number): number {
		return this.y[(i + SD) & Y_MASK];
	}

	private fswAt(e: number): Float32Array {
		const v = new Float32Array(FSW_SYM);
		for (let k = 0; k < FSW_SYM; k++) v[k] = this.at(e - (FSW_SYM - 1 - k) * SPS);
		return v;
	}

	private syncOk(v: Float32Array, g: number, d: number): boolean {
		if (Math.abs(g) < 0.4 * UNIT || Math.abs(g) > 1.8 * UNIT) return false;
		for (let k = 0; k < FSW_SYM; k++) if (nearestLevel((v[k] - d) / g) !== FSW[k]) return false;
		return true;
	}

	private step(): void {
		const last = this.yN - 1 - 2 * SD; // the newest sample whose symbol filter is complete
		if (last < FSW_SYM * SPS) return;
		if (!this.tracking) return this.search(last);
		if (!this.decoded && last >= this.fs + PAYLOAD_SYM * SPS) {
			this.decoded = true;
			this.bad = this.decode48() ? 0 : this.bad + 1;
			if (this.bad >= 3) return this.rest(); // following noise, or not NXDN
		}
		this.track(last);
	}

	private search(last: number): void {
		const { fsw: v, y } = this;
		let mv = 0;
		let c = 0;
		let e = 0;
		for (let k = 0, i = last - (FSW_SYM - 1) * SPS + SD; k < FSW_SYM; k++, i += SPS) {
			const x = (v[k] = y[i & Y_MASK]);
			mv += x;
			c += x * FSW_T[k];
			e += x * x;
		}
		const a = e - (mv * mv) / FSW_SYM;
		const r = a > 0 ? Math.abs(c) / Math.sqrt(a) / FSW_NORM : 0;
		if (r > 0.85 && r > this.candR) {
			const { g, d } = lsFit(v, FSW, FSW_SYM);
			if (this.syncOk(v, g, d)) {
				this.candN = last;
				this.candR = r;
			}
		}
		if (this.candN < 0 || last - this.candN <= SPS / 2) return;
		this.fs = this.candN;
		this.candN = -1;
		this.candR = 0;
		({ g: this.g, d: this.d } = lsFit(this.fswAt(this.fs), FSW, FSW_SYM));
		this.tracking = true;
		this.miss = this.bad = 0;
		this.decoded = this.fly = false;
		this.run = 1;
	}

	/** The next frame sync a frame later, a few samples either side (follows clock errors); a flywheel over two misses. */
	private track(last: number): void {
		const w = Math.max(2, SPS / 4);
		const nominal = this.fs + FRAME_SYM * SPS;
		if (last < nominal + w) return;
		let best = -2;
		let bn = nominal;
		for (let e = nominal - w; e <= nominal + w; e++) {
			const r = pearson(this.fswAt(e)) * Math.sign(this.g);
			if (r > best) {
				best = r;
				bn = e;
			}
		}
		const v = this.fswAt(bn);
		const { g, d } = lsFit(v, FSW, FSW_SYM);
		const lr = Math.abs(g / this.g);
		if (best > 0.6 && g * this.g > 0 && (this.syncOk(v, g, d) || (best > 0.8 && lr > 0.6 && lr < 1.6))) {
			this.fs = bn;
			this.g = 0.5 * this.g + 0.5 * g;
			this.d = 0.5 * this.d + 0.5 * d;
			this.miss = 0;
			this.fly = false;
			this.run++;
		} else if (++this.miss <= 2) {
			this.fs = nominal;
			this.fly = true;
		} else return this.rest();
		this.decoded = false;
	}

	private decode48(): boolean {
		const v = new Float32Array(FRAME_SYM);
		v.set(this.fswAt(this.fs));
		for (let k = 0; k < PAYLOAD_SYM; k++) v[FSW_SYM + k] = this.at(this.fs + (k + 1) * SPS);
		const { sym, g, d } = frameSymbols(v, this.g, this.d);
		this.g = g;
		this.d = d;
		const f: NxdnFrame = { sym, baud: 2400, fly: this.fly, onGrid: this.run >= 2, inverted: g < 0 };
		return this.calls.frame(f, 0, SyncType.NXDN48);
	}

	/**
	 * An NXDN96 frame of the 4800 symbols/s chain, its 18-dibit sync (FSW and LICH) ending at start. A frame that does
	 * not follow the last one counts as on a grid only when the frame before it, read back from the buffer a dibit or two
	 * either side, has its FSW at the levels (the decoder reads a frame once a second sync confirms the first, and the
	 * clock recovery may still have been settling on that first one).
	 */
	frame96(chain: DsdChain, start: number, sync: SyncType): void {
		const announce = sync === SyncType.NXDN96 || sync === SyncType.INV_NXDN96 ? sync : undefined;
		let onGrid = Math.abs(start - this.last96 - FRAME_SYM) <= 2;
		for (let off = 0; !onGrid && off <= 4; off++) {
			const before = this.levels96(chain, start - FRAME_SYM + (off & 1 ? (off + 1) / 2 : -off / 2));
			onGrid = !!before && FSW.every((s, k) => nearestLevel(before.x[k]) === s);
			if (onGrid && before) this.calls.frame(this.frame96Of(before, true), 1, announce);
		}
		const fit = this.levels96(chain, start);
		if (fit) this.calls.frame(this.frame96Of(fit, onGrid), 1, announce);
		this.last96 = start;
	}

	/** The frame's levels re-sampled on the chain's RRC output, else (dibits fed without the chain) as the clock recovery took them. */
	private levels96(chain: DsdChain, start: number): { x: Float32Array; g: number } | null {
		return chainLevels(chain, start - 18, FRAME_SYM, FSW);
	}

	private frame96Of(fit: { x: Float32Array; g: number }, onGrid: boolean): NxdnFrame {
		const { sym } = frameSymbols(fit.x, 1, 0);
		return { sym, baud: 4800, fly: !onGrid, onGrid, inverted: fit.g < 0 };
	}
}
