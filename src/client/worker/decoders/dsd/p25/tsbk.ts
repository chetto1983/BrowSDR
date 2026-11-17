// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/p25/p25_rx.cpp (P25Receiver::Impl: onTsbk from the voice grants
// on, grant, freqOf), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the grants, channel identifiers, site and adjacent sites are kept for BrowSDR's DSD panel (the last grant and
// at most 8 adjacent sites) instead of OnAir's call log, talkgroup table and the TSBK record of its trunking follower;
// signal time is the 4800 symbols/s chain's dibit position.
import {
	OP_ADJ_STS,
	OP_GRP_V_GRANT,
	OP_IDEN_UP,
	OP_IDEN_UP_TDMA,
	OP_IDEN_UP_VU,
	OP_NET_STS,
	OP_RFSS_STS,
	OP_UU_V_GRANT,
	channelText,
	opcodeName,
} from './proto';
import type { P25ControlState, P25Grant, P25Iden, P25Site, P25Tsbk } from './types';

/** Bits low .. low + width - 1 of the arguments. */
const f = (a: bigint, low: number, width: number): number => Number((a >> BigInt(low)) & ((1n << BigInt(width)) - 1n));
const hex = (v: number, n: number): string => v.toString(16).toUpperCase().padStart(n, '0');
const mhz = (hz: number): string => (hz / 1e6).toFixed(5);

/** A channel number's frequency through its identifier update (0 when that has not been heard). */
export function freqOf(idens: Array<P25Iden | null>, ch: number): number {
	const i = idens[(ch >> 12) & 15];
	if (!i) return 0;
	let n = ch & 0xfff;
	if (i.tdma) {
		if (i.slots <= 0) return 0;
		n = Math.floor(n / i.slots); // a TDMA identifier: the channel number counts slots
	}
	return i.baseHz + n * i.spacingHz;
}

function grant(s: P25ControlState, g: Omit<P25Grant, 'freqHz'>, at: number, event: (t: string) => void): void {
	const key = `${g.dst}/${g.src}/${g.channel}/${g.group}`;
	s.grants = s.grants.filter((x) => at - x.at < 4 * 4800);
	const seen = s.grants.find((x) => x.key === key);
	if (seen) {
		seen.at = at;
		// the identifier update may come after the first grant
		if (s.grant && !s.grant.freqHz && `${s.grant.dst}/${s.grant.src}/${s.grant.channel}/${s.grant.group}` === key)
			s.grant = { ...s.grant, freqHz: freqOf(s.idens, g.channel) };
		return;
	}
	s.grants.push({ key, at });
	s.grant = { ...g, freqHz: freqOf(s.idens, g.channel) };
	const freq = s.grant.freqHz > 0 ? ` (${mhz(s.grant.freqHz)} MHz)` : '';
	const flags = `${g.emergency ? ', EMERGENCY' : ''}${g.encrypted ? ', encrypted' : ''}`;
	event(
		`${g.group ? 'GRP_V_CH_GRANT' : 'UU_V_CH_GRANT'} ${g.src} → ${g.group ? 'TG ' : ''}${g.dst} on channel ${channelText(g.channel)}${freq}${flags}`,
	);
}

function iden(s: P25ControlState, t: P25Tsbk, event: (t: string) => void): void {
	const a = t.args;
	const id = f(a, 60, 4);
	const r: P25Iden = {
		vu: t.opcode === OP_IDEN_UP_VU,
		tdma: false,
		slots: 1,
		baseHz: f(a, 0, 32) * 5,
		spacingHz: f(a, 32, 10) * 125,
		txOffsetHz: 0,
		bwHz: 0,
	};
	if (t.opcode === OP_IDEN_UP_TDMA) {
		// laid out like the VU one, the channel type where it has the bandwidth: type 3 is 12.5 kHz with 2 slots
		const type = f(a, 56, 4);
		const toff = f(a, 42, 14);
		Object.assign(r, {
			tdma: type >= 3,
			slots: type === 3 ? 2 : type >= 3 ? 0 : 1,
			bwHz: 12500,
			txOffsetHz: ((toff >> 13) & 1 ? 1 : -1) * (toff & 0x1fff) * r.spacingHz,
		});
	} else if (r.vu) {
		const bw = f(a, 56, 4);
		const toff = f(a, 42, 14);
		Object.assign(r, {
			bwHz: bw === 4 ? 6250 : bw === 5 ? 12500 : 0,
			txOffsetHz: ((toff >> 13) & 1 ? 1 : -1) * (toff & 0x1fff) * r.spacingHz,
		});
	} else {
		const toff = f(a, 42, 9);
		Object.assign(r, { bwHz: f(a, 51, 9) * 125, txOffsetHz: ((toff >> 8) & 1 ? 1 : -1) * (toff & 0xff) * 250000 });
	}
	const o = s.idens[id];
	s.idens[id] = r;
	if (o && o.baseHz === r.baseHz && o.spacingHz === r.spacingHz) return;
	const offset = `${r.txOffsetHz >= 0 ? '+' : '-'}${Math.abs(r.txOffsetHz / 1e6).toFixed(3)}`;
	event(
		`${opcodeName(t.opcode)} ${id}: base ${mhz(r.baseHz)} MHz, spacing ${(r.spacingHz / 1e3).toFixed(2)} kHz, transmit offset ${offset} MHz`,
	);
}

