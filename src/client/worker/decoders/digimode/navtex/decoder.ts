// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/marine/marine_navtex.cpp (NavtexDecoder: bit phase lock, bit
// slips, DX/RX parity, time diversity, ZCZC ... NNNN framing), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: no character callback (OnAir's SITOR-B mode) and no diagnostics; the header of a message in progress can
// be read (status line).

import { ccir476Char, FIGS, isControl, LTRS, navtexSubjectName, popcount7, ALPHA, BETA, REP, ccir476Valid } from './code';
import type { NavtexMessage, NavtexSlot } from './types';

/** Places a character waits after its retransmission has arrived. */
const HOLD = 16;
const HISTORY = 32;
const MAX_SLOTS = 256;
const VALID_CODES = Array.from({ length: 128 }, (_, c) => c).filter(ccir476Valid);

const isPhasing = (c: number) => c === ALPHA || c === BETA || c === REP;

function newSlot(code: number, valid: boolean, endBit: number): NavtexSlot {
	return { code, valid, bit: new Uint8Array(7), conf: new Float64Array(7), endBit };
}

const EMPTY_SLOT = newSlot(0, false, 0);

/** ZCZC / NNNN with up to one unreadable character. */
function matchWord(tail: string, word: string): boolean {
	if (tail.length < 4) return false;
	let ok = 0;
	let star = 0;
	for (let i = 0; i < 4; i++) {
		if (tail[i] === word[i]) ok++;
		else if (tail[i] === '*') star++;
	}
	return ok >= 3 && ok + star === 4;
}

/**
 * NAVTEX / SITOR-B (FEC) receiver on bits: CCIR 476 code (ITU-R M.476, M.625), time diversity, ZCZC ... NNNN framing
 * (ITU-R M.540). One soft bit per call; soft > 0 is the 'B' (1) state of the code, |soft| 0..1 how sure.
 */
export class NavtexDecoder {
	private readonly reg = new Uint8Array(7);
	private readonly regConf = new Float64Array(7);
	private bitCount = 0;
	private readonly validRun = new Int32Array(7);
	// Per bit phase: the last 32 code words.
	private readonly hcode = new Uint8Array(7 * HISTORY);
	private readonly hvalid = new Uint8Array(7 * HISTORY);
	private readonly hconf = new Float64Array(7 * HISTORY);
	private readonly hpos = new Int32Array(7);
	locked = false;
	private lockPhase = 0;
	private slots: NavtexSlot[] = [];
	/** Absolute index of slots[0] and of the next slot. */
	private slotBase = 0;
	private slotNext = 0;
	/** Last 24 slots: bit set = invalid. */
	private recent = 0;
	private recentMask = 0;
	private readonly evid = [0, 0];
	parity = -1;
	private nextDx = 0;
	private figs = false;
	charsDecoded = 0;
	validChars = 0;
	badChars = 0;
	/** Bits since the last slot while unlocked. */
	private sinceChar = 0;
	/** 0 outside a message, 1 header, 2 body. */
	private mstate = 0;
	/** Last four characters, raw. */
	private tail = '';
	private hdr = '';
	private body = '';

	constructor(
		private readonly onMessage: (message: NavtexMessage) => void,
		private readonly invert = false,
	) {}

	/** The header of the message being received, null outside a message. */
	get header(): string | null {
		return this.mstate === 0 ? null : this.hdr;
	}

	reset(): void {
		this.flush();
		this.validRun.fill(0);
		this.reg.fill(0);
		this.regConf.fill(0);
		this.hpos.fill(0);
		this.hvalid.fill(0);
		this.bitCount = 0;
		this.locked = false;
		this.slots = [];
		this.slotBase = this.slotNext = 0;
		this.recent = this.recentMask = 0;
		this.evid[0] = this.evid[1] = 0;
		this.parity = -1;
		this.nextDx = 0;
		this.figs = false;
		this.sinceChar = 0;
		this.tail = '';
	}

	/** Finishes a message in progress as incomplete. */
	flush(): void {
		this.process(true);
		if (this.mstate !== 0) this.finish(false);
	}

