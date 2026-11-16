// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/hfdig/hfdig_ftx.cpp (SlotDecoder: run, tryCandidate, subtract,
// wsprCallGrid; one slot of one mode: the sync search, each candidate fitted and decoded, every decoded signal rebuilt
// and subtracted, the search run again on what is left), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the slot is decoded a step at a time (a generator: a step is a candidate or a part of the spectrum); no
// early decodes and no slot search (the slots come from the clock); the subtraction works on the span of the signal
// only, which gives the same result with less memory; the deep stage stops after a pass that found nothing (OnAir runs
// its second pass on the same audio again, to the same result); the a-priori calls are tried on fewer candidates
// (soft.ts). The slot's audio is decoded in place (OnAir decodes a copy).

import { wsprDeinterleave, wsprSymbols, wsprSymbolsOf, wsprUnpack } from '@/worker/decoders/digimode/wspr/codec';
import { wsprFano } from '@/worker/decoders/digimode/wspr/fano';
import type { Fft } from '@/worker/decoders/dab/ofdm/fft';
import { CandidateFit } from './fit';
import { checkCrc, ldpcDecode } from './ldpc';
import { layoutOf, logI0, roundHalfAway } from './layout';
import type { XMem } from './memory';
import type { CallHash } from './pack';
import { SlotSearch } from './search';
import { DeepStages, plainLlr } from './soft';
import { FT4_RVEC, LDPC_N, WSPR_SYNC } from './tables';
import type { FtxCand, FtxDecode, FtxFound, FtxJob, FtxLayout, FtxSymbols } from './types';
import { callAndGrid, unpack77 } from './unpack';
import { addWaveIQ, FT8, ftxTones, leadOf, spec, WSPR } from './wave';

/** Frequency retries of an FT4 candidate in the deep stage, and their step in tone spacings. */
const NUDGES = 5;
const NUDGE_STEP = 1 / 48;
/** Fano cycles per WSPR candidate. */
const WSPR_FANO_LIMIT = 20000 * 81;

/** "K1ABC FN42 37", "PJ4/K1ABC 30", "<K1ABC> FN42AX 37" -> [call, grid]. */
export function wsprCallGrid(msg: string): [string, string] {
	const a = msg.indexOf(' ');
	const b = msg.lastIndexOf(' ');
	if (a < 0) return ['', ''];
	let call = msg.slice(0, a);
	if (call.length > 2 && call[0] === '<') call = call.slice(1, -1);
	if (call === '...') call = '';
	return [call, b > a ? msg.slice(a + 1, b) : ''];
}

/** One slot of one mode. */
export class SlotDecoder {
	private readonly L: FtxLayout;
	private readonly x: Float32Array;
	private readonly S: SlotSearch;
	private readonly fit: CandidateFit;
	private readonly deepStages: DeepStages;
	private deep = false;
	private lastRaw = new Uint8Array(7);
	private readonly raw: Uint8Array[] = [];

	constructor(
		private readonly job: FtxJob,
		private readonly hash: CallHash,
		private readonly wsprHash: Map<number, string>,
		private readonly mirrored: boolean,
		private readonly mem: XMem,
		ffts = new Map<number, Fft>(),
	) {
		this.L = layoutOf(job.mode);
		this.x = job.x;
		this.S = new SlotSearch(job, this.L, this.x, mirrored, ffts);
		this.fit = new CandidateFit(this.S, this.L, job.mode === WSPR);
		this.deepStages = new DeepStages(job.mode, job.slotUtc, hash, mem);
	}

	/** Decodes the slot at once. */
	run(): FtxDecode[] {
		const steps = this.steps();
		for (;;) {
			const r = steps.next();
			if (r.done) return r.value;
		}
	}

	/** Decodes the slot a step at a time (a step is a candidate, or a part of the spectrum); returns the decodes. */
	*steps(): Generator<void, FtxDecode[], void> {
		const { job, L } = this;
		const out: FtxDecode[] = [];
		const seen = new Set<string>();
		if (job.mode !== WSPR) this.mem.prune(job.slotUtc, spec(job.mode).period);
		// the plain decoder's passes first, then (FT8 / FT4) the same passes again with the deeper metrics (coherent symbols,
		// OSD, a-priori) on what is left: so the deep stage never changes what the plain one decodes and subtracts
		for (let stage = 0; stage < (job.mode === WSPR ? 1 : 2); stage++) {
			this.deep = stage === 1;
			for (let pass = 0; pass < L.passes; pass++) {
				const found = yield* this.pass(pass + stage * L.passes, out, seen);
				// OnAir's test is (stage == 0 || pass > 0): its deep stage repeats a first pass that found nothing on the same audio
				if (!found) break;
			}
		}
		// hashed calls heard later in the slot
		if (job.mode === WSPR)
			out.forEach((d, i) => {
				if (!d.msg.startsWith('<...>')) return;
				const [m] = wsprUnpack(this.raw[i], this.wsprHash);
				if (m) [d.msg, [d.call, d.grid]] = [m, wsprCallGrid(m)];
			});
		return out;
	}

