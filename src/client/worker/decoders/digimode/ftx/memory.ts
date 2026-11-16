// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/hfdig/hfdig_ftx.cpp (XMem, isGridTok, isCallTok, msgTokens and
// SlotDecoder::buildAp: what the decoder remembers from slot to slot, and the a-priori hypotheses taken from it),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: the hypotheses are cached on the memory (by its
// version) instead of on each slot's decoder.

import { pack77 } from './pack';
import type { FtxApHyp, FtxCaller, FtxPair, FtxStored } from './types';

/** Slots the soft bits of a candidate that did not decode are kept for. */
const X_SLOTS = 6;
/** Candidates kept at most. */
const MAX_STORED = 1500;

const isGridTok = (t: string): boolean =>
	(t.length === 4 || t.length === 6) &&
	t[0] >= 'A' &&
	t[0] <= 'R' &&
	t[1] >= 'A' &&
	t[1] <= 'R' &&
	t[2] >= '0' &&
	t[2] <= '9' &&
	t[3] >= '0' &&
	t[3] <= '9';

/** Calls in a message: tokens with digits and letters that are not a grid, a report or a closing word. */
function isCallTok(t: string): boolean {
	if (t.length < 3 || t.length > 13) return false;
	let dig = false;
	let letter = false;
	for (const c of t) {
		if (c >= '0' && c <= '9') dig = true;
		else if (c >= 'A' && c <= 'Z') letter = true;
		else if (c !== '/') return false;
	}
	return dig && letter && !isGridTok(t) && t !== 'RR73';
}

const msgTokens = (m: string): string[] =>
	m
		.replace(/[<>]/g, '')
		.split(' ')
		.filter((w) => w.length > 0);

/** What the decoder remembers from slot to slot (FT8 / FT4). */
export class XMem {
	/** Soft bits of candidates that did not decode. */
	st: FtxStored[] = [];
	/** "A B ..." heard: A called B (or answered). */
	pairs: FtxPair[] = [];
	/** "CQ X ..." heard. */
	callers: FtxCaller[] = [];
	version = 0;
	private apVersion = -1;
	private ap: FtxApHyp[] = [];

	clear(): void {
		this.st = [];
		this.pairs = [];
		this.callers = [];
		this.version++;
	}

	prune(nowUtc: number, period: number): void {
		const keep = nowUtc - (X_SLOTS + 0.5) * period;
		this.st = this.st.filter((e) => e.slotUtc >= keep);
		const keepCalls = nowUtc - 8.5 * period;
		this.pairs = this.pairs.filter((p) => p.slotUtc >= keepCalls);
		this.callers = this.callers.filter((c) => c.slotUtc >= keepCalls);
		this.version++;
	}

	heard(msg: string, slotUtc: number): void {
		const t = msgTokens(msg);
		if (t.length < 2) return;
		if (t[0] === 'CQ') {
			const call = t.slice(1).find(isCallTok);
			if (!call || this.callers.some((c) => c.call === call && c.slotUtc === slotUtc)) return;
			this.callers.push({ call, slotUtc });
			this.version++;
		} else if (isCallTok(t[0]) && isCallTok(t[1])) {
			if (this.pairs.some((p) => p.a === t[0] && p.b === t[1] && p.slotUtc === slotUtc)) return;
			this.pairs.push({ a: t[0], b: t[1], slotUtc });
			this.version++;
		}
	}

	store(e: FtxStored): void {
		this.st.push(e);
		if (this.st.length > MAX_STORED) this.st.splice(0, this.st.length - MAX_STORED);
	}

	/**
	 * The a-priori hypotheses from the conversations heard: the bits of the calls taken as known, the six newest pairs
	 * (both orders) and the six newest callers (rebuilt when the memory changed).
	 */
	hypotheses(): FtxApHyp[] {
		if (this.apVersion === this.version) return this.ap;
		this.apVersion = this.version;
		const done = new Set<string>();
		this.ap = [];
		const add = (c1: string, c2: string, pair: boolean): void => {
			const key = c1 + (pair ? ' ' + c2 : '');
			if (done.has(key)) return;
			done.add(key);
			const bits = new Uint8Array(77);
			if (!pack77(`${c1} ${pair ? `${c2} RR73` : 'K1ABC FN42'}`, bits)) return;
			this.ap.push({ bits, lo: pair ? 58 : 29, pair });
		};
		for (const p of this.pairs.slice(-6).reverse()) {
			add(p.a, p.b, true);
			add(p.b, p.a, true);
		}
		for (const c of this.callers.slice(-6).reverse()) add(c.call, '', false);
		return this.ap;
	}
}
