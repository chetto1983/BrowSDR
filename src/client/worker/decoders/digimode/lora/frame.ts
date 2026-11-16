// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/mesh/mesh_lora_code.cpp (FrameDecoder: header, hard and soft
// Hamming decoding of the interleaver blocks, payload assembly, CRC and the soft list decoding on the CRC),
// https://github.com/adswill/OnAir; see third_party/onair. LoRa facts as credited there: gr-lora_sdr (Joachim Tapparel,
// EPFL, and contributors, GPL-3.0). Changes: the soft symbols (four strongest bins with their log-likelihoods) are kept
// in flat typed arrays instead of a vector of structs; the frame holds at most MAX_SYMBOLS symbols.

import { ENC, dataSymbols, gray, hamming, hammingDecode, headerChecksum, headerSfApp, payloadCrc, whitening } from './code';
import type { LoraHeader, LoraPayload } from './types';

/** Bins kept per soft symbol. */
export const SOFT_M = 4;
/** More than a 255-byte frame at any setting needs. */
export const MAX_SYMBOLS = 1100;

/** Soft symbols: the strongest bins of each symbol and their log-likelihoods (ln I0 of the noncoherent envelope). */
export class SoftSymbols {
	readonly bin: Uint16Array;
	readonly m: Float32Array;
	readonly floorM: Float32Array;
	readonly n: Uint8Array;
	constructor(size = MAX_SYMBOLS) {
		this.bin = new Uint16Array(size * SOFT_M);
		this.m = new Float32Array(size * SOFT_M);
		this.floorM = new Float32Array(size);
		this.n = new Uint8Array(size);
	}
	copyFrom(o: SoftSymbols, count: number): void {
		this.bin.set(o.bin.subarray(0, count * SOFT_M));
		this.m.set(o.m.subarray(0, count * SOFT_M));
		this.floorM.set(o.floorM.subarray(0, count));
		this.n.set(o.n.subarray(0, count));
	}
}

/** Bits of the codewords of one block: L[r * 8 + bit]. */
const llr = new Float32Array(12 * 8);
const b1 = new Float32Array(12);
const b0 = new Float32Array(12);
const cwHard = new Uint8Array(12);

/** Turns data symbol bins back into bytes: push each bin in order; after 8 the header is known, after needed() the payload. */
export class FrameDecoder {
	private sf = 11;
	private n = 0;
	private need = 8;
	private corrected = 0;
	/** Header nibbles in front of the payload (5, or 0 implicit). */
	private hn = 5;
	private ldro = false;
	private implicit = false;
	private fixed = false;
	private soft = false;
	header: LoraHeader = { len: 0, cr: 0, crc: false, ok: false };
	/** The hard bins pushed so far. */
	readonly bins = new Uint16Array(MAX_SYMBOLS);
	readonly sym = new SoftSymbols();
	private nib: number[] = [];

	start(sf: number, ldro: boolean): void {
		this.sf = sf;
		this.ldro = ldro;
		this.n = 0;
		this.need = 8;
		this.corrected = 0;
		this.hn = 5;
		this.implicit = false;
		this.fixed = false;
		this.soft = false;
		this.header = { len: 0, cr: 0, crc: false, ok: false };
		this.nib = [];
	}

	/** Implicit header: no header nibbles, the settings are known. */
	startImplicit(sf: number, ldro: boolean, len: number, cr: number, crc: boolean): void {
		this.start(sf, ldro);
		this.implicit = true;
		this.hn = 0;
		this.header = { len, cr, crc, ok: len > 0 && cr >= 5 && cr <= 8 };
		if (this.header.ok) this.need = dataSymbols({ sf, cr, ldro, crc, implicitHdr: true }, len);
	}

	get pushed(): number {
		return this.n;
	}
	/** Total data symbols of the frame (8 before the header is known). */
	get needed(): number {
		return this.need;
	}
	get done(): boolean {
		return this.header.ok && this.n >= this.need;
	}
	/** The CRC was only right after the soft list search. */
	get softFixed(): boolean {
		return this.fixed;
	}

