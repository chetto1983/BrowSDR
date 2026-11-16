// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/dab/dab_audio.cpp (dabAacParams, makeAsc, DabAudio::push and
// Impl::superframe: the DAB+ audio superframe of TS 102 563 with its Fire code, the RS(120,110) code words interleaved
// over the superframe, the access unit table and CRCs), https://github.com/adswill/OnAir; see third_party/onair. Changes:
// the access units go to a callback (BrowSDR decodes them with faad2) instead of FFmpeg and the playout; a superframe lost
// while in sync is reported as that many failed access units; MP2 (DAB) frames are not handled.

import type { DabAudioParams } from '@/worker/decoders/dabplus/types';
import { crc16, fireCode } from '@/worker/decoders/dab/fec/crc';
import { rsDecode120 } from '@/worker/decoders/dab/fec/rs';
import type { PadDecoder } from './pad';
import type { AccessUnitSink } from './types';

/** AudioSpecificConfig for DAB+ (AAC-LC with 960-sample frames, SBR / PS signalled explicitly). */
export function makeAsc(dac: boolean, sbr: boolean, stereo: boolean, ps: boolean): Uint8Array {
	const coreRate = sbr ? (dac ? 24000 : 16000) : dac ? 48000 : 32000;
	const freqIdx = (hz: number) => (hz === 48000 ? 3 : hz === 32000 ? 5 : hz === 24000 ? 6 : 8);
	const chan = stereo && !ps ? 2 : 1;
	const bits: number[] = [];
	const put = (x: number, n: number) => {
		for (let i = n - 1; i >= 0; i--) bits.push((x >> i) & 1);
	};
	if (!sbr) {
		put(2, 5);
		put(freqIdx(coreRate), 4);
		put(chan, 4);
	} else {
		put(ps ? 29 : 5, 5);
		put(freqIdx(coreRate), 4);
		put(chan, 4);
		put(freqIdx(coreRate * 2), 4);
		put(2, 5);
	}
	put(1, 1); // frameLengthFlag = 1 (960)
	put(0, 1); // dependsOnCoreCoder
	put(0, 1); // extensionFlag
	const out = new Uint8Array(Math.ceil(bits.length / 8));
	bits.forEach((b, i) => (out[i >> 3] |= b << (7 - (i & 7))));
	return out;
}

/** What the superframe header byte says: rfa, dac_rate, sbr_flag, aac_channel_mode, ps_flag, mpeg_surround_config. */
export function dabAacParams(header: number): DabAudioParams {
	const dac = ((header >> 6) & 1) === 1;
	const sbr = ((header >> 5) & 1) === 1;
	const stereo = ((header >> 4) & 1) === 1;
	const ps = ((header >> 3) & 1) === 1;
	return { sampleRate: dac ? 48000 : 32000, sbr, ps, stereo, asc: makeAsc(dac, sbr, stereo, ps) };
}

/** Access units per superframe by dac_rate and sbr_flag. */
const auCount = (header: number) => (header & 0x40 ? (header & 0x20 ? 3 : 6) : header & 0x20 ? 2 : 4);
/** Where the first access unit starts, by the number of access units. */
const FIRST_START = [0, 0, 5, 6, 8, 0, 11];

/** DAB+ superframes from the logical frames of a sub-channel (5 per superframe, 120 ms). */
export class SuperframeDecoder {
	private frames: Uint8Array[] = [];
	private synced = false;
	private since = 0;
	private consecBad = 0;
	private lastNau = 3;
	private params: DabAudioParams | null = null;
	private header = -1;
	private sf = new Uint8Array(0);
	private payload = new Uint8Array(0);
	private readonly cw = new Uint8Array(120);
	private readonly starts = new Int32Array(8);
	superframesOk = 0;
	superframesBad = 0;
	rsCorrected = 0;
	rsFailed = 0;

	constructor(
		private readonly sink: AccessUnitSink,
		private readonly pad: PadDecoder,
	) {}

	/** A new sub-channel: starts from scratch. */
	reset(): void {
		this.flushSync();
		this.params = null;
		this.header = -1;
		this.superframesOk = this.superframesBad = this.rsCorrected = this.rsFailed = 0;
	}