function siteOf(s: P25ControlState, a: bigint, nac: number, rfss: boolean): P25Site {
	const ch = f(a, 8, 16);
	const old = s.site;
	const base = {
		wacn: old?.wacn ?? -1,
		sysId: old?.sysId ?? -1,
		rfss: old?.rfss ?? -1,
		site: old?.site ?? -1,
		nac,
		channel: ch,
		freqHz: freqOf(s.idens, ch),
	};
	return rfss
		? { ...base, sysId: f(a, 40, 12), rfss: f(a, 32, 8), site: f(a, 24, 8) }
		: { ...base, wacn: f(a, 36, 20), sysId: f(a, 24, 12) };
}

function status(s: P25ControlState, t: P25Tsbk, nac: number, event: (t: string) => void): void {
	const a = t.args;
	if (t.opcode === OP_NET_STS) {
		const site = siteOf(s, a, nac, false);
		const news = s.site?.wacn !== site.wacn || s.site?.sysId !== site.sysId;
		s.site = site;
		if (news)
			event(
				`NET_STS_BCST WACN ${hex(site.wacn, 5)} system ${hex(site.sysId, 3)}, NAC ${hex(nac, 3)}, control channel ${channelText(site.channel)}`,
			);
	} else if (t.opcode === OP_RFSS_STS) {
		const site = siteOf(s, a, nac, true);
		const news = s.site?.rfss !== site.rfss || s.site?.site !== site.site;
		s.site = site;
		if (news) event(`RFSS_STS_BCST system ${hex(site.sysId, 3)}, RFSS ${site.rfss}, site ${site.site}`);
	} else {
		const adj: P25Site = {
			wacn: s.site?.wacn ?? -1,
			sysId: f(a, 40, 12),
			rfss: f(a, 32, 8),
			site: f(a, 24, 8),
			nac: -1,
			channel: f(a, 8, 16),
			freqHz: 0,
		};
		adj.freqHz = freqOf(s.idens, adj.channel);
		const k = s.adjacent.findIndex((o) => o.sysId === adj.sysId && o.rfss === adj.rfss && o.site === adj.site);
		if (k >= 0) s.adjacent[k] = adj;
		else {
			s.adjacent = [...s.adjacent, adj].slice(-8);
			event(`ADJ_STS_BCST system ${hex(adj.sysId, 3)}, RFSS ${adj.rfss}, site ${adj.site} on channel ${channelText(adj.channel)}`);
		}
	}
}

/** A standard TSBK: voice grants, channel identifiers, the network, RFSS and adjacent site status. */
export function onTsbk(t: P25Tsbk, s: P25ControlState, nac: number, at: number, event: (t: string) => void): void {
	const a = t.args;
	const op = t.opcode;
	if (op === OP_GRP_V_GRANT) {
		const opts = f(a, 56, 8);
		grant(
			s,
			{ dst: f(a, 24, 16), src: f(a, 0, 24), channel: f(a, 40, 16), group: true, emergency: !!(opts & 0x80), encrypted: !!(opts & 0x40) },
			at,
			event,
		);
	} else if (op === OP_UU_V_GRANT)
		grant(s, { dst: f(a, 24, 24), src: f(a, 0, 24), channel: f(a, 48, 16), group: false, emergency: false, encrypted: false }, at, event);
	else if (op === OP_IDEN_UP || op === OP_IDEN_UP_VU || op === OP_IDEN_UP_TDMA) iden(s, t, event);
	else if (op === OP_NET_STS || op === OP_RFSS_STS || op === OP_ADJ_STS) status(s, t, nac, event);
}