	/** One search of what is left of the slot: every candidate tried, every decode subtracted. Returns the new decodes. */
	private *pass(pass: number, out: FtxDecode[], seen: Set<string>): Generator<void, number, void> {
		const { job, L } = this;
		yield* this.S.bigFft();
		yield;
		yield* this.S.spectrogram();
		let found = 0;
		for (let mir = 0; mir < (this.mirrored ? 2 : 1); mir++)
			for (const c of yield* this.S.candidates(mir === 1)) {
				yield;
				if (this.deep && this.S.nearDecoded(c, mir === 1, out)) continue;
				const r = this.tryNudged(c, mir === 1);
				if (!r) continue;
				const { d } = r;
				const same =
					seen.has(d.msg) ||
					out.some(
						(o) => o.mirrored === d.mirrored && Math.abs(o.hz - d.hz) < 1.5 * L.sp && Math.abs(o.dt - d.dt) < 2 * spec(job.mode).symSec,
					);
				if (!same) {
					seen.add(d.msg);
					d.pass = pass;
					if (job.mode !== WSPR) this.mem.heard(d.msg, job.slotUtc);
					out.push(d);
					this.raw.push(this.lastRaw);
					found++;
				}
				this.subtract(r.tones, r.f0, r.start, mir === 1);
			}
		return found;
	}

	/** The deep stage retries an FT4 candidate a little off the fitted frequency (the sync fit is noisy at the threshold). */
	private tryNudged(c: FtxCand, mir: boolean): FtxFound | null {
		const tries = this.deep && this.L.nt === 4 ? NUDGES : 1;
		for (let k = 0; k < tries; k++) {
			const nudge = k === 0 ? 0 : Math.floor((k + 1) / 2) * NUDGE_STEP * (k % 2 ? 1 : -1);
			const r = this.tryCandidate(c, mir, nudge);
			if (r) return r;
		}
		return null;
	}

	/** The amplitude of the signal against the noise per tone: the scale of the non-coherent likelihoods. */
	private kx(sym: FtxSymbols): number {
		const { L } = this;
		let sMax = 0;
		let sRest = 0;
		for (const k of L.data) {
			let mx = 0;
			let sum = 0;
			for (let t = 0; t < L.nt; t++) {
				const p = sym.amp[k * L.nt + t] ** 2;
				mx = Math.max(mx, p);
				sum += p;
			}
			sMax += mx;
			sRest += sum - mx;
		}
		const nd = L.data.length;
		let sigma2 = Math.max(1e-30, sRest / (nd * (L.nt - 1)));
		if (this.job.mode === WSPR) {
			// the two tones of the other sync parity carry no signal: the noise
			let nn = 0;
			for (const [k, sy] of L.sync) nn += sym.amp[k * 4 + (1 - sy)] ** 2 + sym.amp[k * 4 + (3 - sy)] ** 2;
			sigma2 = Math.max(1e-30, nn / (2 * 162));
		}
		const A2 = Math.max(0.05 * sigma2, sMax / nd - sigma2);
		return (2 * Math.sqrt(A2)) / sigma2;
	}

	private tryCandidate(c: FtxCand, mir: boolean, nudge: number): FtxFound | null {
		const { job, L } = this;
		const f0 = c.bin * this.S.binHz;
		if (nudge === 0 || !this.fit.fit.valid) this.fit.fitCandidate(c, mir, this.S.binHz);
		const sym = this.fit.symbols(nudge, f0, mir, job.x0);
		const kx = this.kx(sym);
		const d: FtxDecode = {
			slotUtc: job.slotUtc,
			mode: job.mode,
			snrDb: 0,
			dt: sym.startSec - spec(job.mode).t0,
			hz: sym.f0fine,
			msg: '',
			mirrored: mir,
			cq: false,
			call: '',
			grid: '',
			dbm: -1,
			pass: 0,
			how: 0,
		};
		const tones = job.mode === WSPR ? this.decodeWspr(sym, kx, d) : this.decodeFt(sym, kx, c, nudge, d);
		if (!tones) return null;
		d.snrDb = this.snr(sym, tones);
		[d.call, d.grid] = job.mode === WSPR ? wsprCallGrid(d.msg) : callAndGrid(d.msg);
		d.cq = d.msg.startsWith('CQ ') || job.mode === WSPR;
		return { d, tones, f0: sym.f0fine, start: (sym.bestT + sym.tfrac) * L.ndown };
	}

