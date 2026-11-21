// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/lorawan/lora_bank.cpp (Bank: one chip stream per channel shared by
// a demodulator per spreading factor, one preamble search for all sync words, the same frame locked by two settings
// reported once) and the frame bookkeeping of core/src/mesh/mesh_rx.cpp, https://github.com/adswill/OnAir; see
// third_party/onair. LoRa facts as credited there: gr-lora_sdr (Joachim Tapparel, EPFL, and contributors, GPL-3.0).
// Changes: one channel, the VFO's, which BrowSDR's DDC has already mixed to 0 Hz, filtered and decimated (in place of
// OnAir's channelizers); inverted IQ is a second bank fed the conjugate (the satellite decoder); the satellite settings
// of OnAir's Channel (carrierHz, cfoTrack, implicitLen) plus any sync word, a forced low data rate optimisation and the
// orbit's Doppler hint (setHint).

import { ChanBuf, ChipStream } from './chips';
import { autoLdro, loraParams } from './code';
import { Demod } from './demod';
import type { LoraBankConfig, LoraDecoded, LoraFrame } from './types';

/** Input is processed in blocks of this many complex samples. */
const BLOCK = 4096;

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/** The LoRa demodulators of one channel: every spreading factor of the configuration, every sync word. */
export class LoraBank {
	private readonly buf = new ChanBuf();
	private readonly cs: ChipStream;
	private readonly demods: Demod[];
	private readonly frames: LoraFrame[] = [];
	private recent: Array<{ payload: Uint8Array; sec: number; sf: number }> = [];

	constructor(readonly cfg: LoraBankConfig) {
		this.cs = new ChipStream(cfg.rate / cfg.bwHz);
		this.demods = cfg.sfs.map((sf) => {
			const p = loraParams({
				sf,
				bwHz: cfg.bwHz,
				syncWord: cfg.syncs[0],
				moreSync: cfg.syncs.slice(1),
				preamble: cfg.preamble,
				ldro: cfg.ldro ?? autoLdro(sf, cfg.bwHz),
				anySync: !!cfg.anySync,
				cfoTrack: cfg.cfoTrack ?? 0,
				carrierHz: cfg.carrierHz ?? 0,
				...(cfg.implicitLen ? { implicitHdr: true, implicitLen: cfg.implicitLen, cr: cfg.cr ?? 5, crc: cfg.crc ?? true } : {}),
			});
			const d = new Demod(p, cfg.rate, this.cs);
			d.reset(0);
			return d;
		});
	}

	/** Demodulating a frame (its sync word found) on any spreading factor. */
	get receiving(): boolean {
		return this.demods.some((d) => d.receiving);
	}

	/** The spreading factors demodulating a frame now. */
	receivingSfs(): number[] {
		return this.demods.filter((d) => d.receiving).map((d) => d.sf);
	}

	/** The carrier offset (Hz) and its drift (Hz/s) the orbit predicts for the next frames; NaN when not known. */
	setHint(offsetHz: number, rateHzS: number): void {
		const bw = this.cfg.bwHz;
		for (const d of this.demods) {
			d.hintBins = (offsetHz * d.n) / bw;
			d.hintRate = (rateHzS * d.n * d.n) / (bw * bw);
		}
	}

	/** Preambles, sync words, headers and frames counted by the demodulators. */
	stats(): { preambles: number; frames: number; crcBad: number } {
		let preambles = 0,
			frames = 0,
			crcBad = 0;
		for (const d of this.demods) [preambles, frames, crcBad] = [preambles + d.st.preambles, frames + d.st.frames, crcBad + d.st.crcBad];
		return { preambles, frames, crcBad };
	}

	/** Interleaved complex samples at the channel rate; finished frames are appended to out. */
	feed(iq: Float32Array, out: LoraDecoded[]): void {
		const count = iq.length >> 1;
		for (let i = 0; i < count; i += BLOCK) this.block(iq, 2 * i, Math.min(BLOCK, count - i), out);
	}

	private block(iq: Float32Array, offset: number, count: number, out: LoraDecoded[]): void {
		const b = this.buf;
		b.append(iq, offset, count);
		this.cs.extend(b);
		let keep = b.end;
		for (const d of this.demods) {
			this.frames.length = 0;
			d.process(b, this.frames);
			for (const f of this.frames) this.found(d, f, out);
			keep = Math.min(keep, d.oldestNeeded());
		}
		b.trim(keep);
		this.cs.trimToSample(keep);
	}

	private found(d: Demod, f: LoraFrame, out: LoraDecoded[]): void {
		const sec = f.startSample / this.cfg.rate;
		// another setting locked the same frame
		if (this.recent.some((r) => r.sf !== d.sf && sameBytes(r.payload, f.payload) && Math.abs(r.sec - sec) < 0.25)) return;
		this.recent.push({ payload: f.payload, sec, sf: d.sf });
		if (this.recent.length > 16) this.recent.shift();
		const sync = this.cfg.anySync || this.cfg.syncs.includes(f.syncWord) ? f.syncWord : this.cfg.syncs[0];
		out.push({ sf: d.sf, sync, bwHz: this.cfg.bwHz, sec, frame: f });
	}
}
