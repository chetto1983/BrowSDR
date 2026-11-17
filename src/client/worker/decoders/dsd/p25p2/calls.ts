// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/p25p2/p25p2_rx.cpp (P25p2Receiver::Impl: startCall, endCall,
// userMsg, the MAC_PTT case of macPdu, voiceFrame, keyed, essKnown, essB, essA, play and the call expiry of report),
// https://github.com/adswill/OnAir; see third_party/onair.
// Changes: one codec (BrowSDR's mbelib) serves both slots, so it starts afresh when the played slot changes and on a FACCH
// of the slot it holds; the frames to play are collected for the DSD decoder instead of being decoded here; OnAir's voice
// monitor, call log, talkgroup table, event texts and grant hints of the trunking follower are left out (the slot played
// is OnAir's choice without a monitor: the first slot heard, or the one setListenSlot names).
//
// Encryption comes from the ESS (and the PTT where a MAC PDU decodes): an encrypted call is reported, its voice never
// decoded; voice that arrives before the first ESS of a call is held until it says clear.
import { ALG_CLEAR, ESS_A1_POS, ESS_A2_POS, ESS_B_POS, ambeFlatten, essDecode, hexbitsGet } from './protocol';
import type { P25p2Counters, P25p2Ess, P25p2Slot } from './types';

/** Three superframes of voice on one slot (18 frames each): an ESS comes every superframe. */
const ESS_WAIT_FRAMES = 54;
const HELD_MAX = 2 * 18;
/** A call with no burst for this long has ended (the signal was lost). */
const CALL_TIMEOUT_SEC = 2;

export function newSlot(): P25p2Slot {
	return {
		active: false,
		src: -1,
		dst: -1,
		group: true,
		emergency: false,
		encrypted: false,
		cryptoKnown: false,
		algId: ALG_CLEAR,
		keyId: 0,
		mi: '',
		essMissing: false,
		lateEntry: false,
		endSeen: false,
		voiceFrames: 0,
		clearFrames: 0,
		voice: false,
		startSec: 0,
		durSec: 0,
	};
}

function newEss(): P25p2Ess {
	return { b: new Uint8Array(16), a: new Uint8Array(28), nb: 0 };
}

const hex = (bytes: ArrayLike<number>) => Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');

/** The calls on the two logical channels of a P25 Phase 2 voice channel. */
export class P25p2Calls {
	now = [newSlot(), newSlot()];
	/** The slot played (1 or 2), 0 none; the choice: 0 the first slot heard, 1 or 2 only that one. */
	audioSlot = 0;
	listen = 0;
	/** AMBE+2 frames for the codec, handed on at the end of each burst. */
	out: Uint8Array[] = [];
	/** Tests: every voice frame as received (slot 1 or 2, the 72 bits in code word order, whether the call is known to be clear). */
	tap?: (slot: number, bits: Uint8Array, clear: boolean) => void;
	private lastAct = [-10, -10];
	private unkSince = [-1, -1];
	/** Voice of a call whose encryption is not known yet (joined late, no ESS yet): played once the ESS says clear. */
	private held: Uint8Array[][] = [[], []];
	private ess = [newEss(), newEss()];
	/** The slot whose call the codec has state from (0 none). */
	private codecSlot = 0;

	constructor(
		private counters: P25p2Counters,
		private clock: () => number,
		private codecReset: () => void,
	) {}

	reset(): void {
		this.now = [newSlot(), newSlot()];
		this.audioSlot = 0;
		this.out.length = 0;
		this.lastAct = [-10, -10];
		this.unkSince = [-1, -1];
		this.held = [[], []];
		this.ess = [newEss(), newEss()];
		this.codecSlot = 0;
	}

	/** The descrambler changed: what was held or collected was read with the old one. */
	forgetHeld(): void {
		for (let ci = 0; ci < 2; ci++) {
			this.held[ci] = [];
			this.ess[ci].nb = 0;
			this.unkSince[ci] = -1;
			this.now[ci].essMissing = false;
		}
	}