	private decodeWspr(sym: FtxSymbols, kx: number, d: FtxDecode): number[] | null {
		const llr = new Float64Array(162);
		for (let k = 0; k < 162; k++) {
			const sy = WSPR_SYNC[k];
			llr[k] = logI0(kx * sym.amp[k * 4 + sy + 2]) - logI0(kx * sym.amp[k * 4 + sy]);
		}
		const dl = new Float64Array(162);
		wsprDeinterleave(llr, dl);
		const data = new Uint8Array(7);
		if (!wsprFano(dl, data, WSPR_FANO_LIMIT)) return null;
		const [msg, dbm] = wsprUnpack(data, this.wsprHash);
		if (!msg) return null;
		d.msg = msg;
		d.dbm = dbm;
		this.lastRaw = data;
		// a type 3 message with an unknown hash: rebuilt from the bits
		return wsprSymbols(msg) ?? wsprSymbolsOf(data);
	}

	private decodeFt(sym: FtxSymbols, kx: number, c: FtxCand, nudge: number, d: FtxDecode): number[] | null {
		const { job, L } = this;
		const llr = new Float64Array(LDPC_N);
		plainLlr(L, sym.amp, kx, llr);
		let cw = new Uint8Array(LDPC_N);
		let got = ldpcDecode(llr, 40, cw) === 0 && checkCrc(cw);
		if (!got && !this.deep) return null;
		if (!got) {
			const cand = { score: c.score, mir: d.mirrored, hz: d.hz, dt: d.dt };
			got = this.deepStages.decode(L, llr, sym.zr, sym.zi, cand, nudge, nudge === 0);
			cw = this.deepStages.cw;
			d.how = this.deepStages.how;
		}
		if (!got) return null;
		const b77 = Uint8Array.from({ length: 77 }, (_, i) => cw[i] ^ (job.mode === FT8 ? 0 : FT4_RVEC[i]));
		const msg = unpack77(b77, this.hash);
		if (!msg) return null;
		d.msg = msg;
		return ftxTones(job.mode, b77);
	}

	/** SNR in 2500 Hz from the decoded tones against the others. */
	private snr(sym: FtxSymbols, tones: number[]): number {
		const { L } = this;
		let [ps, pn, cs, cn] = [0, 0, 0, 0];
		for (let k = 0; k < tones.length; k++) {
			const ks = k + L.toneOff;
			for (let t = 0; t < L.nt; t++) {
				const p = sym.amp[ks * L.nt + t] ** 2;
				if (t === tones[k]) [ps, cs] = [ps + p, cs + 1];
				else [pn, cn] = [pn + p, cn + 1];
			}
		}
		ps /= Math.max(1, cs);
		pn /= Math.max(1, cn);
		const r = Math.max(1e-3, ps / Math.max(1e-30, pn) - 1);
		return Math.max(-35, roundHalfAway(10 * Math.log10(r) + 10 * Math.log10(L.sp / 2500)));
	}

	/** Rebuilds a decoded signal and takes it out of the slot: its slowly varying complex amplitude is measured against a clean copy. */
	private subtract(tones: number[], f0: number, start: number, mir: boolean): void {
		const { job, L, x } = this;
		const s = spec(job.mode);
		const total = tones.length + 2 * leadOf(job.mode);
		const lo = Math.max(0, Math.ceil(start));
		const hi = Math.min(x.length, Math.floor(start + total * s.symSec * L.rate) + 1);
		const n = hi - lo;
		if (n <= 0) return;
		const re = new Float64Array(n);
		const im = new Float64Array(n);
		addWaveIQ(job.mode, tones, f0, L.rate, start - lo, mir, re, im);
		// z = x conj(c), c = re + j im; box sums of one symbol over z and over |c|^2
		const half = L.nsps / 2;
		const czr = new Float64Array(n + 1);
		const czi = new Float64Array(n + 1);
		const ce = new Float64Array(n + 1);
		for (let i = 0; i < n; i++) {
			const v = x[lo + i];
			czr[i + 1] = czr[i] + v * re[i];
			czi[i + 1] = czi[i] - v * im[i];
			ce[i + 1] = ce[i] + re[i] * re[i] + im[i] * im[i];
		}
		for (let i = 0; i < n; i++) {
			if (re[i] * re[i] + im[i] * im[i] <= 0) continue;
			const a = Math.max(0, i - half);
			const b = Math.min(n, i + half);
			const den = ce[b] - ce[a];
			if (den <= 1e-9) continue;
			// A = a / 2 of x = Re(a c); x -= 2 Re(A c)
			const ar = (czr[b] - czr[a]) / den;
			const ai = (czi[b] - czi[a]) / den;
			x[lo + i] -= 2 * (ar * re[i] - ai * im[i]);
		}
	}
}