	pushBit(soft: number): void {
		const bit = (soft > 0 ? 1 : 0) ^ (this.invert ? 1 : 0);
		this.reg.copyWithin(0, 1);
		this.regConf.copyWithin(0, 1);
		this.reg[6] = bit;
		this.regConf[6] = Math.min(1, Math.abs(soft));
		this.bitCount++;
		const ph = this.bitCount % 7;
		let code = 0;
		for (let i = 0; i < 7; i++) code |= this.reg[i] << i; // the oldest bit is the least significant
		const valid = this.bitCount >= 7 && popcount7(code) === 4;
		this.validRun[ph] = valid ? this.validRun[ph] + 1 : 0;
		let cm = 0;
		for (let i = 0; i < 7; i++) cm += this.regConf[i];
		const at = ph * HISTORY + (this.hpos[ph] & (HISTORY - 1));
		this.hconf[at] = cm / 7;
		this.hcode[at] = code;
		this.hvalid[at] = valid ? 1 : 0;
		this.hpos[ph]++;
		if (!this.locked) {
			this.searchLock(ph);
			return;
		}
		if (ph !== this.lockPhase) {
			this.checkSlip(ph);
			return;
		}
		const slot = newSlot(code, valid, this.bitCount);
		slot.bit.set(this.reg);
		slot.conf.set(this.regConf);
		this.onChar(slot);
	}

	private searchLock(ph: number): void {
		if (++this.sinceChar > 1500) {
			// 15 s without a lock ends a message
			this.sinceChar = 0;
			this.flush();
		}
		if (!this.phaseGood(ph)) return;
		this.locked = true;
		this.lockPhase = ph;
		this.slots = [];
		this.slotBase = this.slotNext = 0;
		this.recentMask = this.recent = 0;
		this.evid[0] = this.evid[1] = 0;
		this.parity = -1;
		this.nextDx = 0;
		this.sinceChar = 0;
	}

	/** The code word `back` places ago in the history of bit phase `ph`. */
	private history(ph: number, back: number): { code: number; valid: boolean; conf: number } {
		const i = ph * HISTORY + ((this.hpos[ph] - 1 - back) & (HISTORY - 1));
		return { code: this.hcode[i], valid: this.hvalid[i] === 1, conf: this.hconf[i] };
	}

	/** Text whose repetition 5 places later is the same word, over the last 20 places. */
	private matches(ph: number): number {
		let match = 0;
		for (let j = 0; j < 20; j++) {
			const a = this.history(ph, j);
			const b = this.history(ph, j + 5);
			if (a.valid && b.valid && a.code === b.code && !isControl(a.code)) match++;
		}
		return match;
	}

	/**
	 * How much a bit phase looks like the character boundary of a transmission: valid words, the idle signals (alpha,
	 * beta, repeat) and text whose repetition 5 places later is the same word. The idle pattern alone is not enough:
	 * shifted by one bit it also forms valid words.
	 */
	private phaseScore(ph: number): number {
		let ctrl = 0;
		for (let j = 0; j < 16; j++) {
			const h = this.history(ph, j);
			if (h.valid && isPhasing(h.code)) ctrl++;
		}
		return this.validRun[ph] + 4 * ctrl + 4 * this.matches(ph);
	}

	private phaseGood(ph: number): boolean {
		let ctrl = 0;
		let nvalid = 0;
		for (let j = 0; j < 16; j++) {
			const h = this.history(ph, j);
			if (h.valid) nvalid++;
			if (h.valid && isPhasing(h.code)) ctrl++;
		}
		// The phasing signals (alpha, beta, repeat) on 12 of the last 16 places lock even when noise damaged two words:
		// a run of 16 good words is rare below about 5 dB, and the lock then came after the ZCZC of the message.
		if (this.hpos[ph] >= 16 && nvalid >= 14 && ctrl >= 12) return true;
		if (this.validRun[ph] < 16) return false;
		return this.matches(ph) >= 6;
	}

