// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/lorasat/lorasat_rx.cpp (LoraSatReceiver: the LoRa bank with the
// carrier followed through each frame and the carrier frequency for the stretched symbol clock, the preamble of 8, the
// SF7 - SF12 search, the frame rows, the tracked satellite's name, the receiver's state), with the inverted-IQ bank of
// core/src/lorawan/lora_bank.cpp (the conjugate of the channel), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: one channel, the VFO's, of the catalog entry's bandwidth (OnAir: a channel filter widened from the dial
// frequency); in place of OnAir's sync words 0x12 and 0x34, any sync word; normal and inverted IQ at once; a TinyGS modem
// configuration runs exactly (one SF, sync word, IQ, implicit header, preamble, LDRO); the Doppler the orbit predicts
// (from the Satellites tool) centres the carrier search and seeds the drift; records in place of the frame log, Doppler
// plot, feeds and automations.

import { LoraBank } from '@/worker/decoders/digimode/lora/bank';
import { autoLdro, sfdExtraSymbols } from '@/worker/decoders/digimode/lora/code';
import type { LoraBankConfig, LoraDecoded } from '@/worker/decoders/digimode/lora/types';
import type { DigimodeDecoder, DigimodeOptions, DigimodeSink } from '@/worker/decoders/digimode/types';
import { dopplerAllowanceHz, LORA_SAT_BANDS } from './catalog';
import { dopplerText, frameRecord, kHz, settingsText } from './report';
import type { LoraSatBand, LoraSatConfig, LoraSatFrame, LoraSatHint, LoraSatLane as Lane, LoraSatSatellite } from './types';
import { validLoraSatParams } from './validation';

/** Spreading factors of the blind search (OnAir's automatic SF; SF5 and SF6 only from a configuration). */
export const BLIND_SFS = [7, 8, 9, 10, 11, 12];
/** OnAir's loop gain for the carrier through the frame. */
const CFO_TRACK = 1;
const BLIND_PREAMBLE = 8;

const khz = (hz: number) => `${+(hz / 1000).toFixed(2)} kHz`;

/** LoRa frames from satellites on the VFO channel: blind search or a TinyGS configuration, following the Doppler. */
export class LoraSatDecoder implements DigimodeDecoder {
	readonly stats = { frames: 0, crcBad: 0 };
	private lanes: Lane[] = [];
	private config?: LoraSatConfig;
	private freqMHz = 0;
	private hint?: LoraSatHint;
	/** Samples fed when the hint arrived (it is extrapolated with its rate). */
	private hintAt = 0;
	private satellite?: LoraSatSatellite;
	private samples = 0;
	/** Samples fed when the lanes started (their frame times count from there). */
	private lanesAt = 0;
	private readonly got: LoraDecoded[] = [];
	private conj = new Float32Array(0);
	private recent: Array<{ payload: Uint8Array; sec: number }> = [];
	private last = '';
	private lastStatus = '';

	constructor(
		private readonly sink: DigimodeSink,
		readonly band: LoraSatBand = LORA_SAT_BANDS[0],
	) {
		this.lanes = this.build();
	}

	private build(): Lane[] {
		const c = this.config;
		const iqs = c ? [c.inverted] : [false, true];
		this.recent = [];
		this.lanesAt = this.samples;
		return iqs.map((inverted) => ({ bank: new LoraBank(this.bankConfig(inverted)), inverted }));
	}

	private bankConfig(inverted: boolean): LoraBankConfig {
		const c = this.config;
		// for the conjugate the carrier is at minus the frequency: the stretched clock keeps its sign
		const carrierHz = (inverted ? -1 : 1) * this.freqMHz * 1e6;
		const common = { rate: this.band.rate, cfoTrack: CFO_TRACK, carrierHz };
		if (!c) return { ...common, bwHz: this.band.bwHz, sfs: BLIND_SFS, syncs: [0x12, 0x34], anySync: true, preamble: BLIND_PREAMBLE };
		return {
			...common,
			bwHz: c.bwHz,
			sfs: [c.sf],
			syncs: [c.sync],
			preamble: c.preamble,
			ldro: c.ldro === 'auto' ? autoLdro(c.sf, c.bwHz) : c.ldro === 'on',
			...(c.implicitLen ? { implicitLen: c.implicitLen, cr: c.cr, crc: c.crc } : {}),
		};
	}

	/** The VFO frequency, a TinyGS configuration, the tracked satellite and its Doppler (each VFO parameter update). */
	setOptions(options: DigimodeOptions): void {
		const params = validLoraSatParams(options.loraSat) ? options.loraSat : undefined;
		const config = params?.config;
		const freq = Number.isFinite(options.freqMHz) ? options.freqMHz : 0;
		if (freq !== this.freqMHz || JSON.stringify(config) !== JSON.stringify(this.config)) {
			this.freqMHz = freq;
			this.config = config;
			this.lanes = this.build();
		}
		if (JSON.stringify(params?.hint) !== JSON.stringify(this.hint)) {
			this.hint = params?.hint ? { ...params.hint } : undefined;
			this.hintAt = this.samples;
		}
		this.satellite = params?.satellite ? { ...params.satellite } : undefined;
	}

