// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/marine/marine_dsc.cpp (DscDecoder),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: the call is returned through a callback object;
// the merge search is split into functions.

import { dscParseCall, type DscCall } from './call';
import { dscEcc, dscSymbolDecode, isEos, phasingAt } from './symbols';
import type { DscCandidates as Candidates, DscSymbol as Sym } from './types';

const MAX_SLOTS = 12 + 2 * 140;

/** The candidates of one information symbol: the valid DX copy first, then a different valid RX copy. */
function candidates(slots: readonly Sym[], dx: number, rx: number): Candidates {
	const out: Candidates = { v: [], conf: 0 };
	const d = slots[dx];
	const r = slots[rx];
	if (d && d.s >= 0) {
		out.v.push(d.s);
		out.conf = d.conf;
	}
	if (r && r.s >= 0 && (out.v.length === 0 || r.s !== out.v[0])) {
		out.v.push(r.s);
		if (out.v.length === 1) out.conf = r.conf;
	}
	return out;
}

/**
 * Fewest changes to the first choices that make the even parity right (symbol-level correction with time
 * diversity), at most three changes. Returns the body and the number of changes, or null.
 */
function searchParity(cands: Candidates[], eccPos: number, eos: number): { body: number[]; changes: number } | null {
	const order = cands
		.map((c, k) => ({ c, k }))
		.filter(({ c }) => c.v.length > 1)
		.sort((a, b) => a.c.conf - b.c.conf)
		.map(({ k }) => k);
	const pick = new Array<number>(cands.length).fill(0);
	const build = () => ({
		body: Array.from({ length: eccPos }, (_, k) => (cands[k].v.length ? cands[k].v[pick[k]] : -1)),
		ecc: cands[eccPos].v.length ? cands[eccPos].v[pick[eccPos]] : -1,
	});
	for (let maxChanges = 0; maxChanges <= 3; maxChanges++) {
		let found: { body: number[]; changes: number } | null = null;
		const dfs = (idx: number, left: number): void => {
			if (found) return;
			if (idx === order.length) {
				const { body, ecc } = build();
				if (body.every((v) => v >= 0) && ecc >= 0 && dscEcc(body, eos) === ecc) found = { body, changes: maxChanges - left };
				return;
			}
			const k = order[idx];
			for (let j = 0; j < cands[k].v.length; j++) {
				const cost = j > 0 ? 1 : 0;
				if (cost > left) break;
				pick[k] = j;
				dfs(idx + 1, left - cost);
				if (found) return;
			}
			pick[k] = 0;
		};
		dfs(0, maxChanges);
		if (found) return found;
	}
	return null;
}

/**
 * DSC call decoder working on bits (100 bd FSK on MF/HF, 1200 bd AFSK on VHF channel 70): finds the phasing
 * sequence, collects DX/RX symbols and merges the two copies with the check character.
 */
export class DscDecoder {
	private reg = 0;
	private readonly regConf = new Float64Array(10);
	private bitCount = 0;
	private hist: Sym[][] = Array.from({ length: 10 }, () => []);
	private lockedPhase = -1;
	private slots: Sym[] = [];
	callsOk = 0;
	callsBad = 0;

	constructor(
		private readonly onCall: (call: DscCall) => void,
		private readonly invert = false,
	) {}

	get locked(): boolean {
		return this.lockedPhase >= 0;
	}

	reset(): void {
		this.reg = 0;
		this.regConf.fill(0);
		this.bitCount = 0;
		this.abortLock();
	}

	private abortLock(): void {
		this.lockedPhase = -1;
		this.slots = [];
		this.hist = Array.from({ length: 10 }, () => []);
	}

	/** One received bit; soft > 0 = Y (1) before the inversion, |soft| 0..1 = how sure. */
	pushBit(soft: number): void {
		const bit = (soft > 0 ? 1 : 0) ^ (this.invert ? 1 : 0);
		this.reg = ((this.reg << 1) | bit) & 0x3ff;
		this.regConf.copyWithin(0, 1);
		this.regConf[9] = Math.min(1, Math.abs(soft));
		this.bitCount++;
		if (this.bitCount < 10) return;
		const phase = this.bitCount % 10;
		const symbol: Sym = { s: dscSymbolDecode(this.reg), conf: Math.min(...this.regConf) };
		if (this.locked) {
			if (phase !== this.lockedPhase) return;
			this.slots.push(symbol);
			this.tryFinish();
			return;
		}
		const h = this.hist[phase];
		h.push(symbol);
		if (h.length > 24) h.shift();
		if (symbol.s >= 0) this.huntPhasing(h, phase, symbol.s);
	}

