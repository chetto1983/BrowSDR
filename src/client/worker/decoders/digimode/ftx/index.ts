// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// FT8 and FT4 for BrowSDR, after OnAir core/src/hfdig/hfdig_ftx.cpp (HfdigFtx: the slot decoder fed with 8 kHz upper
// sideband audio, a queue of slots decoded one after the other, decodes listed per slot, best SNR first, and the clock
// statistics of the telemetry) and core/src/hfdig/hfdig_rx.cpp (the sideband audio every HF decoder gets),
// https://github.com/adswill/OnAir; see third_party/onair.
//
// The channel is complex baseband at 8 kHz centred 1.7 kHz above the dial (the USB band 100 .. 3300 Hz); shifting it
// back and taking the real part gives the audio, as OnAir's receiver hands it to the decoder. The slots are cut from the
// wall clock (Date.now, or a clock the tests inject). OnAir decodes them on a thread of its own; here a slot is decoded a
// step at a time after each block of audio (by default 40 % of the block's duration), so the worker never stops for a
// whole slot: an FT8 slot's decodes come a few seconds after it ends. A gap in the audio (reset) starts the clock again
// but keeps the slots waiting and what the decoder has learnt (OnAir resets only on a new configuration). Upside-down
// (lower sideband) signals are looked for only when asked (OnAir looks by default; it doubles the work, and WSJT-X never
// looks). Not ported: early decodes, slot search, Auto, PSK Reporter / WSPRnet spots, whole-span and multi-band decoding.

import type { Fft } from '@/worker/decoders/dab/ofdm/fft';
import type { DigimodeDecoder, DigimodeSink } from '@/worker/decoders/digimode/types';
import { SlotClock } from './clock';
import { XMem } from './memory';
import { CallHash } from './pack';
import { SlotDecoder } from './slot';
import type { FtxActive, FtxDecode, FtxJob, FtxMode, FtxOptions, FtxSlotReport } from './types';
import { FT4, FT8, spec } from './wave';

export { FT4, FT8 };
/** Complex rate of the channel: OnAir's 8 kHz audio. */
export const FTX_RATE = 8000;
/** The channel is centred this far above the dial, 3.2 kHz wide (100 .. 3300 Hz audio). */
export const FTX_OFFSET_HZ = 1700;
export const FTX_BANDWIDTH = 3200;
/** The oscillator that shifts the dial to 0 Hz: 1700 Hz at 8 kHz repeats every 80 samples. */
const SHIFT_PERIOD = 80;
const SHIFT_COS = Float64Array.from({ length: SHIFT_PERIOD }, (_, n) => Math.cos((2 * Math.PI * FTX_OFFSET_HZ * n) / FTX_RATE));
const SHIFT_SIN = Float64Array.from({ length: SHIFT_PERIOD }, (_, n) => Math.sin((2 * Math.PI * FTX_OFFSET_HZ * n) / FTX_RATE));
/** Decodes of the last minute give the clock error; the warning above 1 s. */
const CLOCK_WINDOW_SEC = 60;
const CLOCK_WARN_SEC = 1;
/** A slow computer: never more than a few slots waiting; the oldest are given up (OnAir's limit). */
const MAX_WAITING = 6;
/** Share of each block's duration spent decoding, and its limits, ms. */
const SLICE_SHARE = 0.4;
const SLICE_MIN_MS = 4;
const SLICE_MAX_MS = 40;

/** hh:mm:ss UTC of a time in seconds. */
export const utcTime = (sec: number): string => new Date(Math.round(sec) * 1000).toISOString().slice(11, 19);
export const signed = (v: number, digits: number): string => {
	const r = Math.round(v * 10 ** digits) / 10 ** digits || 0;
	return `${r > 0 ? '+' : ''}${r.toFixed(digits)}`;
};

/** FT8 / FT4 (and, through WsprDecoder, WSPR): the audio cut into UTC slots, every slot decoded. */
export class FtxDecoder implements DigimodeDecoder {
	private readonly clock: SlotClock;
	private readonly hash = new CallHash();
	private readonly wsprHash = new Map<number, string>();
	private readonly mem = new XMem();
	/** The large FFT of the slot (WSPR: 2^20 points), kept while this decoder runs. */
	private readonly ffts = new Map<number, Fft>();
	private readonly mirrored: boolean;
	private readonly sliceMs: number | undefined;
	private audio = new Float32Array(0);
	private n = 0;
	private recent: Array<[number, number]> = [];
	private lastStatus = '';
	private readonly waiting: FtxJob[] = [];
	private active: FtxActive | null = null;
	/** Slots given up because decoding fell behind. */
	dropped = 0;
	/** The last slot decoded (null before the first). */
	last: FtxSlotReport | null = null;

	constructor(
		protected readonly sink: DigimodeSink,
		readonly mode: FtxMode,
		options: FtxOptions = {},
	) {
		this.clock = new SlotClock(mode, options.now ?? (() => Date.now()));
		this.mirrored = options.mirrored ?? false;
		this.sliceMs = options.sliceMs;
	}