	/**
	 * A bit slip: another place in the 7-bit cycle suddenly gives a long run of good words while ours does not. The
	 * numbering of the places is kept (the damaged ones stay in it as unreadable): the retransmissions after the slip
	 * then repair the characters lost in it. The parity is kept; the new evidence decides if it was lost with a place.
	 * The new phase's words since the slip replace the places they belong to: the first old place that ends at or after
	 * the end of a new word (a loss of s bits moves the boundary s bits earlier, and the count of places goes on).
	 */
	private checkSlip(ph: number): void {
		if (!(this.recent >= 6 && this.validRun[ph] >= 9 && this.phaseScore(ph) >= this.phaseScore(this.lockPhase) + 12)) return;
		const m = Math.min(this.validRun[ph], 24);
		for (let a = m - 1; a >= 0; a--) {
			const h = this.history(ph, a);
			const ns = newSlot(h.code, h.valid, this.bitCount - 7 * a);
			for (let i = 0; i < 7; i++) {
				ns.bit[i] = (ns.code >> i) & 1;
				ns.conf[i] = h.conf;
			}
			let j = -1;
			for (let i = this.slots.length - 1; i >= 0; i--) {
				if (this.slots[i].endBit >= ns.endBit) j = i;
				else break;
			}
			if (j >= 0) {
				if (ns.valid) this.slots[j] = ns;
			} else this.pushSlot(ns);
		}
		this.lockPhase = ph;
		this.recentMask = this.recent = 0;
		this.evid[0] = this.evid[1] = 0;
	}

	private pushSlot(slot: NavtexSlot): void {
		this.slots.push(slot);
		this.slotNext++;
		if (this.slots.length > MAX_SLOTS) {
			this.slots.shift();
			this.slotBase++;
		}
	}

	private slotAt(k: number): NavtexSlot {
		return this.slots[k - this.slotBase];
	}

	private onChar(s: NavtexSlot): void {
		this.pushSlot(s);
		this.recentMask = ((this.recentMask << 1) | (s.valid ? 0 : 1)) & 0xffffff;
		this.recent = 0;
		for (let x = this.recentMask; x; x &= x - 1) this.recent++;
		if (s.valid) this.validChars++;
		else this.badChars++;
		// Evidence for the DX/RX parity: the retransmission equals the character 5 places earlier.
		const k = this.slotNext - 1;
		if (k >= this.slotBase + 5 && s.valid && !isControl(s.code)) {
			const a = this.slotAt(k - 5);
			if (a.valid && a.code === s.code) this.evid[(k - 5) & 1]++;
		}
		this.updateParity();
		if (this.parity >= 0) this.process(false);
		if (this.recent >= 14) {
			// Lost the signal: wait for the next phasing signal.
			this.process(true);
			this.locked = false;
			this.sinceChar = 0;
			this.validRun.fill(0);
			this.hpos.fill(0);
			this.hvalid.fill(0);
		}
	}

	private updateParity(): void {
		const [e0, e1] = this.evid;
		if (this.parity < 0) {
			for (let p = 0; p < 2; p++) {
				const [mine, other] = p === 0 ? [e0, e1] : [e1, e0];
				if (mine >= 3 && mine >= 3 * other + 1) {
					this.parity = p;
					this.nextDx = this.slotBase + ((this.slotBase & 1) === p ? 0 : 1);
				}
			}
		} else if (this.evid[1 - this.parity] >= 4 && this.evid[this.parity] === 0) {
			this.parity = 1 - this.parity;
			this.nextDx = Math.max(this.nextDx, this.slotBase);
			if ((this.nextDx & 1) !== this.parity) this.nextDx++;
		}
	}

