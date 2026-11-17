// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/p25p2/p25p2_rx.cpp (P25p2Receiver::Impl: macPdu, controlMsg,
// grant, freqOf), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the last grant is kept instead of a call log of grants; GRP_V_CH_GRANT_UPDT and ADJ_STS_BCST only fed OnAir's
// talkgroup table and adjacent site list, which BrowSDR does not show, so they are skipped; the 64 argument bits are read
// with argField instead of a 64-bit integer.
import type { P25p2Calls } from './calls';
import {
	END_COLOR_OFF,
	END_LEN,
	MAC_ACTIVE,
	MAC_END_PTT,
	MAC_HANGTIME,
	MAC_IDLE,
	MAC_PTT,
	MAC_SIGNAL,
	MSG_GRP_V_GRANT,
	MSG_GRP_V_GRANT_EXT,
	MSG_GRP_V_USER,
	MSG_IDEN_UP,
	MSG_IDEN_UP_VU,
	MSG_NET_STS,
	MSG_NULL,
	MSG_RFSS_STS,
	MSG_UU_V_GRANT,
	MSG_UU_V_USER,
	PTT_ALG_OFF,
	PTT_GRP_OFF,
	PTT_KEY_OFF,
	PTT_LEN,
	PTT_MI_OFF,
	PTT_SRC_OFF,
	argField,
	be16,
	be24,
	macMsgLenAt,
	macOpcode,
} from './protocol';
import type { P25p2Grant, P25p2Iden, P25p2Site } from './types';

/** The MAC PDUs of the SACCH / FACCH bursts: PTT, END_PTT, IDLE, and the messages of SIGNAL, ACTIVE and HANGTIME. */
export class P25p2MacLayer {
	site?: P25p2Site;
	grant?: P25p2Grant;
	/** Colour code (NAC) of the last END_PTT, -1 none. */
	endNac = -1;
	private idens: Array<P25p2Iden | undefined> = [];

	constructor(
		private calls: P25p2Calls,
		private clock: () => number,
	) {}

	/** After a retune: the site and the channel identifiers stay. */
	reset(): void {
		this.grant = undefined;
		this.endNac = -1;
	}

	pdu(ci: number, m: Uint8Array, len: number): void {
		const calls = this.calls;
		switch (macOpcode(m[0])) {
			case MAC_PTT:
				// MI 9 bytes at 1..9, algorithm 10, key ID 11..12 (OP25 p25p2_tdma.cc handle_mac_ptt)
				if (len >= PTT_LEN)
					calls.ptt(
						ci,
						be24(m, PTT_SRC_OFF),
						be16(m, PTT_GRP_OFF),
						m[PTT_ALG_OFF],
						be16(m, PTT_KEY_OFF),
						m.subarray(PTT_MI_OFF, PTT_ALG_OFF),
					);
				break;
			case MAC_END_PTT:
				if (len >= END_LEN) {
					this.endNac = be16(m, END_COLOR_OFF) & 0xfff;
					calls.endCall(ci, true);
				}
				break;
			case MAC_IDLE:
				calls.endCall(ci, true);
				break;
			case MAC_SIGNAL:
			case MAC_ACTIVE:
			case MAC_HANGTIME:
				this.messages(ci, m, len);
				break;
		}
	}

	private messages(ci: number, m: Uint8Array, len: number): void {
		let pos = 1;
		while (pos < len) {
			const op = m[pos];
			// the length rules of OP25 (null, avoid-zero-bias, variable lists, manufacturer)
			const ml = macMsgLenAt(m, pos, len - pos);
			if (op === MSG_NULL || ml === 0 || pos + ml > len) break;
			if (op === MSG_GRP_V_USER) this.calls.userMsg(ci, m[pos + 1], be16(m, pos + 2), be24(m, pos + 4), true);
			else if (op === MSG_UU_V_USER) this.calls.userMsg(ci, m[pos + 1], be24(m, pos + 2), be24(m, pos + 5), false);
			else if (op === MSG_GRP_V_GRANT_EXT && ml >= 11)
				// service options, channel (T), channel (R), group, source: follow the downlink, channel (T)
				this.onGrant(be16(m, pos + 6), be24(m, pos + 8), be16(m, pos + 2), true, m[pos + 1]);
			else if (op !== 0x08 && op !== 0x11 && op !== 0x12) this.control(op, m, pos + 1); // 0x08, 0x11, 0x12: padding / paging
			pos += ml;
		}
	}

	private freqOf(ch: number): number {
		const i = this.idens[(ch >> 12) & 15];
		return i ? i.baseHz + (ch & 0xfff) * i.spacingHz : 0;
	}

	private onGrant(tg: number, src: number, ch: number, group: boolean, opts: number): void {
		this.grant = {
			dst: tg,
			src,
			group,
			channel: ch,
			freqHz: this.freqOf(ch),
			emergency: (opts & 0x80) !== 0,
			encrypted: (opts & 0x40) !== 0,
			at: this.clock(),
		};
	}

	/** The TSBK-equivalent MAC messages: the 64 bits after the opcode (at m[at]) have the layout of the Phase 1 TSBK arguments. */
	private control(op: number, m: Uint8Array, at: number): void {
		const a = (shift: number, width: number) => argField(m, at, shift, width);
		switch (op) {
			case MSG_GRP_V_GRANT:
				this.onGrant(a(24, 16), a(0, 24), a(40, 16), true, a(56, 8));
				break;
			case MSG_UU_V_GRANT:
				this.onGrant(a(24, 24), a(0, 24), a(48, 16), false, 0);
				break;
			case MSG_IDEN_UP:
			case MSG_IDEN_UP_VU:
				this.iden(op === MSG_IDEN_UP_VU, a);
				break;
			case MSG_NET_STS: {
				const ch = a(8, 16);
				this.site = { ...this.siteOrNew(), wacn: a(36, 20), sysId: a(24, 12), channel: ch, freqHz: this.freqOf(ch) };
				break;
			}
			case MSG_RFSS_STS: {
				const ch = a(8, 16);
				this.site = { ...this.siteOrNew(), sysId: a(40, 12), rfss: a(32, 8), site: a(24, 8), channel: ch, freqHz: this.freqOf(ch) };
				break;
			}
		}
	}

	private siteOrNew(): P25p2Site {
		return this.site ?? { wacn: 0, sysId: 0, rfss: 0, site: 0, channel: 0, freqHz: 0 };
	}

	private iden(vu: boolean, a: (shift: number, width: number) => number): void {
		const spacingHz = a(32, 10) * 125;
		const r: P25p2Iden = { baseHz: a(0, 32) * 5, spacingHz, bwHz: 0, txOffsetHz: 0, vu };
		if (vu) {
			const bw = a(56, 4);
			const toff = a(42, 14);
			r.bwHz = bw === 4 ? 6250 : bw === 5 ? 12500 : 0;
			r.txOffsetHz = ((toff >> 13) & 1 ? 1 : -1) * (toff & 0x1fff) * spacingHz;
		} else {
			const toff = a(42, 9);
			r.bwHz = a(51, 9) * 125;
			r.txOffsetHz = ((toff >> 8) & 1 ? 1 : -1) * (toff & 0xff) * 250000;
		}
		this.idens[a(60, 4)] = r;
	}
}