	push(bin: number): void {
		if (this.n >= MAX_SYMBOLS) return;
		this.bins[this.n++] = bin;
		if (this.n !== 8) return;
		const sft = this.soft ? this.sym : null;
		this.corrected += blockInto(sft, this.bins, this.sf, 0, 8, headerSfApp(this.sf), this.sf >= 7, this.nib);
		if (this.implicit) return;
		const [n0, n1, n2, n3, n4] = this.nib;
		const h = this.header;
		h.len = (n0 << 4) | n1;
		h.crc = (n2 & 1) !== 0;
		h.cr = (n2 >> 1) + 4;
		h.ok = n3 <= 1 && headerChecksum(n0, n1, n2) === (((n3 & 1) << 4) | n4) && h.cr >= 5 && h.cr <= 8 && h.len > 0;
		if (h.ok) this.need = dataSymbols({ sf: this.sf, cr: h.cr, ldro: this.ldro, crc: h.crc, implicitHdr: false }, h.len);
	}

	/** The bin is the strongest of the soft symbol already written at index pushed of sym; the rest feeds the soft decoding. */
	pushSoft(): void {
		this.soft = true;
		this.push(this.sym.bin[this.n * SOFT_M]);
	}

	/** After done: the payload, whether its CRC was right, and how many codewords needed a correction. */
	finish(): LoraPayload | undefined {
		this.fixed = false;
		if (!this.done) return;
		const sft = this.soft ? this.sym : null;
		const first = this.decodeBlocks(sft);
		const out = this.assemble(first.nib);
		if (!out) return;
		out.corrected = first.corr;
		if (this.header.crc && !out.crcOk && sft) {
			const fixed = this.listDecode(sft);
			if (fixed) {
				this.fixed = true;
				return fixed;
			}
		}
		return out;
	}

	private decodeBlocks(sft: SoftSymbols | null, bins = this.bins): { nib: number[]; corr: number } {
		const sfApp = this.ldro ? this.sf - 2 : this.sf;
		const nib = this.nib.slice(0, headerSfApp(this.sf));
		let corr = this.corrected;
		const cr = this.header.cr;
		for (let at = 8; at + cr <= this.n; at += cr) corr += blockInto(sft, bins, this.sf, at, cr, sfApp, this.ldro, nib);
		return { nib, corr };
	}

	private assemble(nib: number[]): LoraPayload | undefined {
		const len = this.header.len,
			hn = this.hn;
		if (nib.length < hn + 2 * len + (this.header.crc ? 4 : 0)) return;
		const payload = new Uint8Array(len);
		for (let i = 0; i < len; i++) payload[i] = (nib[hn + 2 * i] | (nib[hn + 1 + 2 * i] << 4)) ^ whitening(i);
		let crcOk = false;
		if (this.header.crc) {
			const c = hn + 2 * len;
			crcOk = (nib[c] | (nib[c + 1] << 4) | (nib[c + 2] << 8) | (nib[c + 3] << 12)) === payloadCrc(payload, len);
		}
		return { payload, crcOk, corrected: 0 };
	}

	/**
	 * List decoding on the CRC: the K least certain symbols (smallest gap between their two strongest bins) are put to
	 * their runner-up bin in every combination; the cheapest combination whose CRC is right wins. 16 CRC bits against 63 tries.
	 */
	private listDecode(sft: SoftSymbols): LoraPayload | undefined {
		const K = 6;
		const marg: Array<[number, number]> = [];
		for (let s = 8; s < this.n; s++) if (sft.n[s] >= 2) marg.push([sft.m[s * SOFT_M] - sft.m[s * SOFT_M + 1], s]);
		marg.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
		const kk = Math.min(K, marg.length);
		const work = new SoftSymbols(this.n);
		work.copyFrom(sft, this.n);
		const bins = this.bins.slice(0, this.n);
		let bestCost = 1e30;
		let best: LoraPayload | undefined;
		for (let mask = 1; mask < 1 << kk; mask++) {
			let cost = 0;
			for (let t = 0; t < kk; t++) {
				const s = marg[t][1];
				const o = s * SOFT_M;
				for (let c = 0; c < SOFT_M; c++) {
					work.bin[o + c] = sft.bin[o + c];
					work.m[o + c] = sft.m[o + c];
				}
				work.n[s] = sft.n[s];
				work.floorM[s] = sft.floorM[s];
				if ((mask >> t) & 1) {
					work.bin[o] = sft.bin[o + 1];
					work.m[o] = 0;
					work.n[s] = 1;
					work.floorM[s] = -1e9;
					cost += marg[t][0];
				}
			}
			if (cost >= bestCost) continue;
			const { nib, corr } = this.decodeBlocks(work, bins);
			const pay = this.assemble(nib);
			if (pay?.crcOk) {
				bestCost = cost;
				best = { ...pay, corrected: corr };
			}
		}
		return best;
	}
}

