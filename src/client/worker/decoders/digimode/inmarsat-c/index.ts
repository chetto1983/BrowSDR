// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/inmc/inmc_rx.cpp (InmcReceiver and Chan: the frame bookkeeping of
// decodeAt, the report every quarter second, the log lines) and core/include/dect2/inmc/inmc_tel.h (inmcSummary),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: one channel, the one the VFO is on (OnAir also
// searches the whole capture for up to three more and moves the tuned one to a carrier up to 85 kHz away); a message is
// logged when it completes, or as incomplete when its packets stop coming three frames before it is whole; a repeat
// broadcast of the same text is not logged again. The message list, the results file and the automations are left out.
//
// Inmarsat-C NCS common channel: 1200 symbol/s BPSK in frames of 8.64 s carrying the bulletin board, signalling and the
// EGC broadcasts (SafetyNET maritime safety information, FleetNET).

import type { DigimodeDecoder, DigimodeSink } from '@/worker/decoders/digimode/types';
import { FRAME_SECONDS } from './code';
import { InmcDemod, MAX_CFO_HZ } from './demod';
import { InmcFramer } from './framer';
import { FrameParser } from './packets';
import { channelName, messageRecord, signedHz } from './report';
import type { InmcFrameEvent, InmcSlot } from './types';

/** Complex rate of the channel: OnAir's first rate (96 to 190 kS/s); the squared carrier at twice a 20 kHz offset fits. */
export const INMC_RATE = 96000;
/** Report period, s. */
const TICK = 0.25;
/** Frames without a new packet after which an incomplete message is logged as it is. */
const IDLE_FRAMES = 3;

export class InmarsatCDecoder implements DigimodeDecoder {
	readonly demod: InmcDemod;
	readonly framer: InmcFramer;
	readonly parser = new FrameParser();
	/** Frames whose bulletin board checked, and the ones found by their unique word that did not. */
	framesOk = 0;
	framesBad = 0;
	/** Frames in sync (the bulletin board checks). */
	frameLock = false;
	uwAvg = 0;
	symbolErrorRate = 0;
	private consecBad = 0;
	private sinceTick = 0;
	private readonly tickSamples: number;
	private ticks = 0;
	private lastStatus = '';
	private lastState = -1;

	constructor(
		private readonly sink: DigimodeSink,
		rate = INMC_RATE,
	) {
		this.framer = new InmcFramer((event) => this.frame(event));
		this.demod = new InmcDemod(rate, (soft) => this.framer.push(soft, this.demod.carrierLock));
		this.tickSamples = Math.round(rate * TICK);
		this.status(true);
	}

	process(iq: Float32Array): void {
		for (let at = 0; at < iq.length;) {
			const take = Math.min(iq.length - at, 2 * (this.tickSamples - this.sinceTick));
			this.demod.process(iq.subarray(at, at + take));
			at += take;
			this.sinceTick += take >> 1;
			if (this.sinceTick >= this.tickSamples) {
				this.sinceTick = 0;
				this.tick();
			}
		}
	}

	/** A gap in the samples: the signal is searched again; the messages being assembled are kept. */
	reset(): void {
		this.demod.reset();
		this.framer.reset();
		this.frameLock = false;
		this.consecBad = 0;
		this.sinceTick = 0;
		this.status(true);
	}

	private tick(): void {
		this.ticks++;
		if (this.demod.tick(TICK)) {
			this.framer.tracking = false;
			this.frameLock = false;
		}
		this.status(this.ticks % 4 === 0);
	}

	private frame(event: InmcFrameEvent): void {
		const ok = this.parser.parseFrame(event.decode.bytes);
		this.uwAvg = this.framer.framesFound === 1 ? event.uwErrors : this.uwAvg + 0.2 * (event.uwErrors - this.uwAvg);
		this.symbolErrorRate = event.decode.symbolErrors / 10240;
		if (ok) {
			this.framesOk++;
			this.consecBad = 0;
			this.frameLock = true;
		} else {
			this.framesBad++;
			if (++this.consecBad >= 3) this.frameLock = false;
		}
		for (const slot of this.parser.touched) if (slot.msg.complete) this.log(slot);
		for (const slot of this.parser.slots) if (!slot.msg.complete && slot.idleFrames === IDLE_FRAMES) this.log(slot);
		this.status(true);
	}

	/** Logs a message whose text the log has not shown yet (or showed as incomplete). */
	private log(slot: InmcSlot): void {
		const m = slot.msg;
		if (!m.text && !m.complete) return;
		if (slot.shown === m.text && (slot.shownComplete || !m.complete)) return;
		slot.shown = m.text;
		slot.shownComplete = m.complete;
		this.sink.record(messageRecord(m, this.parser.ncs, { ebn0Db: this.ebn0Db, cfoHz: this.demod.cfoHz }));
	}

	/** Eb/N0 = Es/N0 + 3 dB (rate 1/2 code); 0 without carrier lock. */
	get ebn0Db(): number {
		const es = this.demod.esn0Db;
		return es ? es + 3.01 : 0;
	}

	/** The state (0 searching, 1 carrier found, 2 carrier locked, 3 frames) and the status line. */
	private statusLine(): [number, string] {
		const d = this.demod;
		if (!d.acquired) return [0, `Searching for the carrier (±${MAX_CFO_HZ / 1000} kHz)`];
		const carrier = `carrier ${signedHz(d.cfoHz)}`;
		if (!d.carrierLock) return [1, `Carrier found, ${carrier}, locking`];
		const ebn0 = `Eb/N0 ${this.ebn0Db.toFixed(1)} dB`;
		if (!this.frameLock) return [2, `Carrier locked, ${carrier}, ${ebn0}, looking for frames (${FRAME_SECONDS} s each)`];
		const ncs = this.parser.ncs;
		const messages = this.parser.messageCount;
		return [3, `${channelName(ncs)} · frame ${ncs.frameNo} · ${ebn0} · ${carrier} · ${messages} message${messages === 1 ? '' : 's'}`];
	}

	/** The status line; `now` lets a new reading out, else only a change of state does. */
	private status(now: boolean): void {
		const [state, line] = this.statusLine();
		if ((!now && state === this.lastState) || line === this.lastStatus) return;
		this.lastState = state;
		this.lastStatus = line;
		this.sink.status(line, this.frameLock);
	}
}