	startCall(ci: number, src: number, dst: number, group: boolean, cryptoKnown: boolean, alg: number, svc: number, late: boolean): void {
		const c = this.now[ci];
		if (c.active) {
			if ((src < 0 || c.src === src) && (dst < 0 || c.dst === dst)) return; // the same call
			if (late) return;
			this.endCall(ci, true);
		}
		const n = newSlot();
		this.unkSince[ci] = -1;
		n.active = true;
		n.startSec = this.clock();
		n.src = src;
		n.dst = dst;
		n.group = group;
		n.lateEntry = late;
		n.cryptoKnown = cryptoKnown;
		n.algId = alg;
		n.encrypted = cryptoKnown && alg !== ALG_CLEAR && alg !== 0;
		if (svc >= 0) {
			n.emergency = (svc & 0x80) !== 0;
			if (svc & 0x40) n.encrypted = n.cryptoKnown = true;
		}
		this.now[ci] = n;
		this.lastAct[ci] = this.clock();
	}

	endCall(ci: number, seen: boolean): void {
		const c = this.now[ci];
		if (!c.active) return;
		c.active = false;
		c.endSeen = seen;
		c.durSec = this.clock() - c.startSec;
		if (this.audioSlot === ci + 1) this.audioSlot = 0;
		this.held[ci] = [];
		this.ess[ci].nb = 0;
	}

	/**
	 * What a voice channel user message tells about the call on the slot (starting it when it is not known yet). Its
	 * service options can say encrypted, never clear: the NSW PSN sends AES calls without the bit (the PTT or the ESS decides).
	 */
	userMsg(ci: number, svc: number, dst: number, src: number, group: boolean): void {
		this.lastAct[ci] = this.clock();
		const c = this.now[ci];
		if (!c.active) {
			this.startCall(ci, src, dst, group, false, ALG_CLEAR, svc, true);
			return;
		}
		if (c.src < 0) c.src = src;
		if (c.dst < 0) {
			c.dst = dst;
			c.group = group;
		} else if (!group && c.group) {
			// the PTT carries a group address; a unit to unit user message corrects it
			c.dst = dst;
			c.group = false;
		}
		c.emergency = c.emergency || (svc & 0x80) !== 0;
		if (svc & 0x40) c.encrypted = c.cryptoKnown = true;
	}

	/** MAC_PTT: the call's source, group, algorithm, key ID and message indicator. */
	ptt(ci: number, src: number, grp: number, alg: number, key: number, mi: ArrayLike<number>): void {
		const c = this.now[ci];
		if (c.active && !c.lateEntry && c.src === src && c.dst === grp) {
			this.lastAct[ci] = this.clock();
		} else if (c.active && c.lateEntry) {
			c.src = src;
			c.dst = grp;
			c.group = true;
			c.lateEntry = false;
			c.algId = alg;
			c.cryptoKnown = true;
			c.encrypted = alg !== ALG_CLEAR && alg !== 0;
			this.lastAct[ci] = this.clock();
		} else this.startCall(ci, src, grp, true, true, alg, -1, false);
		this.keyed(ci, alg, key, mi);
	}

	/**
	 * The PTT or the ESS names the algorithm, key ID and message indicator of the call. An encrypted call's voice is never
	 * decoded; nothing here decrypts.
	 */
	private keyed(ci: number, alg: number, key: number, mi: ArrayLike<number>): void {
		const c = this.now[ci];
		if (!c.active) return;
		c.algId = alg ? alg : ALG_CLEAR;
		c.keyId = key;
		c.mi = hex(mi);
		c.cryptoKnown = true;
		c.essMissing = false;
		this.unkSince[ci] = -1;
		c.encrypted = c.algId !== ALG_CLEAR;
		const held = this.held[ci];
		this.held[ci] = [];
		if (c.encrypted) this.counters.encryptedSkipped += held.length;
		else for (const f of held) this.play(ci, f);
	}

	/** The ESS of a slot has decoded: the call's encryption is known now. */
	private essKnown(ci: number, alg: number, key: number, mi: Uint8Array): void {
		this.lastAct[ci] = this.clock();
		if (!this.now[ci].active) this.startCall(ci, -1, -1, true, true, alg, -1, true);
		this.keyed(ci, alg, key, mi);
	}

