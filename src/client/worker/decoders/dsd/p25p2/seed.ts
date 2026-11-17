// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/p25p2/p25p2_rx.cpp (setSystem, applySystem: where the descrambler
// seed comes from) and core/src/p25p2/p25p2_proto.cpp (scrambleSeq, macEncodeAir: the sequence and the MAC PDU code it
// solves against, here p25p2Scramble and the air coding of protocol.ts), https://github.com/adswill/OnAir; see
// third_party/onair.
// Changes: the solver is BrowSDR's own. OnAir takes the seed (WACN, system ID, NAC) from the user or from its Phase 1
// trunking follower; BrowSDR has neither, so the seed is solved from one scrambled SACCH or FACCH burst: the scrambling
// sequence is linear in the 44 seed bits and the MAC PDU code is linear over GF(2), so the parity check of the received
// bits depends on the seed alone: 114 (FACCH) or 132 (SACCH) equations in 44 unknowns. A burst with bit errors gives an
// inconsistent system (and is skipped); the receiver keeps a solution only when the burst then decodes, CRC-12 included.
import { P25P2_BURST_DIBITS, PAYLOAD_DIBITS, PAYLOAD_POS, airLayout, airSymbols, p25p2Scramble } from './protocol';
import { rsEncode } from './rs';
import type { P25p2Seed } from './types';

const SEED_BITS = 44;

/** The parity check of the received MAC codeword, one bit per element: zero for a codeword (the shortened symbols zero). */
function syndrome(facch: boolean, payload: ArrayLike<number>): Uint8Array {
	const { first, nSent } = airLayout(facch);
	const rx = airSymbols(facch, payload);
	const sym = new Uint8Array(63);
	sym.set(rx.subarray(first, 35), first);
	rsEncode(sym, 63, 35);
	const np = first + nSent - 35;
	const bits = new Uint8Array(np * 6);
	for (let r = 0; r < bits.length; r++) bits[r] = ((sym[35 + Math.floor(r / 6)] ^ rx[35 + Math.floor(r / 6)]) >> (5 - (r % 6))) & 1;
	return bits;
}

/** Solves the descrambler seed from a scrambled SACCH or FACCH burst. */
export class P25p2SeedSolver {
	/** The scrambling sequence of each single seed bit (bit 0: the NAC's least significant). */
	private units: Uint8Array[] = [];
	/** By slot and burst kind: each parity check bit as a 44-bit row (low 32 bits, top 12 bits). */
	private rows = new Map<number, { lo: Int32Array; hi: Int32Array }>();

	private matrix(slot: number, facch: boolean): { lo: Int32Array; hi: Int32Array } {
		const key = slot * 2 + (facch ? 1 : 0);
		const cached = this.rows.get(key);
		if (cached) return cached;
		// seed bit j: NAC bits 0..11, system ID bits 12..23, WACN bits 24..43 (the sequence is linear in them)
		if (!this.units.length)
			for (let j = 0; j < SEED_BITS; j++)
				this.units.push(p25p2Scramble(j >= 24 ? 1 << (j - 24) : 0, j >= 12 && j < 24 ? 1 << (j - 12) : 0, j < 12 ? 1 << j : 0));
		const pattern = new Uint8Array(PAYLOAD_DIBITS);
		let lo = new Int32Array(0);
		let hi = new Int32Array(0);
		for (let j = 0; j < SEED_BITS; j++) {
			const seq = this.units[j];
			for (let k = 0; k < PAYLOAD_DIBITS; k++) pattern[k] = seq[slot * P25P2_BURST_DIBITS + PAYLOAD_POS[k]];
			const s = syndrome(facch, pattern);
			if (!lo.length) [lo, hi] = [new Int32Array(s.length), new Int32Array(s.length)];
			for (let r = 0; r < s.length; r++) {
				if (!s[r]) continue;
				if (j < 32) lo[r] |= 1 << j;
				else hi[r] |= 1 << (j - 32);
			}
		}
		const m = { lo, hi };
		this.rows.set(key, m);
		return m;
	}

	/** The seed that makes the burst's MAC payload (as received, scrambled) a codeword; null when none or not one. */
	solve(slot: number, facch: boolean, payload: ArrayLike<number>): P25p2Seed | null {
		const m = this.matrix(slot, facch);
		const lo = m.lo.slice();
		const hi = m.hi.slice();
		const rhs = syndrome(facch, payload);
		const rows = rhs.length;
		const pivot = new Int32Array(SEED_BITS);
		let rank = 0;
		for (let col = 0; col < SEED_BITS; col++) {
			const half = col < 32 ? lo : hi;
			const mask = 1 << (col & 31);
			let p = rank;
			while (p < rows && !(half[p] & mask)) p++;
			if (p === rows) return null; // the burst does not determine this seed bit
			[lo[p], lo[rank]] = [lo[rank], lo[p]];
			[hi[p], hi[rank]] = [hi[rank], hi[p]];
			[rhs[p], rhs[rank]] = [rhs[rank], rhs[p]];
			for (let r = 0; r < rows; r++) {
				if (r === rank || !(half[r] & mask)) continue;
				lo[r] ^= lo[rank];
				hi[r] ^= hi[rank];
				rhs[r] ^= rhs[rank];
			}
			pivot[col] = rank++;
		}
		for (let r = rank; r < rows; r++) if (rhs[r]) return null; // inconsistent: bit errors in the burst
		let sLo = 0;
		let sHi = 0;
		for (let col = 0; col < SEED_BITS; col++) {
			if (!rhs[pivot[col]]) continue;
			if (col < 32) sLo |= 1 << col;
			else sHi |= 1 << (col - 32);
		}
		return { wacn: ((sHi << 8) | (sLo >>> 24)) & 0xfffff, sysId: (sLo >>> 12) & 0xfff, nac: sLo & 0xfff };
	}
}
