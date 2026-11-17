// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/aero/aero_rx.cpp (AeroReceiver: carrier table, retune, the rate
// tried on every carrier until one holds sync, frames into the SU layer, the system table facts) and
// core/include/dect2/aero/aero_front.h (the channel mixer), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the carriers are those of the VFO's channel, up to four (OnAir: up to twelve in the whole capture); the
// channel is already at OnAir's 48 kHz, so the CIC decimator of each carrier's front end is left out; the samples are
// handed on in pieces of 10 ms, channels before the band search, so that the times and the records do not depend on the
// size of the blocks; the aircraft table, the telemetry report and the automations are left out (the decoder logs).

import { AeroDemod } from './demod';
import { AeroSuDecoder } from './isu';
import { BandSearch } from './search';
import { aeroBlockBytes, aeroParseSystemSu, aeroSplitSus } from './su';
import type { AeroFrameEvent, AeroHeard, AeroReceiverEvents, AeroRegion, AeroSu, AeroSysInfo } from './types';

/** Complex rate of the channel: OnAir's per-carrier rate. */
export const AERO_RATE = 48000;
export const AERO_RATES = [600, 1200, 10500];
const MAX_CHANNELS = 4;
/** Samples per piece (10 ms at 48 kHz). */
const PIECE = 480;
const MAX_SYSTEM_FACTS = 24;

/** One carrier: its mixer, a demodulator per rate until one holds sync, the SU layer. */
export class AeroChannel {
	freq = 0;
	private oscRe = 1;
	private oscIm = 0;
	private rotRe = 1;
	private rotIm = 0;
	readonly dem: Array<AeroDemod | null> = [null, null, null];
	/** Index into AERO_RATES once a rate holds sync, else -1. */
	active = -1;
	lastSeen: number;
	lastSync: number;
	lastGood = -1;
	levelDb: number;
	frames = 0;
	uwMisses = 0;
	susOk = 0;
	susBad = 0;
	ber = 0;
	announced = false;
	readonly suDec = new AeroSuDecoder();

	constructor(
		readonly id: number,
		period: number,
		now: number,
		region: AeroRegion,
	) {
		this.lastSeen = period;
		this.lastSync = now;
		this.levelDb = region.peakDb;
	}

	setFreq(hz: number): void {
		this.freq = hz;
		const w = (-2 * Math.PI * hz) / AERO_RATE;
		this.rotRe = Math.cos(w);
		this.rotIm = Math.sin(w);
		this.oscRe = 1;
		this.oscIm = 0;
	}

	/** Moves the carrier to 0 Hz. */
	mix(iq: Float32Array, out: Float32Array): void {
		let oR = this.oscRe,
			oI = this.oscIm;
		const rR = this.rotRe,
			rI = this.rotIm;
		for (let i = 0; i < iq.length; i += 2) {
			out[i] = iq[i] * oR - iq[i + 1] * oI;
			out[i + 1] = iq[i] * oI + iq[i + 1] * oR;
			const nr = oR * rR - oI * rI;
			oI = oR * rI + oI * rR;
			oR = nr;
			const g = 1.5 - 0.5 * (oR * oR + oI * oI); // keep the oscillator on the unit circle
			oR *= g;
			oI *= g;
		}
		this.oscRe = oR;
		this.oscIm = oI;
	}

	get synced(): boolean {
		return this.dem.some((d) => d?.synced);
	}

	/** The demodulator that tells most about the carrier: the active one, else one in sync, else one with a carrier. */
	get best(): AeroDemod | null {
		if (this.active >= 0 && this.dem[this.active]) return this.dem[this.active];
		return this.dem.find((d) => d?.synced) ?? this.dem.find((d) => d?.acquired) ?? null;
	}

	/** The carrier against the VFO. */
	get carrierHz(): number {
		const d = this.best;
		return d?.acquired ? this.freq + d.freqHz : this.freq;
	}
}

