// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/cw/cw_decoder.cpp (the Morse table as a trie, Hyp and sameHyp,
// FistDecoder::Impl's beam search: select, emitTok, emitChar, emitWordEnd, extendMark, extendSpace, commit,
// commitAfterStep, and the queue of committed characters with its confirmation), https://github.com/adswill/OnAir; see
// third_party/onair. Changes: the beam is a class of its own over a fixed pool of hypotheses; the trace output and the
// live alternatives are left out.

import { lmLogP, lmSymbol, lmWordBonus, LM_SPACE } from './lm';
import { lpGauss, TUNE, type FistModel } from './model';
import { decodeSymbol } from './morse';
import type { DecTok } from './types';

const BEAM = 32;
const CAND = BEAM * 3 + 4;
const PEND = 28;
const WORD = 16;
const OUT_Q = 512;

/** The Morse table as a trie: node 1, then 2n (dot) / 2n + 1 (dash). */
const TRIE = (() => {
	const nodeText = new Array<string | undefined>(1024);
	const nodeSym = new Uint8Array(1024);
	const alive = new Uint8Array(1024);
	const tok: string[] = [];
	const tokOf = (t: string) => {
		const i = tok.indexOf(t);
		return i >= 0 ? i : tok.push(t) - 1;
	};
	for (let len = 1; len <= 9; len++)
		for (let bits = 0; bits < 1 << len; bits++) {
			let code = '';
			for (let b = len - 1; b >= 0; b--) code += (bits >> b) & 1 ? '-' : '.';
			const t = decodeSymbol(code);
			if (!t) continue;
			const node = (1 << len) | bits;
			nodeText[node] = t;
			nodeSym[node] = tokOf(t);
		}
	const space = tokOf(' ');
	const unknown = tokOf('*');
	for (let n = 1023; n >= 1; n--) alive[n] = nodeText[n] || (n < 512 && (alive[2 * n] || alive[2 * n + 1])) ? 1 : 0;
	const tokLm = Uint8Array.from(tok, (t) => lmSymbol(t));
	return { nodeText, nodeSym, alive, tok, tokLm, space, unknown };
})();

const hasChild = (n: number) => n < 512 && (TRIE.alive[2 * n] || TRIE.alive[2 * n + 1]) === 1;

/** One reading of the text not committed yet. */
export class Hyp {
	score = 0;
	/** The code of the character in progress (1 none; 0 not a Morse code). */
	node = 1;
	nPend = 0;
	wLen = 0;
	c1 = LM_SPACE;
	c2 = LM_SPACE;
	/** The worst z of the elements of the character in progress, x40. */
	zc = 0;
	/** At the start of a word: a mark here may be noise in the pause. */
	atWord = 1;
	/** The last mark was read as noise: the gap after it goes on with the pause. */
	skip = 0;
	readonly pend = new Uint8Array(PEND);
	readonly pz = new Uint8Array(PEND);
	readonly word = new Uint8Array(WORD);

	copy(o: Hyp): this {
		this.score = o.score;
		this.node = o.node;
		this.nPend = o.nPend;
		this.wLen = o.wLen;
		this.c1 = o.c1;
		this.c2 = o.c2;
		this.zc = o.zc;
		this.atWord = o.atWord;
		this.skip = o.skip;
		this.pend.set(o.pend);
		this.pz.set(o.pz);
		this.word.set(o.word);
		return this;
	}

	clear(): this {
		return this.copy(EMPTY);
	}

	same(b: Hyp): boolean {
		if (this.node !== b.node || this.nPend !== b.nPend || this.c1 !== b.c1 || this.c2 !== b.c2) return false;
		if (this.wLen !== b.wLen || this.skip !== b.skip) return false;
		for (let i = 0; i < this.nPend; i++) if (this.pend[i] !== b.pend[i]) return false;
		for (let i = 0; i < this.wLen; i++) if (this.word[i] !== b.word[i]) return false;
		return true;
	}

	/** z (as a multiple of the spread) of an element into the worst of the character. */
	worst(z: number): void {
		this.zc = Math.max(this.zc, Math.trunc(Math.min(255, z * 40)));
	}
}

const EMPTY = new Hyp();

/** The beam search over the segmentations, and the queue of committed characters. */
export class Beam {
	readonly hyp = Array.from({ length: BEAM }, () => new Hyp());
	nh = 1;
	private readonly cand = Array.from({ length: CAND }, () => new Hyp());
	private readonly tmp = new Hyp();
	private readonly out: DecTok[] = new Array<DecTok>(OUT_Q);
	private oh = 0;
	private ot = 0;
	/** Characters before this index may be popped. */
	private vis = 0;
	private lastSpace = true;
	/** The signal has shown Morse timing: text is released. */
	confirmed = false;

