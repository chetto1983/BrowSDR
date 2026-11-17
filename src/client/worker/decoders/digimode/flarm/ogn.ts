// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/avroad/avroad_air.cpp (OgnDec: process, chip, finish),
// https://github.com/adswill/OnAir; see third_party/onair. As credited there: the OGN tracker radio protocol of
// OGN-Tracker (Pawel Jalocha) as carried in SoftRF. Changes: the demodulator takes the samples of the shared channel
// filter (front.ts: OnAir's OGN Chain, the same 85 / 140 kHz filter at the same 400 kS/s) in place of its own mixer and
// filter, and OnAir's fastAtan2 in place of std::arg (the libm call was most of its cost); per-phase state in typed
// arrays; a packet seen within 4 ms is taken once, from the louder channel (report.ts FrameQueue; OnAir compares with
// the last packet only, which lets the other channel's copy through when another packet lies between them in the same
// input block); the level of a packet over the noise; packets go out as records of the aircraft (OnAir lists rows); a
// position with the stealth flag is counted and not shown, as the FLARM receiver does with its privacy flags (OnAir's
// OGN decoder shows it).

import { ognAddrName, ognAircraftName, ognParityErrors, ognParse, ognRepair, OGN_BITS, OGN_BYTES, popcount } from './ogn-proto';
import { fastAtan2 } from './dsp';
import type { AircraftReport, FlarmStats, OgnPacket, QueuedFrame } from './types';

/** Samples per chip of the OGN demodulator (400 kS/s). */
const OGN_SPS = 4;
const OGN_CHIPS = 416;
/** Sync 0x0AF3656C as chips: AA66 55A5 9699 965A. */
const SYNC_HI = 0xaa6655a5;
const SYNC_LO = 0x9699965a;
const MAX_SYNC_ERR = 7;
/** Discriminator radians at the nominal ±50 kHz deviation, 400 kS/s. */
const RAD_PER_DEV = (2 * Math.PI * 50e3) / (100e3 * OGN_SPS);

/** OnAir's OGN chip demodulator: FM discriminator, an integrate-and-dump chip value at each of 4 phases, sync hunt. */
export class OgnDemod {
	private prevRe = 1;
	private prevIm = 0;
	private readonly buf = new Float64Array(OGN_SPS);
	private n = 0;
	private integ = 0;
	/** Per phase: the 64-chip sync register against a running mean, then the chips of a packet. */
	private readonly hi = new Int32Array(OGN_SPS);
	private readonly lo = new Int32Array(OGN_SPS);
	private readonly ema = new Float64Array(OGN_SPS);
	private readonly left = new Int32Array(OGN_SPS);
	private readonly inv = new Uint8Array(OGN_SPS);
	private readonly soft = new Float32Array(OGN_SPS * OGN_CHIPS);
	syncs = 0;

	constructor(
		private readonly onFrame: (bytes: Uint8Array, soft: Float32Array, sec: number) => void,
		/** Sample rate, for the time of a packet. */
		private readonly rate: number,
	) {}

	/** The demodulator starts again; the sample count (the packets' clock) carries on. */
	reset(): void {
		this.prevRe = 1;
		this.prevIm = 0;
		this.buf.fill(0);
		this.integ = 0;
		for (const a of [this.hi, this.lo, this.ema, this.left]) a.fill(0);
	}

	/** Filtered samples at 400 kS/s. */
	process(re: Float64Array, im: Float64Array, count: number): void {
		let { prevRe, prevIm, integ } = this;
		const buf = this.buf;
		for (let i = 0; i < count; i++) {
			const zr = re[i] * prevRe + im[i] * prevIm;
			const zi = im[i] * prevRe - re[i] * prevIm;
			const f = fastAtan2(zi, zr) / RAD_PER_DEV; // ±1 at the nominal deviation
			prevRe = re[i];
			prevIm = im[i];
			const k = this.n & (OGN_SPS - 1);
			integ += f - buf[k];
			buf[k] = f;
			this.n++;
			this.chip(this.n & (OGN_SPS - 1), integ / OGN_SPS);
		}
		Object.assign(this, { prevRe, prevIm, integ });
	}