	/** Phasing hunt: three symbols of the phasing sequence in their places (M.493 §3.3). */
	private huntPhasing(h: Sym[], phase: number, s: number): void {
		const n = h.length;
		let bestSlot = -1;
		let bestCount = 0;
		for (let slot = 0; slot < 16 && slot < n; slot++) {
			if (phasingAt(slot) !== s) continue;
			let count = 0;
			for (let j = 0; j <= slot; j++) if (h[n - 1 - j].s === phasingAt(slot - j)) count++;
			if (count > bestCount) {
				bestCount = count;
				bestSlot = slot;
			}
		}
		if (bestCount < 3) return;
		this.lockedPhase = phase;
		this.slots = h.slice(n - (bestSlot + 1));
		this.hist = Array.from({ length: 10 }, () => []);
		this.tryFinish();
	}

	/** DX symbol `i` (the copy in its own place), else its RX copy five places later. */
	private token(i: number): { value: number; pending: boolean } {
		const n = this.slots.length;
		const dx = 12 + 2 * i;
		const rx = dx + 5;
		const d = dx < n ? this.slots[dx].s : -1;
		const r = rx < n ? this.slots[rx].s : -1;
		return { value: d >= 0 ? d : r, pending: rx >= n };
	}

	private tryFinish(): void {
		const n = this.slots.length;
		if (n > MAX_SLOTS) return this.abortLock();
		if (n >= 60 && this.carrierGone()) return;
		if (n < 12 + 2 * 3) return;
		// The end of sequence: the first of 117, 122, 127 among the information symbols after the format specifiers.
		let eosIdx = -1;
		const maxToken = Math.floor((n - 1 - 12) / 2);
		for (let i = 2; i <= maxToken; i++) {
			const t = this.token(i);
			if (t.pending) break;
			if (isEos(t.value)) {
				eosIdx = i;
				break;
			}
		}
		if (eosIdx < 0 || this.token(eosIdx + 1).pending) return; // wait for the retransmission of the ECC
		this.finish(eosIdx);
	}

	/** The last 30 slots hold almost no valid symbol: report a long enough partial call as failed, drop the rest. */
	private carrierGone(): boolean {
		const n = this.slots.length;
		let bad = 0;
		for (let k = n - 30; k < n; k++) if (this.slots[k].s < 0) bad++;
		if (bad < 24) return false;
		if (n >= 12 + 2 * 8 + 30) {
			const lastGood = n - 30;
			const body = [n > 12 ? this.slots[12].s : -1];
			let erasures = 0;
			for (let i = 2; 12 + 2 * i < lastGood; i++) {
				const d = this.slots[12 + 2 * i].s;
				const r = 12 + 2 * i + 5 < n ? this.slots[12 + 2 * i + 5].s : -1;
				const m = d >= 0 ? d : r;
				if (m < 0) erasures++;
				body.push(m);
			}
			this.callsBad++;
			this.onCall(dscParseCall(body, -1, false, erasures));
		}
		this.abortLock();
		return true;
	}

	private finish(eosIdx: number): void {
		const slots = this.slots;
		// The format specifier is sent twice in each place: four copies.
		const first: Candidates = { v: [], conf: 0 };
		let firstKnown = false;
		for (const dx of [12, 14]) {
			const t = candidates(slots, dx, dx + 5);
			if (!t.v.length) continue;
			firstKnown = true;
			for (const v of t.v) if (!first.v.includes(v)) first.v.push(v);
			if (first.conf === 0) first.conf = t.conf;
		}
		const cands: Candidates[] = [firstKnown ? first : candidates(slots, 12, 17)];
		for (let i = 2; i < eosIdx; i++) cands.push(candidates(slots, 12 + 2 * i, 12 + 2 * i + 5));
		const eccPos = cands.length;
		cands.push(candidates(slots, 12 + 2 * (eosIdx + 1), 12 + 2 * (eosIdx + 1) + 5));
		const eos = this.token(eosIdx).value;
		const unknown = cands.slice(0, eccPos).flatMap((c, k) => (c.v.length ? [] : [k]));
		let body: number[] = cands.slice(0, eccPos).map((c) => (c.v.length ? c.v[0] : -1));
		let eccOk = false;
		let repaired = 0;
		let recovered = false;
		const eccKnown = cands[eccPos].v.length > 0;
		if (eccKnown && unknown.length === 0) {
			const found = searchParity(cands, eccPos, eos);
			if (found) [body, repaired, eccOk] = [found.body, found.changes, true];
		}
		if (!eccOk && eccKnown && unknown.length === 1 && cands.every((c, k) => k === unknown[0] || c.v.length <= 1)) {
			// One symbol lost in both copies: the check character gives it back.
			let x = eos & 127;
			for (let k = 0; k < eccPos; k++) if (k !== unknown[0]) x ^= body[k] & 127;
			body[unknown[0]] = x ^ (cands[eccPos].v[0] & 127);
			[eccOk, recovered, repaired] = [true, true, 1];
		}
		const call = dscParseCall(body, eos, eccOk, recovered ? 0 : unknown.length);
		call.repaired = repaired;
		if (eccOk) this.callsOk++;
		else this.callsBad++;
		this.abortLock();
		this.onCall(call);
	}
}