	/** A quarter of the ESS-B, from a 4V burst (descrambled dibits). */
	essB(ci: number, d: Uint8Array): void {
		const e = this.ess[ci];
		if (e.nb >= 4) e.nb = 0;
		hexbitsGet(d, ESS_B_POS, 4, e.b, 4 * e.nb);
		e.nb++;
	}

	/** The ESS-A of a 2V burst completes the encryption sync of the four 4V bursts before. */
	essA(ci: number, d: Uint8Array): void {
		const e = this.ess[ci];
		const c = this.now[ci];
		hexbitsGet(d, ESS_A1_POS, 16, e.a, 0);
		hexbitsGet(d, ESS_A2_POS, 12, e.a, 16);
		const full = e.nb === 4;
		e.nb = 0;
		// a lost 4V burst or an ESS that does not correct is not "unknown": the algorithm and key of a call do not change
		// inside it (OP25 reuses the previous ESS values on an FEC failure), so a call that already has them keeps them
		const reused = c.active && c.cryptoKnown;
		if (!full) {
			if (reused) this.counters.essReused++;
			return;
		}
		const r = essDecode(e.b, e.a);
		if (!r) {
			this.counters.essBad++;
			if (reused) this.counters.essReused++;
			return;
		}
		this.counters.essOk++;
		this.essKnown(ci, r.algId, r.keyId, r.mi);
	}

	voiceFrame(ci: number, fr: Uint8Array): void {
		this.lastAct[ci] = this.clock();
		if (!this.now[ci].active) this.startCall(ci, -1, -1, true, false, ALG_CLEAR, -1, true);
		const c = this.now[ci];
		c.voiceFrames++;
		this.counters.voiceFrames++;
		this.tap?.(ci + 1, ambeFlatten(fr), c.cryptoKnown && !c.encrypted);
		if (c.encrypted) {
			this.counters.encryptedSkipped++; // reported, never decoded
			return;
		}
		if (c.cryptoKnown) {
			this.play(ci, fr);
			return;
		}
		// the newest frames are kept (a late ESS must not release stale audio); after ESS_WAIT_FRAMES frames with no ESS the
		// call is labelled "encryption unknown" and its voice is skipped, never played
		if (this.unkSince[ci] < 0) this.unkSince[ci] = c.voiceFrames;
		const held = this.held[ci];
		if (held.length >= HELD_MAX) held.shift();
		held.push(fr);
		if (!c.essMissing && c.voiceFrames - this.unkSince[ci] >= ESS_WAIT_FRAMES) c.essMissing = true;
		if (c.essMissing) this.counters.unknownSkipped++;
	}

	private play(ci: number, fr: Uint8Array): void {
		const c = this.now[ci];
		c.clearFrames++;
		const l = this.listen;
		if (l && l !== ci + 1) return; // the chosen slot only
		if (!l) {
			// the first slot heard plays
			if (this.audioSlot === 0 || !this.now[this.audioSlot - 1].active) this.audioSlot = ci + 1;
			if (this.audioSlot !== ci + 1) return;
		}
		this.audioSlot = ci + 1;
		if (this.codecSlot !== ci + 1) {
			if (this.codecSlot) this.codecReset();
			this.codecSlot = ci + 1;
		}
		this.out.push(fr);
		this.counters.voiceDecoded++;
		c.voice = true;
	}

	/** A FACCH is a call boundary: the codec starts afresh when it holds this slot's call. */
	facch(ci: number): void {
		if (this.codecSlot !== ci + 1) return;
		this.codecSlot = 0;
		this.codecReset();
	}

	/** Calls with no burst for two seconds have ended (the signal was lost). */
	expire(): void {
		const t = this.clock();
		for (let ci = 0; ci < 2; ci++) {
			const c = this.now[ci];
			if (c.active && t - this.lastAct[ci] > CALL_TIMEOUT_SEC) this.endCall(ci, false);
			if (c.active) c.durSec = t - c.startSec;
		}
	}
}