	/** The stream was interrupted: the superframe phase is searched again. */
	flushSync(): void {
		this.frames = [];
		this.synced = false;
		this.since = 0;
		this.consecBad = 0;
	}

	/** One 24 ms logical frame (erased: lost on the way; it keeps the superframe phase, its superframe fails). */
	push(frame: Uint8Array, erased: boolean): void {
		this.frames.push(erased ? new Uint8Array(frame.length) : frame.slice());
		if (this.frames.length > 5) this.frames.shift();
		if (this.frames.length < 5) return;
		if (this.synced && ++this.since < 5) return;
		if (this.superframe()) {
			this.superframesOk++;
			this.synced = true;
			this.since = 0;
			this.consecBad = 0;
			return;
		}
		if (!this.synced) return;
		this.superframesBad++;
		this.since = 0;
		// the access units of a superframe that did not decode are lost too
		if (this.params) for (let k = 0; k < this.lastNau; k++) this.sink(new Uint8Array(0), this.params, false);
		// the superframe phase is only searched again after a long run of bad ones: a fade keeps it
		if (++this.consecBad >= 8) {
			this.synced = false;
			this.consecBad = 0;
		}
	}

	/** Reed-Solomon over the 5 frames, then the Fire code; false when this is no superframe start. */
	private superframe(): boolean {
		const fb = this.frames[0].length;
		const total = fb * 5,
			N = total / 120;
		if (total % 120 || N < 1 || N > 24) return false;
		if (this.sf.length !== total) {
			this.sf = new Uint8Array(total);
			this.payload = new Uint8Array(N * 110);
		}
		const sf = this.sf,
			payload = this.payload,
			cw = this.cw;
		for (let f = 0; f < 5; f++) sf.set(this.frames[f], f * fb);
		// A code word beyond repair does not end the superframe: its bytes are spread over all of it (one in every N), and
		// the access units it did not touch still pass their CRC.
		let corrected = 0,
			failed = 0;
		for (let i = 0; i < N; i++) {
			for (let j = 0; j < 120; j++) cw[j] = sf[j * N + i];
			const r = rsDecode120(cw);
			if (r < 0) failed++;
			else corrected += r;
			for (let j = 0; j < 110; j++) payload[j * N + i] = cw[j];
		}
		if (fireCode(payload, 9, 2) !== ((payload[0] << 8) | payload[1])) return false;
		const nAu = this.auStarts(payload);
		if (nAu < 0) return false;
		this.rsCorrected += corrected;
		this.rsFailed += failed;
		this.lastNau = nAu;
		const header = payload[2] & 0x7f;
		if (header !== this.header || !this.params) {
			this.header = header;
			this.params = dabAacParams(header);
		}
		for (let k = 0; k < nAu; k++) this.accessUnit(payload.subarray(this.starts[k], this.starts[k + 1]), this.params);
		return true;
	}

	/** The access unit start offsets into `starts` (nAu + 1 entries); -1 when they do not ascend inside the payload. */
	private auStarts(payload: Uint8Array): number {
		const nAu = auCount(payload[2]);
		const starts = this.starts;
		starts[0] = FIRST_START[nAu];
		for (let k = 0; k < nAu - 1; k++) {
			const bit = 12 * k,
				byte = 3 + (bit >> 3);
			starts[k + 1] = bit % 8 === 0 ? (payload[byte] << 4) | (payload[byte + 1] >> 4) : ((payload[byte] & 0x0f) << 8) | payload[byte + 1];
		}
		starts[nAu] = payload.length;
		for (let k = 0; k < nAu; k++) if (starts[k + 1] <= starts[k] || starts[k + 1] > payload.length) return -1;
		return nAu;
	}

	private accessUnit(au: Uint8Array, params: DabAudioParams): void {
		const len = au.length;
		const ok = len >= 3 && crc16(au, len - 2) === ((au[len - 2] << 8) | au[len - 1]);
		const data = au.slice(0, Math.max(0, len - 2));
		if (ok) this.pad.accessUnit(data, data.length);
		this.sink(data, params, ok);
	}
}