	reset(): void {
		this.nh = 1;
		this.hyp[0].clear();
		this.oh = this.ot = this.vis = 0;
		this.lastSpace = true;
		this.confirmed = false;
	}

	/** One reading from here on (the lock dropped, or the idle flush). */
	single(): void {
		this.nh = 1;
		this.hyp[0].clear();
	}

	/** Releases what was held back: the signal is Morse. */
	confirm(): void {
		this.confirmed = true;
		this.vis = this.ot;
	}

	/** The held text was noise. */
	drop(): void {
		this.ot = this.vis;
		this.confirmed = false;
	}

	get ready(): boolean {
		return this.oh !== this.vis;
	}

	pop(): DecTok[] {
		const toks: DecTok[] = [];
		while (this.oh !== this.vis) {
			toks.push(this.out[this.oh]);
			this.oh = (this.oh + 1) % OUT_Q;
		}
		return toks;
	}

	private push(text: string, conf: number, alt: string): void {
		if (text === ' ') {
			if (this.lastSpace) return;
			this.lastSpace = true;
		} else this.lastSpace = false;
		const nt = (this.ot + 1) % OUT_Q;
		if (nt === this.oh) this.oh = (this.oh + 1) % OUT_Q; // full: the oldest goes
		this.out[this.ot] = { text, conf: Math.max(0, Math.min(100, conf)), alt };
		this.ot = nt;
		if (this.confirmed) this.vis = this.ot;
	}

	private select(nc: number): void {
		const sorted = this.cand.slice(0, nc).sort((a, b) => b.score - a.score);
		const floor = sorted[0].score - 22;
		this.nh = 0;
		for (const c of sorted) {
			if (this.nh >= BEAM || c.score < floor) break;
			let dup = false;
			for (let j = 0; j < this.nh && !dup; j++) dup = this.hyp[j].same(c);
			if (!dup) this.hyp[this.nh++].copy(c);
		}
	}

	private static emitTok(h: Hyp, sym: number, lmw: number): void {
		if (h.nPend >= PEND) return;
		const lm = TRIE.tokLm[sym];
		h.score += lmw * lmLogP(h.c2, h.c1, lm);
		h.c2 = h.c1;
		h.c1 = lm;
		h.pend[h.nPend] = sym;
		h.pz[h.nPend] = h.zc;
		h.nPend++;
		if (sym !== TRIE.space && h.wLen < WORD) h.word[h.wLen++] = lm;
	}

	private static emitChar(h: Hyp): void {
		if (h.node >= 2 && TRIE.nodeText[h.node]) Beam.emitTok(h, TRIE.nodeSym[h.node], TUNE.lmWeight);
		else {
			h.score -= 6;
			Beam.emitTok(h, TRIE.unknown, TUNE.lmWeight);
		}
		h.node = 1;
		h.zc = 0;
	}

	private static emitWordEnd(h: Hyp): void {
		h.score += TUNE.wordWeight * lmWordBonus(h.word, h.wLen);
		Beam.emitTok(h, TRIE.space, TUNE.lmWeight);
		h.wLen = 0;
		h.atWord = 1;
	}

	/**
	 * A mark (ln ms): a dot or a dash of every reading. In the pause before a word the detector may open on noise: that
	 * reading is kept beside the others, with the learned rate of noise in the gaps, and the character model decides.
	 */
	extendMark(x: number, m: FistModel, rSpike: number): void {
		const ld = lpGauss(x, m.L, m.sd) - 0.6;
		const lD = lpGauss(x, m.L + m.ldr, m.sD) - 0.8;
		const zd = Math.abs(x - m.L) / m.sd;
		const zD = Math.abs(x - m.L - m.ldr) / m.sD;
		const best = Math.max(ld, lD);
		const lNoise = x < m.L + 0.4 ? Math.log(Math.max(0.003, Math.min(0.3, rSpike))) + lpGauss(x, m.L - 0.7, 0.5) : -1e9;
		let nc = 0;
		for (let i = 0; i < this.nh; i++) {
			const h = this.hyp[i];
			if (h.atWord && h.node === 1 && lNoise > best - 9) {
				const c = this.cand[nc++].copy(h);
				c.score += lNoise;
				c.skip = 1;
			}
			for (let dash = 0; dash < 2; dash++) {
				const ll = dash ? lD : ld;
				if (ll < best - 9) continue;
				const c = this.cand[nc++].copy(h);
				c.score += ll;
				c.worst(dash ? zD : zd);
				if (c.node !== 0) {
					const nn = c.node * 2 + dash;
					if (c.node >= 512 || !TRIE.alive[nn]) {
						c.node = 0;
						c.score -= 7;
					} else c.node = nn;
				}
				c.atWord = c.skip = 0;
			}
		}
		this.select(nc);
	}

