// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/flarm/flarm_rx.cpp (FlarmReceiver::Impl: tryJob with the Chase
// search, onFrame with its key times, two-packet agreement and privacy rules, apply, hashId, expire),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: an accepted packet becomes an aircraft record (OnAir
// updates its aircraft table and publishes telemetry); a packet goes through the input block's queue (report.ts
// FrameQueue), so the copy a strong signal leaves in the other channel counts once; the time of a packet is the time of
// its last chip (OnAir: the start of the input block); the salted hashes are 53 bits from two 32-bit mixes; no track
// history.

import type { FlarmChannel } from './channel';
import { FLARM_RATE } from './front';
import {
	ADDR_ANONYMOUS,
	addrTypeName,
	aircraftTypeName,
	checkCrc,
	decodeV6,
	FRAME_BYTES,
	packetAddr,
	packetType,
	unpackPosition,
	unpackVelocity,
} from './flarm-proto';
import { greatCircle } from './report';
import type { AircraftReport, FlarmKnown, FlarmPending, FlarmV6, ProtocolHost, SyncCand } from './types';

const DATA_BITS = FRAME_BYTES * 8;
/** Bits of the Chase search. */
const CHASE_BITS = 6;
/** A position farther away is an alias of the 19 / 20 bit position, not an aircraft. */
const MAX_RANGE_KM = 600;
const PENDING_SEC = 60;
const EXPIRY_SEC = 60;

const hex6 = (v: number): string => (v & 0xffffff).toString(16).toUpperCase().padStart(6, '0');
const isFlagged = (q: FlarmV6): boolean => q.noTrack || q.stealth || q.addrType === ADDR_ANONYMOUS;
/** Distance of two position fields modulo their width. */
function dmod(a: number, b: number, m: number): number {
	const d = (a - b) & m;
	return Math.min(d, m + 1 - d);
}
const nearBy = (q: FlarmV6, acType: number, flagged: boolean, lat19: number, lon20: number): boolean =>
	isFlagged(q) === flagged && q.aircraftType === acType && dmod(lat19, q.lat19, 0x7ffff) < 4000 && dmod(lon20, q.lon20, 0xfffff) < 4000;

function fmix32(h: number): number {
	h ^= h >>> 16;
	h = Math.imul(h, 0x85ebca6b);
	h ^= h >>> 13;
	h = Math.imul(h, 0xc2b2ae35);
	return (h ^ (h >>> 16)) >>> 0;
}

function randomSalt(): number {
	const a = new Uint32Array(1);
	if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(a);
	else a[0] = Math.floor(Math.random() * 2 ** 32);
	return a[0];
}

/** The six weakest bits (smallest chip difference), weakest first. */
function weakestBits(margin: Float32Array): { bits: number[]; costs: number[] } {
	const bits = new Array<number>(CHASE_BITS).fill(-1);
	const costs = new Array<number>(CHASE_BITS).fill(1e30);
	for (let i = 0; i < DATA_BITS; i++) {
		const r = margin[i];
		if (r >= costs[CHASE_BITS - 1]) continue;
		let j = CHASE_BITS - 1;
		while (j > 0 && costs[j - 1] > r) {
			costs[j] = costs[j - 1];
			bits[j] = bits[j - 1];
			j--;
		}
		costs[j] = r;
		bits[j] = i;
	}
	return { bits, costs };
}

/** The frame as received or inverted, with the bits of mask m flipped. */
function candidate(raw: Uint8Array, inverted: boolean, bits: number[], m: number): Uint8Array {
	const f = inverted ? raw.map((v) => ~v & 255) : raw.slice();
	for (let j = 0; j < CHASE_BITS; j++) if ((m >> j) & 1 && bits[j] >= 0) f[bits[j] >> 3] ^= 0x80 >> (bits[j] & 7);
	return f;
}

/**
 * Chase decoding: the 63 ways of flipping the six weakest bits in the order of their summed margins, the first the CRC
 * accepts is taken. The V6 parity and the two-packet agreement still stand behind it.
 */
function chase(raw: Uint8Array, margin: Float32Array): Uint8Array | null {
	const { bits, costs } = weakestBits(margin);
	const masks = Array.from({ length: (1 << CHASE_BITS) - 1 }, (_, i) => i + 1);
	const cost = (m: number) => costs.reduce((sum, c, j) => ((m >> j) & 1 ? sum + c : sum), 0);
	masks.sort((x, y) => cost(x) - cost(y));
	for (const m of masks)
		for (const inverted of [false, true]) {
			const f = candidate(raw, inverted, bits, m);
			if (checkCrc(f)) return f;
		}
	return null;
}

/** FLARM's old protocol (V6): CRC and Chase repair, the key times, the agreement of two packets, privacy flags. */
export class FlarmProtocol {
	private readonly known = new Map<number, FlarmKnown>();
	private readonly pending = new Map<number, FlarmPending[]>();
	private readonly privSet = new Set<number>();
	private readonly newSet = new Set<number>();
	private readonly salt = [randomSalt(), randomSalt()];

	constructor(private readonly host: ProtocolHost) {}

	/** Salted hash of an address: nothing about a flagged aircraft is kept but this. */
	private hashId(id: number): number {
		return fmix32((id ^ this.salt[0]) >>> 0) * 2 ** 21 + (fmix32((id ^ this.salt[1]) >>> 0) & 0x1fffff);
	}