	private chip(p: number, s: number): void {
		if (this.left[p] > 0) {
			this.soft[p * OGN_CHIPS + OGN_CHIPS - this.left[p]] = s;
			if (--this.left[p] === 0) {
				this.finish(p);
				this.hi[p] = this.lo[p] = 0;
			}
			return;
		}
		this.ema[p] += (s - this.ema[p]) * (1 / 32); // the mean of balanced Manchester chips: the carrier offset
		const hi = (this.hi[p] << 1) | (this.lo[p] >>> 31);
		const lo = (this.lo[p] << 1) | (s > this.ema[p] ? 1 : 0);
		this.hi[p] = hi;
		this.lo[p] = lo;
		const hiErr = popcount(hi ^ SYNC_HI);
		if (hiErr > MAX_SYNC_ERR && hiErr < 32 - MAX_SYNC_ERR) return; // neither polarity can match
		const e = hiErr + popcount(lo ^ SYNC_LO);
		if (e <= MAX_SYNC_ERR || 64 - e <= MAX_SYNC_ERR) {
			this.left[p] = OGN_CHIPS;
			this.inv[p] = 64 - e < e ? 1 : 0;
			this.syncs++;
		}
	}

	private finish(p: number): void {
		const bytes = new Uint8Array(OGN_BYTES);
		const soft = new Float32Array(OGN_BITS);
		const chips = this.soft.subarray(p * OGN_CHIPS, (p + 1) * OGN_CHIPS);
		for (let i = 0; i < OGN_BITS; i++) {
			let v = chips[2 * i + 1] - chips[2 * i]; // a 1 is chips 01
			if (this.inv[p]) v = -v;
			soft[i] = v;
			if (v > 0) bytes[i >> 3] |= 1 << (7 - (i & 7));
		}
		this.onFrame(bytes, soft, this.n / this.rate);
	}
}

const hex6 = (v: number): string => (v & 0xffffff).toString(16).toUpperCase().padStart(6, '0');

/** The OGN packets of both channels: LDPC check and repair, address parity, the report. */
export class OgnFrames {
	constructor(
		private readonly stats: FlarmStats,
		private readonly report: (key: string, report: AircraftReport, tnow: number) => void,
		private readonly hide: (key: string) => void,
		private readonly queue: (frame: QueuedFrame) => void,
	) {}

	/** A packet's bits from one phase of one channel: LDPC check and repair, then the queue of the input block. */
	frame(channel: number, bytes: Uint8Array, soft: Float32Array, t: number, level: number): void {
		let fixed = false;
		if (ognParityErrors(bytes)) {
			if (!ognRepair(bytes, soft)) {
				this.stats.ogn.bad++;
				return;
			}
			fixed = true;
		}
		this.queue({ key: `ogn:${String.fromCharCode(...bytes)}`, t, level, apply: () => this.packet(bytes, fixed, channel, t, level) });
	}

	private packet(bytes: Uint8Array, fixed: boolean, channel: number, t: number, level: number): void {
		const o = ognParse(bytes);
		if (!o.addrParityOk) {
			this.stats.ogn.bad++;
			return;
		}
		this.stats.ogn.ok++;
		if (fixed) this.stats.ogn.repaired++;
		this.reportPacket(o, channel, t, level);
	}

	private reportPacket(o: OgnPacket, channel: number, tnow: number, levelDb: number): void {
		const base = {
			protocol: 'OGN' as const,
			id: hex6(o.address),
			idType: ognAddrName(o.addrType),
			channel,
			levelDb,
			extra: [] as Array<[string, string]>,
		};
		const key = `ogn:${o.addrType}:${o.address}`;
		if (o.encrypted) {
			this.stats.ogn.encrypted++;
			this.report(key, { ...base, aircraft: 'unknown', note: 'position encrypted, not read' }, tnow);
			return;
		}
		if (o.other) {
			this.report(`${key}:status`, { ...base, aircraft: 'unknown', note: 'status or information packet' }, tnow);
			return;
		}
		if (o.stealth) {
			this.stats.ogn.privacy++;
			this.hide(key);
			return;
		}
		base.extra.push(['Relay', String(o.relay)], ['Turn rate', `${o.turnDegS.toFixed(1)}°/s`], ['GPS fix', String(o.fixQuality)]);
		if (o.emergency) base.extra.push(['Emergency', 'yes']);
		this.report(
			key,
			{
				...base,
				aircraft: ognAircraftName(o.acftType),
				lat: o.lat,
				lon: o.lon,
				altM: o.altM,
				climbMs: o.climbMs,
				speedKmh: o.speedMs * 3.6,
				trackDeg: o.headingDeg,
				alert: o.emergency,
			},
			tnow,
		);
	}
}
