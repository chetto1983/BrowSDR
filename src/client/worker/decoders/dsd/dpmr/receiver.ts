// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/dpmr/dpmr_rx.cpp (DpmrReceiver::Impl: initSym, push, at,
// symsAt, pearson, lsFit, nearestLevel, levelOk, symsMatch, fitSync, search, step, good, bitsAt, softAt, blockAt, ccAt,
// decodeHeader, decodeFrame, decodeEnd, voiceFrame), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the input is the FM discriminator output of BrowSDR's DSD stream at 48 kHz (BrowSDR's DDC is the channel
// filter), so OnAir's mixer, decimator, channel filter, frequency capture and PMR446 scan are left out; the symbol filter
// output is kept at 24 kHz (10 samples per symbol, OnAir 20) and the sync correlations use precomputed centred patterns,
// FS1 and FS3 in one pass, to halve the work; voice frames go to the DSD decoder (mbelib) and the calls to call.ts.
//
// Why not the DSD clock recovery: at 2400 symbols/s a dPMR burst starts after noise with a 36-symbol preamble, and
// BrowSDR's Gardner loop often had not found the symbol phase by the header (or for whole short transmissions). OnAir
// needs no timing loop: the syncs are correlated at every sample and each frame is read at the phase of its own sync.
import { DSD_IF_RATE } from '@/worker/decoders/dsd/constants';
import { SyncType } from '@/worker/decoders/dsd/types';
import { DpmrCalls } from './call';
import {
	CC_SYM,
	FRAME_SYM,
	FS1,
	FS2,
	FS3,
	FS4,
	FS_LONG,
	FS_SHORT,
	MODE_DATA1,
	MODE_DATA2,
	MODE_PACKET,
	blockDecodeSoft,
	ccDecode,
	ccSymbols,
	cchParse,
	dataParse,
	endParse,
	headerParse,
	pn9,
} from './proto';
import type { DpmrCch, DpmrCentred, DpmrEvents, DpmrMode } from './types';

/** The symbol filter keeps every second sample: 24 kHz, 10 samples per symbol at 2400 symbols/s. */
const DECIM = 2;
const RATE = DSD_IF_RATE / DECIM;
const SPS = 10;
/** Where the next payload sync is looked for, either side (OnAir: a quarter symbol). */
const W = 3;
const Y_MASK = 16383;
/** The symbol filter's delay in (kept) samples. */
const SD = 2 * SPS;
/** Hz per symbol level (+3 = 1050 Hz). */
const UNIT = 350;
const HZ = DSD_IF_RATE / (2 * Math.PI);
const PATTERNS = [FS1, FS2, FS3, FS4];
const SYNCS = [SyncType.DPMR_FS1, SyncType.DPMR_FS2, SyncType.DPMR_FS3, SyncType.DPMR_FS4];
const S1 = 0;
const S2 = 1;
const S3 = 2;
const S4 = 3;
const TCH_PN = pn9(288);

/**
 * Symbol filter: a windowed-sinc low pass to 1500 Hz (the 2400 baud raised-cosine signal reaches 1440 Hz). The
 * discriminator's noise grows with frequency; OnAir found that a half-symbol box let much of it through.
 */
function symbolFilter(): Float32Array {
	const lpf = 1500;
	const half = SD * DECIM; // two symbols at 48 kHz
	const taps = new Float32Array(2 * half + 1);
	let sum = 0;
	for (let k = 0; k < taps.length; k++) {
		const t = k - half;
		const x = ((2 * lpf) / DSD_IF_RATE) * t;
		const sc = t === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
		const w = 0.42 + 0.5 * Math.cos((Math.PI * t) / (half + 1)) + 0.08 * Math.cos((2 * Math.PI * t) / (half + 1));
		taps[k] = sc * w;
		sum += taps[k];
	}
	return taps.map((v) => v / sum);
}

/** v = g * s + d */
function lsFit(v: ArrayLike<number>, s: ArrayLike<number>, n: number): { g: number; d: number } {
	let ms = 0;
	let mv = 0;
	for (let i = 0; i < n; i++) {
		ms += s[i];
		mv += v[i];
	}
	ms /= n;
	mv /= n;
	let c = 0;
	let a = 0;
	for (let i = 0; i < n; i++) {
		c += (s[i] - ms) * (v[i] - mv);
		a += (s[i] - ms) * (s[i] - ms);
	}
	const g = a > 0 ? c / a : 0;
	return { g, d: mv - g * ms };
}