	/** The Doppler the orbit predicts at a sample (the hint moved on by its rate). */
	private expected(sample = this.samples): LoraSatHint | undefined {
		const h = this.hint;
		if (!h) return undefined;
		const dt = (sample - this.hintAt) / this.band.rate;
		return { offsetHz: h.offsetHz + h.rateHzS * dt, rateHzS: h.rateHzS };
	}

	/** The sample of a frame's first data symbol, where its Doppler is measured. */
	private dataSample(d: LoraDecoded, preamble: number): number {
		const symbols = preamble + 4.25 + sfdExtraSymbols(d.sf);
		return this.lanesAt + d.frame.startSample + (symbols * (1 << d.sf) * this.band.rate) / d.bwHz;
	}

	process(iq: Float32Array): void {
		const hint = this.expected();
		this.got.length = 0;
		let locked = false;
		for (const lane of this.lanes) {
			const sign = lane.inverted ? -1 : 1;
			lane.bank.setHint(hint ? sign * hint.offsetHz : NaN, hint ? sign * hint.rateHzS : NaN);
			const start = this.got.length;
			lane.bank.feed(lane.inverted ? this.conjugate(iq) : iq, this.got);
			for (let i = start; i < this.got.length; i++) this.report(this.got[i], lane);
			locked ||= lane.bank.receiving;
		}
		this.samples += iq.length >> 1;
		const status = this.statusText(locked, hint);
		if (status !== this.lastStatus || this.got.length) {
			this.lastStatus = status;
			this.sink.status(status, locked);
		}
	}

	reset(): void {
		this.lanes = this.build();
	}

	private conjugate(iq: Float32Array): Float32Array {
		if (this.conj.length < iq.length) this.conj = new Float32Array(iq.length);
		const out = this.conj.subarray(0, iq.length);
		for (let i = 0; i < iq.length; i += 2) {
			out[i] = iq[i];
			out[i + 1] = -iq[i + 1];
		}
		return out;
	}

	private report(d: LoraDecoded, lane: Lane): void {
		const f = d.frame;
		const hint = this.expected(this.dataSample(d, lane.bank.cfg.preamble));
		// the lanes start together, so their frame times compare
		const sec = d.sec;
		if (
			this.recent.some(
				(r) => Math.abs(r.sec - sec) < 0.25 && r.payload.length === f.payload.length && r.payload.every((v, i) => v === f.payload[i]),
			)
		)
			return;
		this.recent = [...this.recent.slice(-15), { payload: f.payload, sec }];
		const sign = lane.inverted ? -1 : 1;
		const dopplerHz = sign * f.cfoStartHz;
		const frame: LoraSatFrame = {
			sf: d.sf,
			bwHz: d.bwHz,
			cr: f.hdr.cr,
			sync: d.sync,
			inverted: lane.inverted,
			implicit: !!this.config?.implicitLen,
			ldro: lane.bank.cfg.ldro ?? autoLdro(d.sf, d.bwHz),
			hasCrc: f.hdr.crc,
			crcOk: f.crcOk,
			corrected: f.corrected,
			snrDb: f.snrDb,
			levelDb: f.levelDb,
			dopplerHz,
			rateHzS: sign * f.cfoRateHzS,
			freqMHz: this.freqMHz ? this.freqMHz + dopplerHz / 1e6 : 0,
			payload: f.payload,
			satellite: this.satellite,
			hint,
		};
		this.stats.frames++;
		if (frame.hasCrc && !frame.crcOk) this.stats.crcBad++;
		else this.last = `SF${frame.sf} ${kHz(frame.dopplerHz)}`;
		this.sink.record(frameRecord(frame));
	}

	private statusText(locked: boolean, hint: LoraSatHint | undefined): string {
		const pass = this.satellite
			? ` · pass of ${this.satellite.name}${hint ? `, expected Doppler ${dopplerText(hint.offsetHz, hint.rateHzS)}` : ''}`
			: '';
		if (locked) {
			const sfs = this.lanes.flatMap((l) => l.bank.receivingSfs().map((sf) => `SF${sf}${l.inverted ? ' inverted IQ' : ''}`));
			return `Receiving a LoRa frame (${sfs.join(', ')})${pass}`;
		}
		const { frames, crcBad } = this.stats;
		if (frames) return `${frames} frame(s)${crcBad ? `, ${crcBad} CRC error(s)` : ''}${this.last ? `, last ${this.last}` : ''}${pass}`;
		const c = this.config;
		if (c)
			return `Listening with the TinyGS settings${c.sat ? ` of ${c.sat}` : ''}: ${settingsText({ ...c, implicit: !!c.implicitLen })}${pass}`;
		return `Listening: SF7–SF12, any sync word, normal and inverted IQ, ${khz(this.band.bwHz)}, Doppler up to ±${khz(dopplerAllowanceHz(this.band))}${pass}`;
	}
}
