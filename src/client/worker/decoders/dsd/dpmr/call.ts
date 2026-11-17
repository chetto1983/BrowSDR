// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/dpmr/dpmr_rx.cpp (DpmrReceiver::Impl::fresh, startCall, endCall,
// endData, lost, the header and CCH call bookkeeping) and core/include/dect2/dpmr/dpmr_tel.h (DpmrCall),
// https://github.com/adswill/OnAir; see third_party/onair.
// Changes: one transmission is kept for BrowSDR's DSD status panel instead of OnAir's call log, event list and audio
// device; the PMR446 channel scan is left out (BrowSDR's VFO is tuned by the user).
import type { DpmrStatus } from '@/worker/decoders/dsd/types';
import { CALL_GROUP, HDR_COMM, HDR_STATUS, MODE_DATA1, MODE_PACKET, callTypeName, commModeName } from './proto';
import type { DpmrCallState, DpmrCch, DpmrHeader } from './types';

const KINDS: Array<DpmrStatus['kind']> = ['voice', 'status', 'message', 'packet'];

function fresh(kind: number, cc: number): DpmrCallState {
	return {
		kind,
		active: false,
		src: -1,
		dst: -1,
		callType: CALL_GROUP,
		commMode: 0,
		cc,
		emergency: false,
		lateEntry: false,
		endSeen: false,
		text: '',
	};
}

/** The calls and data transmissions of one channel. */
export class DpmrCalls {
	/** The last colour code received. */
	cc = -1;
	/** A voice call on air. */
	now: DpmrCallState | null = null;
	/** A short message or packet data transmission being received. */
	sd: DpmrCallState | null = null;
	/** The transmission shown: the latest one. */
	private shown: DpmrCallState | null = null;
	private idHalves = [-1, -1, -1, -1];
	blocks = 0;

	reset(): void {
		this.cc = -1;
		this.now = null;
		this.sd = null;
		this.shown = null;
		this.blocks = 0;
	}

	/** A header that checked: a status message, the start of a data transmission or a call. Returns true for a new call. */
	header(h: DpmrHeader): boolean {
		const set = (s: DpmrCallState) => {
			Object.assign(s, { src: h.own, dst: h.called, callType: h.callType, commMode: h.commMode, emergency: h.emergency });
			return s;
		};
		if (h.type === HDR_STATUS) {
			this.shown = set({ ...fresh(1, this.cc), endSeen: true, text: `status ${h.extra}` });
			return false;
		}
		if (h.type !== HDR_COMM) return false;
		if (h.commMode >= MODE_DATA1 && h.commMode <= MODE_PACKET) {
			this.endData();
			this.sd = set({ ...fresh(h.commMode === MODE_PACKET ? 3 : 2, this.cc), active: true });
			this.shown = this.sd;
			return false;
		}
		if (this.now?.active && this.now.src === h.own && this.now.dst === h.called) return false;
		this.startCall(false);
		set(this.now!);
		return true;
	}

	startCall(late: boolean, cch?: DpmrCch): void {
		if (this.now?.active) this.endCall(false);
		this.now = { ...fresh(0, this.cc), active: true, lateEntry: late };
		if (cch) Object.assign(this.now, { callType: cch.callType, commMode: cch.commMode, emergency: cch.emergency });
		this.idHalves.fill(-1);
		this.shown = this.now;
	}

	/** The id halves of the superframe's control channel (a call joined late finds its ids here). */
	ids(c: DpmrCch): void {
		const now = this.now;
		if (!now?.active) return;
		this.idHalves[c.frame & 3] = c.idPart;
		if (this.idHalves[0] >= 0 && this.idHalves[1] >= 0) now.dst = this.idHalves[0] * 4096 + this.idHalves[1];
		if (this.idHalves[2] >= 0 && this.idHalves[3] >= 0) now.src = this.idHalves[2] * 4096 + this.idHalves[3];
		if (now.cc < 0) now.cc = this.cc;
	}

	/** A data block of a short message or packet data transmission. */
	data(block: number, text: string): void {
		const sd = this.sd;
		if (!sd || block * 21 < sd.text.length) return;
		sd.text = sd.text.padEnd(block * 21, '?') + text;
	}

	endCall(seen: boolean, own = -1): void {
		const now = this.now;
		if (!now?.active) return;
		if (now.src < 0 && own >= 0) now.src = own;
		now.active = false;
		now.endSeen = seen;
	}

	endData(): void {
		if (!this.sd) return;
		this.sd.active = false;
		this.sd.endSeen = true;
		this.sd = null;
	}

	lost(): void {
		this.endCall(false);
		this.endData();
	}

	status(inverted: boolean, snrDb: number): DpmrStatus | undefined {
		const s = this.shown;
		if (!s) return undefined;
		return {
			kind: KINDS[s.kind],
			colourCode: s.cc >= 0 ? s.cc : this.cc,
			src: s.src,
			dst: s.dst,
			callType: callTypeName(s.callType),
			commMode: commModeName(s.commMode),
			emergency: s.emergency,
			lateEntry: s.lateEntry,
			ended: !s.active,
			lost: !s.active && !s.endSeen,
			text: s.text,
			blocks: this.blocks,
			inverted,
			snrDb,
		};
	}
}