	expire(tnow: number): void {
		for (const [id, k] of this.known) if (tnow - k.lastSeen > EXPIRY_SEC) this.known.delete(id);
	}

	/** A sync whose 26 bytes are all in. */
	job(ch: FlarmChannel, cd: SyncCand): void {
		const raw = new Uint8Array(FRAME_BYTES);
		const margin = new Float32Array(DATA_BITS);
		for (let i = 0; i < FRAME_BYTES; i++) raw[i] = ch.byteAt(cd, i, margin, 8 * i);
		let f: Uint8Array | null = checkCrc(raw) ? raw : null;
		if (!f) {
			const inv = raw.map((v) => ~v & 255);
			if (checkCrc(inv)) f = inv;
		}
		if (!f && this.host.options.chase) f = chase(raw, margin);
		const level = ch.level(cd.k0 - 31, cd.k0 + DATA_BITS * 2);
		if (!f) {
			if (cd.err <= 1) this.host.stats.flarm.bad++;
			return;
		}
		const frame = f;
		const t = ch.n / FLARM_RATE;
		this.host.queue({ key: `flarm:${String.fromCharCode(...frame)}`, t, level, apply: () => this.onFrame(ch.index, frame, level, t) });
	}

	private onFrame(channel: number, f: Uint8Array, level: number, tnow: number): void {
		const s = this.host.stats.flarm;
		s.perChannel[channel]++;
		const type = packetType(f);
		const id = packetAddr(f);
		if (type === 2) {
			s.newProtocol++;
			this.newSet.add(this.hashId(id));
			s.newProtocolDevices = this.newSet.size;
			return;
		}
		if (type !== 0) {
			s.otherType++;
			return;
		}
		const decoded = this.keyCandidates(this.host.unixNow(tnow));
		const all = decoded.map((ts) => decodeV6(f, ts).packet).filter((q): q is FlarmV6 => !!q);
		if (!all.length) {
			s.bad++;
			return;
		}
		this.agree(all, id, tnow, channel, level);
	}

	/** The key needs the time (64 s steps): the clock's, and the neighbouring step near a boundary. */
	private keyCandidates(un: number): number[] {
		const ts0 = Math.floor(un) >>> 0;
		const frac = ts0 & 63;
		const out = [ts0];
		if (frac >= 52) out.push(ts0 + 64);
		if (frac < 12) out.push(ts0 - 64);
		return out;
	}

	/**
	 * A wrong key still passes the parity half of the time, and garbage can set any flag: an aircraft counts only when a
	 * second packet of the same address follows within a minute and agrees with the first (type, flags, rough position).
	 */
	private agree(all: FlarmV6[], id: number, tnow: number, channel: number, level: number): void {
		const s = this.host.stats.flarm;
		const k = this.known.get(id);
		const match = k && all.find((q) => !isFlagged(q) && nearBy(q, k.acType, false, k.lat19, k.lon20));
		if (match) return this.apply(match, tnow, channel, level);
		const h = this.hashId(id);
		if (this.privSet.has(h)) {
			if (all.some(isFlagged)) s.privacyPackets++;
			return;
		}
		for (const [key, v] of this.pending) if (tnow - v[0].t > PENDING_SEC) this.pending.delete(key);
		const waiting = this.pending.get(h);
		for (const q of all)
			for (const pd of waiting ?? [])
				if (nearBy(q, pd.acType, pd.flagged, pd.lat19, pd.lon20)) {
					this.pending.delete(h);
					if (isFlagged(q)) {
						// nothing but a count survives a flagged packet
						s.privacyPackets += 2;
						this.privSet.add(h);
						s.privacyFlagged = this.privSet.size;
						this.known.delete(id);
						this.host.hide(`flarm:${id}`);
						return;
					}
					if (pd.p) this.apply(pd.p, pd.t, pd.channel, pd.level);
					return this.apply(q, tnow, channel, level);
				}
		this.pending.set(
			h,
			all.map((q) => {
				const flagged = isFlagged(q);
				const base = { t: tnow, flagged, acType: q.aircraftType, lat19: q.lat19, lon20: q.lon20, level: 0, channel: 0 };
				return flagged ? base : { ...base, p: q, level, channel };
			}),
		);
	}

	private apply(p: FlarmV6, tnow: number, channel: number, level: number): void {
		this.host.stats.flarm.ok++;
		this.known.set(p.addr, { acType: p.aircraftType, lat19: p.lat19, lon20: p.lon20, lastSeen: tnow });
		const v = unpackVelocity(p);
		const r: AircraftReport = {
			protocol: 'FLARM',
			id: hex6(p.addr),
			idType: addrTypeName(p.addrType),
			aircraft: aircraftTypeName(p.aircraftType),
			altM: p.alt,
			climbMs: v.climbMs,
			speedKmh: v.speedMs * 3.6,
			trackDeg: v.trackDeg,
			channel,
			levelDb: level,
			extra: [['Airborne', p.airborne ? 'yes' : 'no']],
		};
		const ref = this.host.station();
		if (ref) {
			const pos = unpackPosition(p.lat19, p.lon20, ref.lat, ref.lon);
			if (greatCircle(ref.lat, ref.lon, pos.lat, pos.lon).km < MAX_RANGE_KM) Object.assign(r, pos);
		}
		this.host.report(`flarm:${p.addr}`, r, tnow);
	}
}