function nearestLevel(v: number): number {
	return v >= 2 ? 3 : v >= 0 ? 1 : v >= -2 ? -1 : -3;
}

function levelOk(g: number): boolean {
	return Math.abs(g) > 0.4 * UNIT && Math.abs(g) < 1.8 * UNIT;
}

/** A sync pattern centred, so that a Pearson correlation only sums over the received values. */
function centre(s: ArrayLike<number>): DpmrCentred {
	let ms = 0;
	for (let i = 0; i < s.length; i++) ms += s[i];
	ms /= s.length;
	const sc = Float32Array.from(s, (x) => x - ms);
	return { sc, norm: Math.sqrt(sc.reduce((a, x) => a + x * x, 0)) };
}

const CENTRED = [centre(FS1), centre(FS2), centre(FS3)];

/** dPMR mode 1 receiver on the FM discriminator output of the DSD stream (48 kHz in, symbols filtered at 24 kHz). */
export class DpmrReceiver {
	private taps = symbolFilter();
	/** Filter history, written twice so that the newest taps.length samples are always in one run. */
	private hist = new Float32Array(2 * this.taps.length);
	private histPos = 0;
	private phase = 0;
	private y = new Float32Array(Y_MASK + 1);
	private yN = 0;
	private mode: DpmrMode = 'search';
	private candN = -1;
	private candR = 0;
	private candT = 0;
	/** header / end: the last sync symbol; frame: the frame's first symbol; sync: the expected frame start. */
	private mark = 0;
	private packetHdr = false;
	private fromSearch = false;
	private fly = false;
	private frameIdx = 0;
	private miss = 0;
	private bad = 0;
	private g = UNIT;
	private d = 0;
	/** The polarity of the last good frames (FS1 and FS4 differ only by it). */
	private pol = 1;
	private snrAvg = 0;
	private lastGood = -1e9;
	private sync = SyncType.DPMR_FS1;
	private v = new Float32Array(FRAME_SYM);
	readonly calls = new DpmrCalls();

	constructor(private events: DpmrEvents) {}

	/** FM discriminator output at 48 kHz (radians per sample). */
	process(fm: Float32Array): void {
		const n = this.taps.length;
		for (const f of fm) {
			this.hist[this.histPos] = this.hist[this.histPos + n] = f;
			this.histPos = (this.histPos + 1) % n;
			if (++this.phase < DECIM) continue;
			this.phase = 0;
			let acc = 0;
			for (let k = 0, p = this.histPos; k < n; k++, p++) acc += this.hist[p] * this.taps[k];
			this.y[this.yN & Y_MASK] = acc * HZ;
			this.yN++;
			this.step();
		}
		this.timeouts();
	}

	reset(): void {
		this.hist.fill(0);
		this.histPos = 0;
		this.phase = 0;
		this.y.fill(0);
		this.yN = 0;
		this.mode = 'search';
		this.candN = -1;
		this.candR = 0;
		this.g = UNIT;
		this.d = 0;
		this.pol = 1;
		this.snrAvg = 0;
		this.lastGood = -1e9;
		this.calls.reset();
	}

	private at(i: number): number {
		return this.y[(i + SD) & Y_MASK];
	}

	/** n symbol values from the first one, in a scratch array. */
	private symsAt(first: number, n: number): Float32Array {
		const v = this.v.subarray(0, n);
		for (let k = 0; k < n; k++) v[k] = this.at(first + k * SPS);
		return v;
	}

	/** Pearson correlation of the symbols from first with a centred pattern. */
	private corr(first: number, p: DpmrCentred): number {
		return this.corrPair(first, p, p)[0];
	}

	/** Pearson correlations of the same symbols with two centred patterns of one length. */
	private corrPair(first: number, p: DpmrCentred, q: DpmrCentred): [number, number] {
		const n = p.sc.length;
		let sv = 0;
		let svv = 0;
		let svp = 0;
		let svq = 0;
		for (let k = 0; k < n; k++) {
			const x = this.at(first + k * SPS);
			sv += x;
			svv += x * x;
			svp += x * p.sc[k];
			svq += x * q.sc[k];
		}
		const a = svv - (sv * sv) / n;
		return a > 0 ? [svp / Math.sqrt(a) / p.norm, svq / Math.sqrt(a) / q.norm] : [0, 0];
	}