	/**
	 * Soft decision over both copies (time diversity): the code word with four marks that best matches the sum of the
	 * soft values of the DX and RX bits. A copy with four marks can still be wrong (two bits swapped); the other copy's
	 * soft values then overrule it. Returns -1 when neither copy says anything.
	 */
	private combine(a: NavtexSlot, b: NavtexSlot): number {
		if (a.valid && b.valid && a.code === b.code) return a.code;
		const llr = new Float64Array(7);
		let tot = 0;
		for (let i = 0; i < 7; i++) {
			llr[i] = (a.bit[i] ? 1 : -1) * a.conf[i] + (b.bit[i] ? 1 : -1) * b.conf[i];
			tot += Math.abs(llr[i]);
		}
		if (tot <= 0) return -1;
		let best = -1e9;
		let bestCode = 0;
		for (const c of VALID_CODES) {
			let m = 0;
			for (let i = 0; i < 7; i++) m += (c >> i) & 1 ? llr[i] : -llr[i];
			if (m > best) {
				best = m;
				bestCode = c;
			}
		}
		return bestCode;
	}

	private process(force: boolean): void {
		if (this.parity < 0) return;
		while (this.nextDx < this.slotNext) {
			if (!force && this.nextDx + 5 + HOLD >= this.slotNext) break; // a bit slip found later repairs the places
			if (this.nextDx < this.slotBase) {
				this.nextDx += 2;
				continue;
			}
			const a = this.slotAt(this.nextDx);
			const b = this.nextDx + 5 < this.slotNext ? this.slotAt(this.nextDx + 5) : EMPTY_SLOT;
			const code = this.combine(a, b);
			if (code < 0) this.emitChar('*');
			else if (code === LTRS) this.figs = false;
			else if (code === FIGS) this.figs = true;
			else if (!isControl(code)) {
				const ch = ccir476Char(code, this.figs);
				if (ch) this.emitChar(ch);
			}
			this.nextDx += 2;
		}
	}

	private startMessage(): void {
		this.mstate = 1;
		this.hdr = this.body = this.tail = '';
	}

	private emitChar(ch: string): void {
		this.charsDecoded++;
		this.tail = (this.tail + ch).slice(-4);
		if (this.mstate !== 0 && matchWord(this.tail, 'ZCZC')) {
			// a new message starts before the old one ended
			this.finish(false);
			this.startMessage();
			return;
		}
		if (this.mstate === 0) {
			if (matchWord(this.tail, 'ZCZC')) this.startMessage();
			return;
		}
		if (this.mstate === 1) {
			this.headerChar(ch);
			return;
		}
		if (ch === '\r') return;
		this.body += ch;
		if (matchWord(this.tail, 'NNNN')) {
			this.body = this.body.slice(0, Math.max(0, this.body.length - 4));
			this.finish(true);
			return;
		}
		if (this.body.length > 20000) this.finish(false);
	}

	private headerChar(ch: string): void {
		if (!this.hdr && (ch === ' ' || ch === '\r' || ch === '\n')) return; // "ZCZC" then a space
		if (ch === '\r' || ch === '\n') {
			if (this.hdr.length >= 4) this.mstate = 2;
			return;
		}
		this.hdr += ch;
		if (this.hdr.length === 4) this.mstate = 2;
	}

	private finish(complete: boolean): void {
		if (this.mstate === 0) return;
		const had = this.mstate === 2 || this.hdr !== '';
		this.mstate = 0;
		if (!had) {
			this.tail = '';
			return;
		}
		const text = this.body.replace(/^[\n ]+/, '').replace(/[\n ]+$/, ''); // blank lines at both ends
		const hdr = this.hdr;
		const station = hdr.length > 0 && hdr[0] !== '*' ? hdr[0] : '?';
		const subject = hdr.length > 1 && hdr[1] !== '*' ? hdr[1] : '?';
		const number = hdr.length >= 4 && /^\d\d$/.test(hdr.slice(2, 4)) ? Number(hdr.slice(2, 4)) : -1;
		const errors = [...text, ...hdr].filter((c) => c === '*').length;
		this.body = this.hdr = this.tail = '';
		this.onMessage({
			station,
			subject,
			number,
			subjectName: navtexSubjectName(subject),
			header: hdr,
			text,
			chars: text.length,
			errors,
			cer: errors / (text.length + 4),
			complete,
		});
	}
}