	process(iq: Float32Array): void {
		const count = iq.length >> 1;
		if (this.audio.length < count) this.audio = new Float32Array(count);
		for (let i = 0; i < count; i++) {
			this.audio[i] = iq[2 * i] * SHIFT_COS[this.n] - iq[2 * i + 1] * SHIFT_SIN[this.n];
			if (++this.n === SHIFT_PERIOD) this.n = 0;
		}
		for (const job of this.clock.feed(this.audio.subarray(0, count))) {
			this.waiting.push(job);
			if (this.waiting.length > MAX_WAITING) {
				this.waiting.shift();
				this.dropped++;
			}
		}
		this.decode(this.sliceMs ?? Math.min(SLICE_MAX_MS, Math.max(SLICE_MIN_MS, (SLICE_SHARE * count * 1000) / FTX_RATE)));
		this.report();
	}

	/** A gap in the audio: the clock starts again; the slots waiting and what was learnt are kept. */
	reset(): void {
		this.clock.reset();
		this.n = 0;
	}

	/** Decodes everything waiting, at once (the tests). */
	flush(): void {
		this.decode(Infinity);
	}

	/** Decodes for up to `budgetMs` ms: the slot being decoded, then the ones waiting. */
	private decode(budgetMs: number): void {
		const t0 = performance.now();
		while (performance.now() - t0 < budgetMs) {
			if (!this.active) {
				const job = this.waiting.shift();
				if (!job) return;
				const steps = new SlotDecoder(job, this.hash, this.wsprHash, this.mirrored, this.mem, this.ffts).steps();
				this.active = { job, steps, ms: 0 };
			}
			const t = performance.now();
			const r = this.active.steps.next();
			this.active.ms += performance.now() - t;
			if (r.done) {
				this.slotDone(this.active.job, r.value, this.active.ms);
				this.active = null;
			}
		}
	}

	private slotDone(job: FtxJob, dec: FtxDecode[], ms: number): void {
		this.clock.slotDecoded(dec.map((d) => d.dt));
		dec.sort((a, b) => b.snrDb - a.snrDb);
		for (const d of dec) this.sink.record(this.recordOf(d));
		this.last = { slotUtc: job.slotUtc, decodes: dec.length, ms };
		this.recent = [...this.recent, ...dec.map((d): [number, number] => [d.slotUtc, d.dt])].filter(
			([slot]) => slot >= job.slotUtc - CLOCK_WINDOW_SEC,
		);
		this.lastStatus = '';
	}

	/** One record of a decode: "<SNR> dB <DT> s <freq> Hz <message>". */
	protected recordOf(d: FtxDecode): { text: string; fields: Array<[string, string]> } {
		const fields: Array<[string, string]> = [
			['Mode', spec(d.mode).name],
			['UTC slot', utcTime(d.slotUtc)],
			['SNR', `${d.snrDb} dB (in 2500 Hz)`],
			['DT', `${signed(d.dt, 1)} s`],
			['Audio frequency', `${Math.round(d.hz)} Hz`],
			['Message', d.msg],
		];
		if (d.call) fields.push(['Call', d.call]);
		if (d.grid) fields.push(['Grid', d.grid]);
		if (d.mirrored) fields.push(['Sideband', 'Lower (heard upside down)']);
		if (d.how === 1) fields.push(['Decoded with', 'the soft bits of the same signal in earlier slots']);
		if (d.how === 2) fields.push(['Decoded with', 'the calls of a conversation heard on the band (a priori)']);
		return { text: `${d.snrDb} dB ${signed(d.dt, 1)} s ${Math.round(d.hz)} Hz ${d.msg}`, fields };
	}

	/** The median DT of the decodes of the last minute: the clock error when it is over a second. */
	private clockError(): number | null {
		if (this.recent.length < 2) return null;
		const dts = this.recent.map(([, dt]) => dt).sort((a, b) => a - b);
		const n = dts.length;
		const med = n % 2 ? dts[n >> 1] : 0.5 * (dts[n / 2 - 1] + dts[n / 2]);
		return Math.abs(med) > CLOCK_WARN_SEC ? med : null;
	}

	private report(): void {
		const s = spec(this.mode);
		const p = this.clock.progress();
		const parts = [p ? `${s.name} slot ${utcTime(p.slotUtc)}, ${Math.floor(p.into)} of ${s.period} s` : `${s.name} waiting for audio`];
		if (this.active) parts.push(`decoding the ${utcTime(this.active.job.slotUtc)} slot`);
		const last = this.last;
		if (last) parts.push(`${last.decodes} decode${last.decodes === 1 ? '' : 's'} in the ${utcTime(last.slotUtc)} slot`);
		else if (!this.active) parts.push('first slot not yet complete');
		const err = this.clockError();
		if (err !== null) parts.push(`clock off by ${signed(err, 1)} s`);
		if (this.clock.trim) parts.push(`clock corrected by ${signed(this.clock.trim, 1)} s`);
		const status = parts.join(' · ');
		if (status === this.lastStatus) return;
		this.lastStatus = status;
		this.sink.status(status, (last?.decodes ?? 0) > 0);
	}
}

/** FT8: 15 s slots. */
export class Ft8Decoder extends FtxDecoder {
	constructor(sink: DigimodeSink, options: FtxOptions = {}) {
		super(sink, FT8, options);
	}
}

/** FT4: 7.5 s slots. */
export class Ft4Decoder extends FtxDecoder {
	constructor(sink: DigimodeSink, options: FtxOptions = {}) {
		super(sink, FT4, options);
	}
}