	private symsMatch(v: Float32Array, s: ArrayLike<number>, g: number, d: number, tol: number): boolean {
		let e = 0;
		for (let k = 0; k < v.length; k++) if (nearestLevel((v[k] - d) / g) !== s[k]) e++;
		return e <= tol;
	}

	private fitSync(first: number, s: ArrayLike<number>, n: number): void {
		const { g, d } = lsFit(this.symsAt(first, n), s, n);
		if (!levelOk(g) || (this.mode !== 'search' && g * this.g <= 0)) return;
		const searching = this.mode === 'search';
		this.g = searching ? g : 0.5 * this.g + 0.5 * g;
		this.d = searching ? d : 0.5 * this.d + 0.5 * d;
	}

	private search(last: number): void {
		const [r1, r3] = this.corrPair(last - (FS_LONG - 1) * SPS, CENTRED[S1], CENTRED[S3]);
		const r2 = this.corr(last - (FS_SHORT - 1) * SPS, CENTRED[S2]);
		const rs = [r1, r2, r3];
		for (let t0 = S1; t0 <= S3; t0++) {
			// FS4 is FS1 upside down: which one it is follows from the polarity last seen
			const n = t0 === S2 ? FS_SHORT : FS_LONG;
			const first = last - (n - 1) * SPS;
			let r = rs[t0];
			let t = t0;
			if (t0 === S1 && r * this.pol < 0) {
				t = S4;
				r = -r;
			}
			if (Math.abs(r) <= (t === S2 ? 0.9 : 0.85) || Math.abs(r) <= this.candR) continue;
			const v = this.symsAt(first, n);
			const { g, d } = lsFit(v, PATTERNS[t], n);
			if (levelOk(g) && this.symsMatch(v, PATTERNS[t], g, d, t === S2 ? 0 : 1)) {
				this.candN = last;
				this.candR = Math.abs(r);
				this.candT = t;
			}
		}
		if (this.candN < 0 || last - this.candN <= SPS / 2) return;
		this.found(this.candN, this.candT);
	}

	/** The best sync of the search, its last symbol at e. */
	private found(e: number, t: number): void {
		this.candN = -1;
		this.candR = 0;
		const n = t === S2 ? FS_SHORT : FS_LONG;
		this.fitSync(e - (n - 1) * SPS, PATTERNS[t], n);
		this.fly = false;
		this.miss = 0;
		this.bad = 0;
		this.sync = SYNCS[t];
		if (t === S1 || t === S4) {
			this.packetHdr = t === S4;
			this.mark = e;
			this.mode = 'header';
		} else if (t === S3) {
			this.mark = e;
			this.mode = 'end';
		} else {
			this.mark = e - (FS_SHORT - 1) * SPS;
			this.fromSearch = true;
			this.frameIdx = 0;
			this.mode = 'frame';
		}
	}

	private step(): void {
		const last = this.yN - 1 - 2 * SD;
		if (last < 64 * SPS) return;
		switch (this.mode) {
			case 'search':
				this.search(last);
				break;
			case 'header':
				if (last < this.mark + 132 * SPS) break;
				this.decodeHeader(this.mark);
				this.mark += 133 * SPS;
				this.frameIdx = 0;
				this.fromSearch = false;
				this.mode = 'sync';
				break;
			case 'end':
				if (last < this.mark + 36 * SPS) break;
				this.decodeEnd(this.mark + SPS);
				this.mode = 'search';
				break;
			case 'frame':
				if (last >= this.mark + (FRAME_SYM - 1) * SPS) this.frameDone();
				break;
			case 'sync':
				if (last >= this.mark + (FS_LONG - 1) * SPS + W) this.payloadSync();
				break;
		}
	}

	private frameDone(): void {
		const fn = this.decodeFrame(this.mark);
		if (this.fromSearch && fn === null) {
			this.mode = 'search';
			return;
		}
		this.fromSearch = false;
		this.bad = fn !== null ? 0 : this.bad + 1;
		if (this.bad >= 3) {
			this.lost();
			return;
		}
		this.frameIdx = (fn ?? this.frameIdx) + 1;
		this.mark += FRAME_SYM * SPS;
		this.mode = 'sync';
	}

