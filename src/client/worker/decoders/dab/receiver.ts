// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/dab/dab_rx.cpp (DabReceiver: feed, run, processFrame, decodeFic,
// the CIF gap and duplicate frame logic, applySelection, decodeMain, feedCifs, publish, reset),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: input at 2.048 MS/s only (BrowSDR's DDC resamples);
// events instead of telemetry polling; only DAB+ audio sub-channels are decoded (no MP2, DMB, Journaline, SPI, TII).

import type { DabAudioParams, DabEvents, DabReceiverCore, DabSyncStatus } from '@/worker/decoders/dabplus/types';
import { PadDecoder } from './audio/pad';
import { SuperframeDecoder } from './audio/superframe';
import { CIF_BITS, CIF_CU, CIF_PER_FRAME, CU_BITS, DAB_RATE, FRAME } from './constants';
import { EnsembleTables } from './fic/ensemble';
import { FIB_BYTES, FIBS, FicDecoder } from './fic/fic';
import type { Subchannel } from './fic/types';
import { SubchannelDecoder } from './msc/subchannel';
import { SampleBuffer } from './ofdm/buffer';
import { FrameDemod } from './ofdm/demod';
import { Spectrum } from './ofdm/spectrum';
import { OfdmSync } from './ofdm/sync';

/** Status events while there is input: about four per second. */
const STATUS_SAMPLES = DAB_RATE / 4;

const sameSub = (a: Subchannel, b: Subchannel) =>
	a.start === b.start && a.size === b.size && a.eep === b.eep && a.option === b.option && a.level === b.level && a.uepIndex === b.uepIndex;

/**
 * DAB receiver for transmission mode I (EN 300 401, TS 102 563): null-symbol and phase-reference synchronisation,
 * carrier and timing tracking, DQPSK demodulation, the fast information channel and the DAB+ audio of one sub-channel.
 * Complex baseband at 2.048 MS/s in (interleaved, any chunk size), events out.
 */
export class DabReceiver implements DabReceiverCore {
	private readonly buf = new SampleBuffer();
	private readonly spec = new Spectrum();
	private readonly sync = new OfdmSync(this.buf, this.spec);
	private readonly demod = new FrameDemod();
	private readonly fic = new FicDecoder();
	private readonly tables = new EnsembleTables();
	private readonly main = new SubchannelDecoder();
	private readonly pad: PadDecoder;
	private readonly audio: SuperframeDecoder;
	private readonly onFrame = (bytes: Uint8Array, erased: boolean) => this.audio.push(bytes, erased);
	// selection
	private selReq = -1;
	private sel = -1;
	private selSub: Subchannel | null = null;
	private selPlus = false;
	// CIFs lost and frames decoded twice (dab_rx.cpp processFrame)
	private lastU = 0;
	private haveLast = false;
	private lastCif = -1;
	private gapCifs = 0;
	// events
	private framesDone = 0;
	private statusSamples = 0;
	private wasSynced = false;
	/** Share of good FIBs, averaged over the last frames. */
	private ficRatio = 0;
	private ensembleKey = '';

	constructor(private readonly events: DabEvents) {
		this.pad = new PadDecoder((text) => events.label(text));
		this.audio = new SuperframeDecoder((au: Uint8Array, params: DabAudioParams, ok: boolean) => events.audioUnit(au, params, ok), this.pad);
	}

	process(iq: Float32Array): void {
		this.buf.append(iq, this.sync.mirror);
		this.statusSamples += iq.length >> 1;
		this.run();
		if (this.statusSamples >= STATUS_SAMPLES) this.publish();
	}

	/** Decodes this sub-channel's DAB+ audio (null: none). */
	select(subchannel: number | null): void {
		this.selReq = subchannel ?? -1;
		if (this.selReq < 0) this.applySelection();
	}

	/** Starts over: the sync is searched again and the ensemble is learnt again; the selection is kept. */
	reset(): void {
		this.buf.clear();
		this.sync.reset();
		this.tables.clear();
		this.ensembleKey = '';
		this.haveLast = false;
		this.lastCif = -1;
		this.gapCifs = 0;
		this.main.reset();
		this.audio.reset();
		this.pad.reset();
		this.sel = -1;
		this.selSub = null;
		this.framesDone = 0;
		this.ficRatio = 0;
		this.statusSamples = 0;
		this.wasSynced = false;
	}

	private run(): void {
		for (let guard = 0; guard < 64; guard++) {
			if (!this.sync.locked) {
				const r = this.sync.search();
				if (r === 'restart') this.restartDecoding();
				if (r !== 'locked') return;
				continue;
			}
			const t = this.sync.track();
			if (t === 'wait') return;
			if (t === 'lost') {
				this.publish();
				continue;
			}
			this.frame(this.sync.frameStart);
		}
	}