	/** A gap (ln ms): inside a character, the end of one, or the end of a word. wordOnly: the idle flush. */
	extendSpace(x: number, wordOnly: boolean, m: FistModel): void {
		const li = lpGauss(x, m.L + m.gi, m.si) - 0.6;
		const lc = lpGauss(x, m.L + m.gc, m.sc) - 1.05;
		const lw = lpGauss(Math.min(x, m.L + m.gw), m.L + m.gw, m.sw) - 2.3;
		const zi = Math.abs(x - m.L - m.gi) / m.si;
		const zc = Math.abs(x - m.L - m.gc) / m.sc;
		const zw = Math.max(0, m.L + m.gw - x) / m.sw;
		let nc = 0;
		for (let i = 0; i < this.nh; i++) {
			const h = this.hyp[i];
			if (h.skip) {
				// the gap after a noise mark: still the pause (the word gap was scored before the mark)
				this.cand[nc++].copy(h).skip = 0;
				continue;
			}
			if (!wordOnly && (h.node === 0 || hasChild(h.node))) {
				const c = this.cand[nc++].copy(h);
				c.score += li;
				c.worst(zi);
			}
			if (!wordOnly) {
				const c = this.cand[nc++].copy(h);
				c.worst(zc);
				c.score += lc;
				Beam.emitChar(c);
			}
			if (wordOnly && h.node === 1) {
				this.cand[nc++].copy(h); // nothing in progress (the word was ended by its gap already): the pause goes on
				continue;
			}
			const c = this.cand[nc++].copy(h);
			c.worst(zw);
			c.score += lw;
			Beam.emitChar(c);
			Beam.emitWordEnd(c);
		}
		this.select(nc);
	}

	/** Commits the first k characters of the best reading, with a confidence and the best other reading. */
	commit(k0: number): void {
		if (k0 <= 0) return;
		const best = this.tmp.copy(this.hyp[0]);
		const k = Math.min(k0, best.nPend);
		const w = this.hyp.slice(0, this.nh).map((h) => Math.exp(h.score - best.score));
		const tot = w.reduce((a, b) => a + b, 0);
		for (let j = 0; j < k; j++) {
			let [same, altW, altSym] = [0, 0, -1];
			for (let i = 0; i < this.nh; i++) {
				const h = this.hyp[i];
				if (h.nPend > j && h.pend[j] === best.pend[j]) same += w[i];
				else if (h.nPend > j && w[i] > altW) [altW, altSym] = [w[i], h.pend[j]];
			}
			let conf = tot > 0 ? same / tot : 1;
			const z = best.pz[j];
			if (z > 160) conf *= 0.5;
			else if (z > 100) conf *= 0.75;
			const alt = altSym >= 0 && altW >= 0.03 * tot && altSym !== best.pend[j] ? TRIE.tok[altSym] : '';
			this.push(TRIE.tok[best.pend[j]], Math.round(conf * 100), alt);
		}
		let keep = 0;
		for (let i = 0; i < this.nh; i++) {
			const h = this.hyp[i];
			let match = h.nPend >= k;
			for (let j = 0; j < k && match; j++) match = h.pend[j] === best.pend[j];
			if (!match) continue;
			const c = this.hyp[keep++];
			if (c !== h) c.copy(h);
			c.nPend -= k;
			c.pend.copyWithin(0, k, k + c.nPend);
			c.pz.copyWithin(0, k, k + c.nPend);
		}
		this.nh = Math.max(1, keep);
	}

	/** After a gap: commits what the beam agrees on, and what is older than TUNE.delay characters. */
	commitAfterStep(): void {
		const best = this.hyp[0];
		let agree = best.nPend;
		for (let i = 1; i < this.nh; i++) {
			const h = this.hyp[i];
			if (h.score < best.score - 14) break;
			let j = 0;
			while (j < agree && j < h.nPend && h.pend[j] === best.pend[j]) j++;
			agree = Math.min(agree, j);
		}
		this.commit(Math.max(agree, Math.max(0, best.nPend - TUNE.delay)));
	}
}