	/** The start of the next payload frame: FS2 (even frames) or the colour code (odd), or FS3 (the end frame). */
	private payloadSync(): void {
		const even = this.frameIdx % 2 === 0;
		const p2 = even ? FS2 : this.calls.cc >= 0 ? ccSymbols(this.calls.cc) : null;
		const c2 = p2 && (even ? CENTRED[S2] : centre(p2));
		const pol = this.g > 0 ? 1 : -1;
		let b2 = -2;
		let b3 = -2;
		let n2 = this.mark;
		let n3 = this.mark;
		for (let s = this.mark - W; s <= this.mark + W; s++) {
			const r2 = c2 ? this.corr(s, c2) * pol : -2;
			const r3 = this.corr(s, CENTRED[S3]) * pol;
			if (r2 > b2) [b2, n2] = [r2, s];
			if (r3 > b3) [b3, n3] = [r3, s];
		}
		this.fly = false;
		if (b3 > 0.75 && b3 >= b2) {
			this.sync = SyncType.DPMR_FS3;
			this.fitSync(n3, FS3, FS_LONG);
			this.mark = n3 + (FS_LONG - 1) * SPS;
			this.mode = 'end';
		} else if (p2 && b2 > 0.6) {
			if (even) this.sync = SyncType.DPMR_FS2;
			this.fitSync(n2, p2, FS_SHORT);
			this.mark = n2;
			this.miss = 0;
			this.mode = 'frame';
		} else if (!p2) {
			this.mode = 'frame'; // a colour code frame before the colour code is known
		} else if (++this.miss <= 2) {
			this.fly = true; // flywheel over a damaged sync
			this.mode = 'frame';
		} else this.lost();
	}

	private lost(): void {
		const was = this.calls.now?.active || this.calls.sd !== null;
		this.calls.lost();
		this.mode = 'search';
		if (was) this.publish();
	}

	/** A call or data transmission whose signal went without an end frame. */
	private timeouts(): void {
		const t = this.yN / RATE;
		if (this.mode === 'search' && t - this.lastGood > 1 && (this.calls.now?.active || this.calls.sd)) this.lost();
	}

	private good(snr: number): void {
		this.lastGood = this.yN / RATE;
		this.pol = this.g < 0 ? -1 : 1;
		this.snrAvg = this.snrAvg === 0 ? snr : 0.8 * this.snrAvg + 0.2 * snr;
		this.calls.blocks++;
	}

	private publish(): void {
		const status = this.calls.status(this.g < 0, this.snrAvg);
		if (status) this.events.update(status, this.sync);
	}

	/** Hard bits of n symbols from the first one, and their SNR. */
	private bitsAt(first: number, nSym: number, bits: Uint8Array): number {
		let mse = 0;
		for (let k = 0; k < nSym; k++) {
			const x = (this.at(first + k * SPS) - this.d) / this.g;
			const l = nearestLevel(x);
			mse += (x - l) * (x - l);
			bits[2 * k] = l < 0 ? 1 : 0;
			bits[2 * k + 1] = Math.abs(l) === 3 ? 1 : 0;
		}
		return 10 * Math.log10(5 / Math.max(1e-4, mse / Math.max(1, nSym)));
	}

	/** Soft values of the same bits (> 0 a 1): the first bit of a dibit is 1 below zero, the second 1 on an outer level. */
	private softAt(first: number, nSym: number): Float32Array {
		const soft = new Float32Array(2 * nSym);
		for (let k = 0; k < nSym; k++) {
			const x = (this.at(first + k * SPS) - this.d) / this.g;
			soft[2 * k] = -x;
			soft[2 * k + 1] = Math.abs(x) - 2;
		}
		return soft;
	}

	/** A block of Hamming words, soft decision (about 1.5 dB over the hard decoder). */
	private blockAt(first: number, nSym: number, nWords: number, info: Uint8Array): number {
		return blockDecodeSoft(this.softAt(first, nSym), nWords, info);
	}

	private ccAt(first: number): number {
		const v = Float32Array.from({ length: CC_SYM }, (_, k) => (this.at(first + k * SPS) - this.d) / this.g);
		const { cc, score } = ccDecode(v);
		return score > 0.6 ? cc : -1;
	}