export class AeroReceiver {
	readonly search: BandSearch;
	readonly chans: AeroChannel[] = [];
	/** Samples so far. */
	samples = 0;
	private nextId = 1;
	/** Carriers seen once: frequency and search number. */
	private pending: Array<[number, number]> = [];
	private readonly tmp = new Float32Array(2 * PIECE);
	private readonly sys: Array<AeroSysInfo & { count: number }> = [];
	/** SUs with a good / failed check, all channels. */
	susOk = 0;
	susBad = 0;
	readonly suTypes = new Map<number, number>();

	/** `limitHz`: the band search stays this close to the VFO. */
	constructor(
		private readonly events: AeroReceiverEvents,
		limitHz: number,
	) {
		this.search = new BandSearch(AERO_RATE, limitHz);
	}

	/** Stream time, s, at the start of the current 10 ms (whatever the size of the blocks). */
	get now(): number {
		return (Math.floor(this.samples / PIECE) * PIECE) / AERO_RATE;
	}

	/** Forget the carriers and search again (the SU layer's state goes with its channel). */
	reset(): void {
		this.chans.length = 0;
		this.pending = [];
		this.search.reset();
	}

	process(iq: Float32Array): void {
		for (let at = 0; at < iq.length;) {
			const take = Math.min((iq.length - at) >> 1, PIECE - (this.samples % PIECE), this.search.untilEnd);
			if (take <= 0) return;
			const piece = iq.subarray(at, at + 2 * take);
			for (const c of [...this.chans]) this.processChannel(c, piece);
			this.search.feed(piece, (regions) => this.evaluate(regions));
			this.samples += take;
			at += 2 * take;
		}
	}

	private processChannel(c: AeroChannel, piece: Float32Array): void {
		if (!this.chans.includes(c)) return;
		const out = this.tmp.subarray(0, piece.length);
		c.mix(piece, out);
		for (const d of c.dem) d?.process(out);
		// two channels on one carrier (a wide carrier seen as two pieces): keep the older one
		if (c.synced && this.chans.some((o) => o !== c && o.id < c.id && o.synced && Math.abs(o.carrierHz - c.carrierHz) < 1500)) {
			this.chans.splice(this.chans.indexOf(c), 1);
			return;
		}
		// the rate that held sync lost it for a long time: try all three again
		if (c.active >= 0 && !c.synced && this.now - c.lastSync > 20) {
			c.active = -1;
			AERO_RATES.forEach((_, k) => (c.dem[k] ??= this.demod(c, k)));
		}
	}

	private demod(c: AeroChannel, k: number): AeroDemod {
		return new AeroDemod(AERO_RATES[k], AERO_RATE, AERO_RATES[k] === 10500 ? 1500 : 700, (e) => this.frame(c, k, e));
	}

	private retune(c: AeroChannel, f: number): void {
		c.setFreq(f);
		c.active = -1;
		AERO_RATES.forEach((_, k) => (c.dem[k] = this.demod(c, k)));
	}

	/** Table full: a new wide carrier takes the place of the weakest channel that holds no sync (never one that decodes). */
	private freeSlot(): boolean {
		let worst: AeroChannel | null = null;
		for (const c of this.chans) if (!c.synced && this.now - c.lastSync >= 10 && (!worst || c.levelDb < worst.levelDb)) worst = c;
		if (worst) this.chans.splice(this.chans.indexOf(worst), 1);
		return worst !== null;
	}

