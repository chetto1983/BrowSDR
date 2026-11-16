// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/mesh/mesh_lora_code.cpp (JumpSearch, recoverJumps: samples lost
// before the demodulator shift every later symbol of a frame by the same number of bins), https://github.com/adswill/OnAir;
// see third_party/onair. LoRa facts as credited there: gr-lora_sdr (Joachim Tapparel, EPFL, and contributors, GPL-3.0).
// Changes: the parity of a block is checked with a table of the codewords (the same answer as hammingDecode, faster);
// the frames are Uint16Arrays.

import { gray, isCodeword } from './code';
import { FrameDecoder } from './frame';

/** C lround: halves away from zero. */
const lround = (x: number): number => Math.sign(x) * Math.round(Math.abs(x));
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/** Depth-first search: the first block whose parity fails holds the jump; every symbol of it is tried as the first moved one. */
class JumpSearch {
	solutions = 0;
	bestJumps = 0;
	best?: Uint8Array;
	/** Blocks checked; the search gives up (no recovery) past the budget. */
	work = 0;
	shifts: number[] = [];
	private readonly cw = new Uint32Array(12);

	constructor(
		readonly sf: number,
		readonly ldro: boolean,
		readonly cr: number,
		readonly maxJumps: number,
		readonly budget: number,
	) {}

	get n(): number {
		return 1 << this.sf;
	}
	get overBudget(): boolean {
		return this.work > this.budget;
	}

	/** The block at `at` with every symbol from `from` on moved down by d bins (from = -1: as it is). */
	blockClean(b: Uint16Array, at: number, from = -1, d = 0): boolean {
		this.work++;
		const cr = this.cr,
			n = this.n;
		if (at + cr > b.length) return true;
		const sfApp = this.ldro ? this.sf - 2 : this.sf;
		const cw = this.cw;
		cw.fill(0);
		for (let i = 0; i < cr; i++) {
			const raw = b[at + i] - (from >= 0 && at + i >= from ? d : 0);
			const x = (raw + 2 * n - 1) % n;
			const v = this.ldro ? gray(((x + 2) >> 2) & ((1 << sfApp) - 1)) : gray(x);
			for (let j = 0; j < sfApp; j++) {
				const r = (((i - j - 1) % sfApp) + sfApp) % sfApp;
				cw[r] |= ((v >> (sfApp - 1 - j)) & 1) << (cr - 1 - i);
			}
		}
		// hammingDecode reports an error exactly when the word is not a codeword
		for (let r = 0; r < sfApp; r++) if (!isCodeword(cw[r], cr)) return false;
		return true;
	}

	solve(b: Uint16Array, fromBlock: number, depth: number): void {
		if (this.solutions > 1 || this.overBudget) return;
		const cr = this.cr;
		const nb = Math.floor((b.length - 8) / cr);
		let fb = -1;
		for (let k = fromBlock; k < nb; k++)
			if (!this.blockClean(b, 8 + k * cr)) {
				fb = k;
				break;
			}
		if (fb < 0) {
			if (depth > 0) this.candidate(b, depth);
			return;
		}
		if (depth === this.maxJumps) return;
		const s0 = 8 + fb * cr;
		for (let j = s0; j < s0 + cr; j++)
			for (const d of this.shifts) {
				if (this.solutions > 1 || this.overBudget) return;
				if (!this.blockClean(b, s0, j, d)) continue;
				const c = b.slice();
				for (let i = j; i < c.length; i++) c[i] = (c[i] - d + this.n) % this.n;
				this.solve(c, fb + 1, depth + 1);
			}
	}

	/** Every block is clean: the payload counts when its CRC is right (the same payload by another path is one solution). */
	private candidate(b: Uint16Array, depth: number): void {
		const fd = new FrameDecoder();
		fd.start(this.sf, this.ldro);
		for (const v of b) {
			fd.push(v);
			if (fd.done) break;
		}
		const r = fd.done ? fd.finish() : undefined;
		if (!r?.crcOk) return;
		if (this.solutions === 0) {
			this.solutions = 1;
			this.best = r.payload;
			this.bestJumps = depth;
		} else if (!this.best || !sameBytes(r.payload, this.best)) this.solutions = 2;
		else this.bestJumps = Math.min(this.bestJumps, depth);
	}
}

/** Shifts of m x quantum +- 2 bins (m = +-1..+-15), each once modulo 2^sf. */
function quantumShifts(n: number, quantum: number): number[] {
	const shifts: number[] = [];
	for (let m = -15; m <= 15; m++)
		for (let e = -2; e <= 2 && m; e++) {
			const d = (((lround(m * quantum) + e) % n) + n) % n;
			if (d && !shifts.includes(d)) shifts.push(d);
		}
	return shifts;
}

/**
 * For an explicit-header frame whose CRC failed: finds up to maxJumps points where the later symbols moved by the same
 * number of bins, trying shifts of m x quantum +- 2 bins (m = +-1..+-15), then any shift. The payload is taken only when
 * every block's parity is clean, the CRC is right and exactly one solution exists. Returns it and the jumps undone.
 */
export function recoverJumps(
	sf: number,
	ldro: boolean,
	bins: Uint16Array,
	quantum: number,
	maxJumps = 3,
): { payload: Uint8Array; jumps: number } | undefined {
	if (bins.length < 8 || quantum <= 0 || maxJumps <= 0) return;
	const hd = new FrameDecoder();
	hd.start(sf, ldro);
	for (let i = 0; i < 8; i++) hd.push(bins[i]);
	if (!hd.header.ok || !hd.header.crc) return;
	const js = new JumpSearch(sf, ldro, hd.header.cr, maxJumps, 200000);
	js.shifts = quantumShifts(js.n, quantum);
	js.solve(bins, 0, 0);
	if (js.solutions === 1 && !js.overBudget && js.best) return { payload: js.best, jumps: js.bestJumps };
	if (js.solutions !== 0 || js.overBudget || maxJumps < 2) return;
	// Nothing at the usual quantum: a link drops whatever count of samples it drops; every shift, one or two jumps.
	const all = new JumpSearch(sf, ldro, js.cr, 2, 1500000);
	for (let d = 1; d < js.n; d++) all.shifts.push(d);
	all.solve(bins, 0, 0);
	if (all.solutions !== 1 || all.overBudget || !all.best) return;
	return { payload: all.best, jumps: all.bestJumps };
}