	private decodeHeader(e: number): void {
		const info = new Uint8Array(80);
		const air = new Uint8Array(120);
		let h = null;
		let snr = 0;
		for (let flip = 0; flip < 2 && !h; flip++) {
			if (flip) {
				// FS1 seen as FS4 (or the other way): the polarity was wrong
				this.g = -this.g;
				this.packetHdr = !this.packetHdr;
			}
			for (let part = 0; part < 2 && !h; part++) {
				const first = e + (1 + 72 * part) * SPS;
				snr = this.bitsAt(first, 60, air);
				if (this.blockAt(first, 60, 10, info) >= 0) h = headerParse(info);
			}
			if (!h) {
				// HI1 repeats HI0: both copies' soft values added are 3 dB stronger than either
				const s0 = this.softAt(e + SPS, 60);
				const s1 = this.softAt(e + 73 * SPS, 60);
				for (let i = 0; i < 120; i++) s0[i] += s1[i];
				if (blockDecodeSoft(s0, 10, info) >= 0) h = headerParse(info);
			}
		}
		if (!h) {
			this.g = -this.g;
			this.packetHdr = !this.packetHdr;
		}
		const cc = this.ccAt(e + 61 * SPS);
		if (cc >= 0) this.calls.cc = cc;
		if (!h) return;
		this.sync = this.packetHdr ? SyncType.DPMR_FS4 : SyncType.DPMR_FS1;
		this.good(snr);
		if (this.calls.header(h)) this.events.callStart();
		this.publish();
	}

	/** The frame's colour code, CCH and TCH; the CCH frame number, or null when the CCH did not check. */
	private decodeFrame(s: number): number | null {
		this.refitLevels(s);
		if (this.frameIdx % 2 === 1 || this.fromSearch) {
			const cc = this.ccAt(s);
			if (cc >= 0 && this.frameIdx % 2 === 1) this.calls.cc = cc;
		}
		const air = new Uint8Array(288);
		const info = new Uint8Array(192);
		const snr = this.bitsAt(s + 12 * SPS, 36, air);
		const c = this.blockAt(s + 12 * SPS, 36, 6, info) >= 0 ? cchParse(info) : null;
		if (c) this.good(snr);
		if (this.fromSearch && !c) return null;
		if (this.fromSearch && c) this.frameIdx = c.frame; // late entry: the frame number places it in the superframe
		this.traffic(s + 48 * SPS, c);
		if (c) this.publish();
		return c ? c.frame : null;
	}

	/** The TCH: a data block, or four voice frames of a call. */
	private traffic(first: number, c: DpmrCch | null): void {
		const calls = this.calls;
		const mode = c ? c.commMode : calls.sd ? calls.sd.commMode : calls.now?.active ? calls.now.commMode : -1;
		if (mode === MODE_DATA1 || mode === MODE_DATA2 || mode === MODE_PACKET) {
			const info = new Uint8Array(192);
			const data = this.blockAt(first, 144, 24, info) >= 0 ? dataParse(info) : null;
			if (data) {
				calls.blocks++;
				calls.data(data.block, data.text);
			}
		} else if (mode >= 0) {
			const air = new Uint8Array(288);
			this.bitsAt(first, 144, air);
			this.payloadVoice(c, air);
		}
	}

	/** The decision-directed level over the frame's own symbols. */
	private refitLevels(s: number): void {
		const v = this.symsAt(s, FRAME_SYM);
		const lv = Int8Array.from(v, (x) => nearestLevel((x - this.d) / this.g));
		const { g, d } = lsFit(v, lv, FRAME_SYM);
		if (g * this.g > 0 && Math.abs(g) > 0.5 * Math.abs(this.g) && Math.abs(g) < 2 * Math.abs(this.g)) {
			this.g = g;
			this.d = d;
		}
	}

	private payloadVoice(c: DpmrCch | null, air: Uint8Array): void {
		const calls = this.calls;
		if (c && !calls.now?.active && this.fromSearch) {
			calls.startCall(true, c);
			this.events.callStart();
		}
		if (c) calls.ids(c);
		if (!calls.now?.active || (!c && this.fly)) return;
		for (let i = 0; i < 288; i++) air[i] ^= TCH_PN[i];
		for (let vf = 0; vf < 4; vf++) this.events.voice(air.slice(72 * vf, 72 * vf + 72));
	}

	private decodeEnd(first: number): void {
		const info = new Uint8Array(48);
		const air = new Uint8Array(72);
		const snr = this.bitsAt(first, 36, air);
		const e = this.blockAt(first, 36, 6, info) >= 0 ? endParse(info) : null;
		const was = this.calls.now?.active || this.calls.sd !== null;
		this.sync = SyncType.DPMR_FS3;
		if (e) this.good(snr);
		if (this.calls.sd) this.calls.endData();
		else this.calls.endCall(true, e ? e.own : -1);
		if (e || was) this.publish();
	}
}