	/** A carrier known already, or a new one once it showed in two searches in a row (noise never does twice in one place). */
	private evaluate(regions: AeroRegion[]): void {
		const period = this.search.period;
		const newPending: Array<[number, number]> = [];
		for (const r of regions) {
			const m = this.chans.find((c) => {
				// a 10500 bit/s carrier is about 10 kHz wide: at low levels its spectrum can break into pieces
				const reach = c.active >= 0 && AERO_RATES[c.active] === 10500 ? 7000 : Math.max(1500, r.width / 2);
				return Math.abs(r.freq - c.carrierHz) < reach;
			});
			if (m) {
				m.lastSeen = period;
				m.levelDb = r.peakDb;
				if (!m.synced && this.now - m.lastSync > 3 && Math.abs(r.freq - m.freq) > 400) this.retune(m, r.freq);
				continue;
			}
			if (this.chans.length >= MAX_CHANNELS && r.width < 6000) continue;
			const seen = this.pending.some(([f, p]) => p === period - 1 && Math.abs(f - r.freq) < Math.max(1500, r.width / 2));
			newPending.push([r.freq, period]);
			if (!seen || (this.chans.length >= MAX_CHANNELS && !this.freeSlot())) continue;
			const c = new AeroChannel(this.nextId++, period, this.now, r);
			this.chans.push(c);
			this.retune(c, r.freq);
		}
		this.pending = newPending;
		// channels that went away, and carriers that never gave a frame
		for (let i = this.chans.length - 1; i >= 0; i--) {
			const c = this.chans[i];
			if (!c.synced && (period - c.lastSeen > 8 || this.now - c.lastSync > 40)) this.chans.splice(i, 1);
		}
	}

	heard(c: AeroChannel, bitRate: number, ebn0Db: number): AeroHeard {
		return { channel: c.id, offsetHz: c.carrierHz, bitRate, ebn0Db };
	}

	/** A frame of rate index k on channel c: the rate is taken when half its SUs are good; then its SUs. */
	private frame(c: AeroChannel, k: number, e: AeroFrameEvent): void {
		c.frames++;
		if (e.uwErrors < 0) c.uwMisses++;
		c.susOk += e.susOk;
		c.susBad += e.susBad;
		c.ber = e.channelBer;
		this.susOk += e.susOk;
		this.susBad += e.susBad;
		c.lastSync = this.now;
		if (e.susOk) c.lastGood = this.now;
		const heard = this.heard(c, e.bitRate, e.ebn0Db);
		this.events.frame?.(e, heard);
		if (c.active !== k && e.susOk >= Math.floor(e.bytes.length / 24)) {
			c.active = k;
			c.dem.forEach((_, q) => q !== k && (c.dem[q] = null));
			if (!c.announced) this.events.channel(this.heard(c, e.bitRate, e.ebn0Db));
			c.announced = true;
		}
		const bb = aeroBlockBytes(e.bitRate);
		if (!bb || e.bytes.length % bb) return;
		for (let off = 0; off < e.bytes.length; off += bb)
			for (const su of aeroSplitSus(e.bytes.subarray(off, off + bb), e.bitRate)) this.su(c, su, heard);
	}

	private su(c: AeroChannel, su: AeroSu, heard: AeroHeard): void {
		this.suTypes.set(su.type, (this.suTypes.get(su.type) ?? 0) + 1);
		if (!su.crcOk) return;
		const { acars, logons } = c.suDec.feed(su, this.now);
		for (const l of logons) this.events.logon(l, heard);
		for (const m of acars) this.events.acars(m, heard);
		this.noteSystem(su, heard);
	}

	/** The system table: satellite id (with its longitude) and P/R channel control, each fact once. */
	private noteSystem(su: AeroSu, heard: AeroHeard): void {
		const si = aeroParseSystemSu(su);
		if (si.kind !== 2 && si.kind !== 3) return;
		const known = this.sys.find(
			(e) => e.kind === si.kind && e.satId === si.satId && e.gesId === si.gesId && Math.abs(e.freqMHz[0] - si.freqMHz[0]) < 1e-6,
		);
		if (known) known.count++;
		else if (this.sys.length < MAX_SYSTEM_FACTS) {
			this.sys.push({ ...si, count: 1 });
			this.events.system(si, heard);
		}
	}
}