/** The bits of symbol bin x of a block (reduced rate: the bin divided by 4). */
const symbolBits = (bin: number, nBins: number, sfApp: number, reduced: boolean): number => {
	const x = (bin + nBins - 1) % nBins;
	return reduced ? gray(((x + 2) >> 2) & ((1 << sfApp) - 1)) : gray(x);
};

/** Hard decisions: the codewords of the block from the bins, Hamming decoded. */
function hardBlock(bins: Uint16Array, nBins: number, at: number, cwLen: number, sfApp: number, reduced: boolean, nib: number[]): number {
	cwHard.fill(0);
	for (let i = 0; i < cwLen; i++) {
		const v = symbolBits(bins[at + i], nBins, sfApp, reduced);
		for (let j = 0; j < sfApp; j++) {
			const r = (((i - j - 1) % sfApp) + sfApp) % sfApp;
			cwHard[r] |= ((v >> (sfApp - 1 - j)) & 1) << (cwLen - 1 - i);
		}
	}
	let corr = 0;
	for (let r = 0; r < sfApp; r++) {
		nib.push(hammingDecode(cwHard[r], cwLen));
		if (hamming.errors) corr++;
	}
	return corr;
}

/** The per-bit log-likelihood ratios of the block's codewords from the symbols' strongest bins (into llr). */
function blockLlr(sft: SoftSymbols, nBins: number, at: number, cwLen: number, sfApp: number, reduced: boolean): void {
	llr.fill(0);
	for (let i = 0; i < cwLen; i++) {
		const s = at + i;
		const fm = sft.floorM[s];
		b1.fill(fm, 0, sfApp);
		b0.fill(fm, 0, sfApp);
		for (let c = 0; c < sft.n[s]; c++) {
			const v = symbolBits(sft.bin[s * SOFT_M + c], nBins, sfApp, reduced);
			const m = sft.m[s * SOFT_M + c];
			for (let j = 0; j < sfApp; j++) {
				const t = (v >> (sfApp - 1 - j)) & 1 ? b1 : b0;
				if (m > t[j]) t[j] = m;
			}
		}
		for (let j = 0; j < sfApp; j++) {
			const r = (((i - j - 1) % sfApp) + sfApp) % sfApp;
			const l = b1[j] - b0[j];
			llr[r * 8 + cwLen - 1 - i] = l > 1e4 ? 1e4 : l < -1e4 ? -1e4 : l;
		}
	}
}

/**
 * One interleaver block of cwLen symbols from symbol `at`: hard decisions, or (with the soft list) the maximum-likelihood
 * codeword per row from the per-bit log-likelihood ratios of the symbols' strongest bins. Appends the nibbles; returns the
 * codewords that needed a correction.
 */
export function blockInto(
	sft: SoftSymbols | null,
	bins: Uint16Array,
	sf: number,
	at: number,
	cwLen: number,
	sfApp: number,
	reduced: boolean,
	nib: number[],
): number {
	const nBins = 1 << sf;
	if (!sft) return hardBlock(bins, nBins, at, cwLen, sfApp, reduced, nib);
	blockLlr(sft, nBins, at, cwLen, sfApp, reduced);
	let corr = 0;
	for (let r = 0; r < sfApp; r++) {
		let best = 0,
			bs = -1e30,
			hard = 0;
		for (let b = 0; b < cwLen; b++) if (llr[r * 8 + b] > 0) hard |= 1 << b;
		for (let v = 0; v < 16; v++) {
			const e = ENC[cwLen * 16 + v];
			let sc = 0;
			for (let b = 0; b < cwLen; b++) if ((e >> b) & 1) sc += llr[r * 8 + b];
			if (sc > bs) {
				bs = sc;
				best = v;
			}
		}
		if (ENC[cwLen * 16 + best] !== hard) corr++;
		nib.push(best);
	}
	return corr;
}