	/** A full search after a failed re-acquisition: the decoding state starts over. */
	private restartDecoding(): void {
		this.haveLast = false;
		this.lastCif = -1;
		this.main.reset();
		this.audio.flushSync();
	}

	private frame(U: number): void {
		const { demod, sync } = this;
		demod.demodulate(this.buf, this.spec, sync, U);
		demod.soft(sync.references(U, demod.meanMag));
		demod.measureSnr();
		this.decodeFic();
		const dup = this.frameGap(U);
		if (!dup) {
			this.decodeMain();
			const fc = this.tables.frameCif;
			this.lastCif = fc >= 0 ? fc : this.lastCif >= 0 ? (this.lastCif + 4 + this.gapCifs) % 5000 : -1;
			this.lastU = U;
			this.haveLast = true;
		}
		this.framesDone++;
		sync.advance(U);
		if (!this.wasSynced || this.framesDone % 3 === 0) this.publish();
	}

	private decodeFic(): void {
		const good = this.fic.decode(this.demod.fic);
		this.ficRatio = this.framesDone ? 0.7 * this.ficRatio + (0.3 * good) / FIBS : good / FIBS;
		this.tables.frameCif = -1;
		for (let slot = 0; slot < FIBS; slot++) if (this.fic.ok[slot]) this.tables.applyFib(this.fic.fibs, slot * FIB_BYTES, slot);
		const info = this.tables.info();
		if (!info) return;
		const key = JSON.stringify(info);
		if (key === this.ensembleKey) return;
		this.ensembleKey = key;
		this.events.ensemble(info);
	}

	/**
	 * CIFs lost since the last frame decoded: from FIG 0/0 (the CIF count) when this frame's FIC carried it, else from
	 * the samples between. True when this frame was decoded before (a re-acquisition on the same frame).
	 */
	private frameGap(U: number): boolean {
		this.gapCifs = 0;
		if (!this.haveLast) return false;
		const fr = (U - this.lastU) / FRAME;
		this.gapCifs = 4 * Math.max(0, Math.round(fr) - 1);
		let dup = fr < 0.5;
		const frameCif = this.tables.frameCif;
		if (frameCif >= 0 && this.lastCif >= 0) {
			const c = (((frameCif - this.lastCif - 4) % 5000) + 5000) % 5000;
			if (c >= 5000 - 64) dup = true;
			else if (c < 2500) {
				this.gapCifs = c;
				dup = false;
			}
		}
		return dup;
	}

	private applySelection(): void {
		if (this.selReq === this.sel) return;
		if (this.selReq < 0) {
			this.sel = -1;
			this.selSub = null;
			this.main.reset();
			this.audio.reset();
			this.pad.reset();
			return;
		}
		const sub = this.tables.subs.get(this.selReq);
		if (!sub) return; // wait until the ensemble tells us about it
		this.sel = this.selReq;
		this.selSub = sub;
		this.selPlus = this.tables.isDabPlus(this.sel);
		this.main.configure(sub);
		this.main.early = this.selPlus ? 10 : 16;
		this.audio.reset();
		this.pad.reset();
	}

	private decodeMain(): void {
		this.applySelection();
		if (this.sel < 0 || !this.selSub) return;
		// a reconfiguration may move or resize the selected sub-channel: follow it (the 16 CIFs of interleaving restart)
		const now = this.tables.subs.get(this.sel);
		if (now && !sameSub(now, this.selSub)) {
			this.selSub = now;
			this.main.configure(now);
			this.audio.flushSync();
		}
		const sub = this.selSub;
		if (!this.selPlus || sub.size <= 0 || sub.start + sub.size > CIF_CU) return;
		// The CIFs lost before this frame go in as erasures (up to 20: beyond that nothing of the 16 CIFs is left)
		if (this.gapCifs > 20) {
			this.main.reset();
			this.audio.flushSync();
		} else for (let k = 0; k < this.gapCifs; k++) this.main.cif(null, 0, this.onFrame);
		const msc = this.demod.msc;
		for (let c = 0; c < CIF_PER_FRAME; c++) this.main.cif(msc, c * CIF_BITS + sub.start * CU_BITS, this.onFrame);
	}

	private publish(): void {
		const sync = this.sync;
		const synced = sync.locked && sync.missed === 0;
		const status: DabSyncStatus = {
			state: synced ? 'synced' : 'searching',
			snrDb: synced ? Math.round(this.demod.snrDb * 10) / 10 : 0,
			freqOffsetHz: Math.round(sync.cfo * 1000) * (sync.mirror ? -1 : 1),
			ficOkRatio: synced ? Math.round(this.ficRatio * 1000) / 1000 : 0,
			frames: this.framesDone,
		};
		this.wasSynced = synced;
		this.statusSamples = 0;
		this.events.status(status);
	}
}
