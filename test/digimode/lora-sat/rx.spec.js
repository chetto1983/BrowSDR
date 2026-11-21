// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir tests/lorasat/test_lorasat_rx.cpp (the presets and the pass model;
// 436.8 MHz SF11 beacons through a pass with the Doppler curve and rate measured from the frames and the tracked
// satellite's name; 137.055 MHz SF8 / 41.7 kHz; 868.1 MHz SF9 - SF12 around the closest approach; SF7, SF8 and SF9 at
// 250 kHz; noise and a radio frequency error; tracking against a one-shot estimate; noise alone),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: through BrowSDR's LoraSatDecoder on the VFO channel
// of each catalog entry (OnAir: the receiver at 2 MS/s with the settings of its dialog; the 41.7 kHz frames through a
// pasted TinyGS configuration in place of OnAir's settings); added: SF7, SF10 and SF12 at 125 and 250 kHz through a
// pass at realistic SNR, inverted IQ, a sync word the search was not told, an implicit-header configuration, chunk
// sizes, the Doppler hint, noise alone on every entry and the processing time of each entry.

import { describe, expect, it } from 'vitest';
import { LoraBank } from '@/worker/decoders/digimode/lora/bank';
import { loraParams } from '@/worker/decoders/digimode/lora/code';
import { LORA_SAT_BANDS, loraSatBand } from '@/worker/decoders/digimode/lora-sat/catalog';
import { LORA_SAT_PRESETS, maxDopplerHz, maxDopplerRateHzS, nearestPreset } from '@/worker/decoders/digimode/lora-sat/presets';
import { parseTinygsModem } from '@/worker/decoders/digimode/lora-sat/tinygs';
import { loraSignal } from '../lora/phy';
import { LoraSatPass, beaconParams, core, decoded, field, fieldNumber, framesAt, runSat, seconds } from './gen';

const B125 = loraSatBand('lora-sat');
const B250 = loraSatBand('lora-sat-250');
const B41 = loraSatBand('lora-sat-41');
const cpu = (r, what) =>
	console.log(`${what}: ${r.secs.toFixed(1)} s of signal in ${r.ms.toFixed(0)} ms (${core(r).toFixed(1)} % of a core)`);

/** The generated frame a record is of: the nearest start. */
const frameOf = (frames, rec) => frames.find((f) => String.fromCharCode(...f.payload) === field(rec, 'Text'));

describe('LoRa satellite presets and the pass model (OnAir)', () => {
	it('keeps every preset plausible and none claims to be verified', () => {
		expect(LORA_SAT_PRESETS.length).toBeGreaterThanOrEqual(5);
		for (const p of LORA_SAT_PRESETS) {
			expect(p.mhz > 130 && p.mhz < 930, p.name).toBe(true);
			expect([125000 / 3, 62500, 125000, 250000, 500000]).toContain(p.bwHz);
			expect(p.sf === 0 || (p.sf >= 7 && p.sf <= 12)).toBe(true);
			expect(p.name && p.note).toBeTruthy();
			// nothing here was checked against a real signal
			expect(p.confidence).not.toBe('documented');
		}
		expect(nearestPreset(436.8)).toBeGreaterThanOrEqual(0);
		expect(nearestPreset(436.81, 15)).toBe(nearestPreset(436.8));
		expect(nearestPreset(150)).toBeLessThan(0);
		const [d436, d868] = [maxDopplerHz(436.8), maxDopplerHz(868.1)];
		expect(d436 > 9500 && d436 < 11000 && d868 > 19000 && d868 < 22000, `${d436} ${d868}`).toBe(true);
		const [r436, r868] = [maxDopplerRateHzS(436.8), maxDopplerRateHzS(868.1)];
		expect(r436 > 100 && r436 < 160 && r868 > 200 && r868 < 320, `${r436} ${r868}`).toBe(true);
		// the generator's own model agrees with those limits
		const p = new LoraSatPass();
		expect(Math.abs(p.dopplerHz(300))).toBeLessThan(1);
		expect(Math.abs(p.rateHzS(300) + (p.carrierMhz * 1e6 * p.speedMS * p.speedMS) / (299792458 * p.closestKm * 1e3))).toBeLessThan(0.5);
		expect(p.dopplerHz(0) > 9000 && p.dopplerHz(600) < -9000 && p.dopplerHz(0) + p.dopplerHz(600) < 1).toBe(true);
		// every channel passes the largest Doppler at 436 MHz with room for the radios' error
		for (const band of LORA_SAT_BANDS) expect((band.filterHz - band.bwHz) / 2).toBeGreaterThan(1.2 * d436);
	});
});

describe('LoRa satellite receiver (OnAir testLorasatRx)', () => {
	it('follows the Doppler curve and rate of a 436.8 MHz SF11 pass and names the satellite', () => {
		const pass = new LoraSatPass({ carrierMhz: 436.8 });
		const frames = framesAt(pass, beaconParams(11, 125000, 0x12), [20, 150, 290, 300, 310, 450, 590], 3.2, { snrDb: 10 });
		const r = runSat(B125, frames, { loraSat: { satellite: { name: 'TEST-SAT 1', norad: 25544 } } });
		cpu(r, '436.8 MHz SF11 pass, 125 kHz blind search');
		expect(decoded(r.records, frames)).toBe(frames.length);
		expect(r.records.filter((x) => x.damaged)).toEqual([]);
		for (const rec of r.records) {
			const f = frameOf(frames, rec);
			const [dop, rate] = [pass.dopplerHz(f.passSec), pass.rateHzS(f.passSec)];
			// the carrier at the first data symbol is about 13 symbols after the frame start: the drift there is allowed for
			expect(Math.abs(fieldNumber(rec, 'Doppler') * 1000 - dop), `${f.passSec} s`).toBeLessThan(80 + Math.abs(rate) * 0.6);
			expect(Math.abs(fieldNumber(rec, 'Doppler rate') - rate), `${f.passSec} s`).toBeLessThan(12 + 0.3 * Math.abs(rate));
			expect(field(rec, 'Satellite')).toMatch(/^TEST-SAT 1 \(NORAD 25544/);
			expect(rec.text).toMatch(/^TEST-SAT 1 · SF11 · 125 kHz · 4\/8 · sync 0x12 · Doppler /);
		}
		expect(r.status.at(-1)[0]).toBe(`7 frame(s), last SF11 ${field(r.records.at(-1), 'Doppler').split(' (')[0]} · pass of TEST-SAT 1`);
	}, 60_000);
	it('decodes 137.055 MHz SF8 / 41.7 kHz with the TinyGS settings of issue #229 and by the blind search', () => {
		const pass = new LoraSatPass({ carrierMhz: 137.055 });
		const p = beaconParams(8, 125000 / 3, 0x12, { cr: 5, preamble: 15 });
		const frames = framesAt(pass, p, [40, 200, 300, 420], 1.5, { snrDb: 10 });
		const modem = parseTinygsModem(
			'{"mode":"LoRa","freq":137.055,"bw":41.7,"sf":8,"cr":5,"sw":18,"pl":15,"crc":true,"fldro":2,"sat":"Issue 229","NORAD":0}',
		);
		expect(modem.kind).toBe('lora');
		const r = runSat(B41, frames, { freqMHz: 137.055, loraSat: { config: modem.config } });
		expect(decoded(r.records, frames)).toBe(frames.length);
		expect(r.status[0][0]).toBe('Listening with the TinyGS settings of Issue 229: SF8 · 41.67 kHz · 4/5 · sync 0x12');
		const blind = runSat(B41, frames, { freqMHz: 137.055 });
		expect(decoded(blind.records, frames)).toBe(frames.length);
	}, 60_000);
	it('follows twice the shift and rate at 868.1 MHz, SF9 to SF12 around the closest approach', () => {
		const pass = new LoraSatPass({ carrierMhz: 868.1 });
		const got = [];
		for (const sf of [9, 10, 11, 12]) {
			const frames = framesAt(pass, beaconParams(sf, 125000, 0x34), [285, 300, 315, 60, 540], sf >= 11 ? 4.5 : 2.2, {
				bytes: 16,
				snrDb: 10,
			});
			const r = runSat(B125, frames, { freqMHz: 868.1 });
			got.push(`SF${sf} ${decoded(r.records, frames)}/${frames.length}`);
			// SF12 with 276 Hz/s through a 1.5 s frame is the edge of what the decoder follows (OnAir measured 4 of 5)
			expect(decoded(r.records, frames), `SF${sf}`).toBeGreaterThanOrEqual(frames.length - (sf === 12 ? 1 : 0));
		}
		console.log(`868.1 MHz, ${pass.rateHzS(300).toFixed(0)} Hz/s at the closest approach: ${got.join(', ')}`);
	}, 120_000);
	it('decodes SF7 and SF8 at 125 kHz and SF9 at 250 kHz through a 70 cm pass', () => {
		const pass = new LoraSatPass({ carrierMhz: 436.8 });
		for (const sf of [7, 8]) {
			const frames = framesAt(pass, beaconParams(sf, 125000, 0x12), [30, 300, 570], 1.2, { bytes: 24, snrDb: 8 });
			expect(decoded(runSat(B125, frames).records, frames), `SF${sf}`).toBe(frames.length);
		}
		const frames = framesAt(pass, beaconParams(9, 250000, 0x12), [100, 300, 500], 1.2, { bytes: 24, snrDb: 8 });
		expect(decoded(runSat(B250, frames).records, frames)).toBe(frames.length);
	}, 60_000);
	it('decodes through noise and a radio frequency error on top of the Doppler', () => {
		const pass = new LoraSatPass({ carrierMhz: 436.8 });
		const frames = framesAt(pass, beaconParams(11, 125000, 0x12), [40, 300, 560], 3.5, { snrDb: -5, cfoHz: 3000 });
		expect(decoded(runSat(B125, frames).records, frames)).toBeGreaterThanOrEqual(2);
		const sf12 = framesAt(pass, beaconParams(12, 125000, 0x12), [60, 300], 6, { snrDb: -8 });
		expect(decoded(runSat(B125, sf12).records, sf12)).toBeGreaterThanOrEqual(1);
	}, 60_000);
	it('decodes more with the carrier followed through the frame than with one estimate (SF12, 868.1 MHz)', () => {
		const pass = new LoraSatPass({ carrierMhz: 868.1 });
		const frames = framesAt(pass, beaconParams(12, 125000, 0x34), [296, 300, 304], 5, { snrDb: 12 });
		const iq = loraSignal(frames, { rate: B125.rate, noiseRms: 0.05, durationSec: seconds(frames) });
		const good = (cfoTrack) => {
			const bank = new LoraBank({ bwHz: 125000, rate: B125.rate, sfs: [12], syncs: [0x34], preamble: 8, cfoTrack, carrierHz: 868.1e6 });
			const out = [];
			bank.feed(iq, out);
			return out.filter((d) => d.frame.crcOk).length;
		};
		const [on, off] = [good(1), good(0)];
		console.log(`SF12 at 868.1 MHz, ${pass.rateHzS(300).toFixed(0)} Hz/s: ${on} of 3 with the carrier followed, ${off} without`);
		expect(on).toBeGreaterThanOrEqual(2);
		expect(on).toBeGreaterThan(off);
	}, 60_000);
	it('hears nothing in noise alone on any entry, and says what each costs', () => {
		const lines = [];
		for (const band of LORA_SAT_BANDS) {
			const r = runSat(band, [], { durationSec: band.bwHz >= 250000 ? 8 : 16, seed: 7 });
			lines.push(`${band.id} ${core(r).toFixed(1)} %`);
			expect(r.records, band.id).toEqual([]);
			expect(r.decoder.stats.frames).toBe(0);
		}
		console.log(`Listening (SF7-SF12, any sync word, both IQ) in noise, per cent of a core: ${lines.join(', ')}`);
	}, 120_000);
});

describe('LoRa satellite receiver: what BrowSDR adds', () => {
	const pass = new LoraSatPass({ carrierMhz: 436.8 });
	it('decodes SF7, SF10 and SF12 at 125 and 250 kHz through a pass at realistic SNR', () => {
		const lines = [];
		for (const band of [B125, B250])
			for (const [sf, snrDb] of [
				[7, 0],
				[10, -8],
				[12, -12],
			]) {
				const gap = (sf === 12 ? 1.6 : sf === 10 ? 0.5 : 0.1) * (125000 / band.bwHz) + 0.3;
				const frames = framesAt(pass, beaconParams(sf, band.bwHz, 0x12), [40, 290, 300, 310, 560], gap, { snrDb, bytes: 24 });
				const r = runSat(band, frames);
				lines.push(`SF${sf} ${band.bwHz / 1000} kHz at ${snrDb} dB: ${decoded(r.records, frames)}/5 (${core(r).toFixed(1)} %)`);
				expect(decoded(r.records, frames), `SF${sf} ${band.bwHz}`).toBe(frames.length);
			}
		console.log(lines.join('\n'));
	}, 180_000);
	it('decodes inverted IQ with the Doppler of the right sign', () => {
		const frames = framesAt(pass, beaconParams(10, 125000, 0x12), [60, 300, 540], 1.0, { snrDb: 0, inverted: true });
		const r = runSat(B125, frames);
		expect(decoded(r.records, frames)).toBe(3);
		for (const rec of r.records) {
			const f = frameOf(frames, rec);
			expect(field(rec, 'IQ')).toBe('inverted');
			expect(rec.text).toContain('inverted IQ');
			expect(Math.abs(fieldNumber(rec, 'Doppler') * 1000 - pass.dopplerHz(f.passSec))).toBeLessThan(150);
		}
	}, 60_000);
	it('finds a sync word it was not told and reports it', () => {
		for (const [sf, sync] of [
			[7, 0x5a],
			[10, 0xa7],
			[12, 0x2b],
		]) {
			const frames = framesAt(pass, beaconParams(sf, 125000, sync), [100, 450], sf === 12 ? 2.2 : 0.8, { snrDb: 0 });
			const r = runSat(B125, frames);
			expect(decoded(r.records, frames), `0x${sync.toString(16)}`).toBe(2);
			for (const rec of r.records) expect(field(rec, 'Sync word')).toBe(`0x${sync.toString(16).toUpperCase()} (${sync})`);
		}
	}, 60_000);
	it('runs a pasted TinyGS configuration: implicit header, its preamble, inverted IQ and LDRO', () => {
		const json =
			'{"mode":"LoRa","freq":436.703,"bw":250.0,"sf":10,"cr":6,"sw":71,"pwr":5,"cl":120,"pl":12,"gain":0,"crc":true,"fldro":1,"iIQ":true,"len":20,"sat":"Norbi","NORAD":46494}';
		const modem = parseTinygsModem(json);
		expect(modem.kind).toBe('lora');
		const p = loraParams({
			sf: 10,
			bwHz: 250000,
			cr: 6,
			crc: true,
			preamble: 12,
			syncWord: 71,
			ldro: true,
			implicitHdr: true,
			implicitLen: 20,
		});
		const frames = framesAt(pass, p, [80, 300, 520], 0.6, { snrDb: -3, inverted: true });
		const r = runSat(B250, frames, { freqMHz: 436.703, loraSat: { config: modem.config } });
		expect(decoded(r.records, frames)).toBe(3);
		expect(
			r.records.map((x) => [
				field(x, 'Header'),
				field(x, 'IQ'),
				field(x, 'Coding rate'),
				field(x, 'Low data rate optimisation'),
				field(x, 'CRC'),
			]),
		).toEqual(Array(3).fill(['implicit (20 bytes)', 'inverted', '4/6', 'on', 'ok']));
		expect(r.records[0].text).toContain('SF10 · 250 kHz · 4/6 · sync 0x47 · inverted IQ · implicit header');
		// without the configuration nothing tells the length: the blind search cannot read these frames
		expect(decoded(runSat(B250, frames, { freqMHz: 436.703 }).records, frames)).toBe(0);
	}, 60_000);
	it('gives the same records whatever the chunk size', () => {
		const frames = framesAt(pass, beaconParams(9, 125000, 0x34), [20, 300, 580], 0.7, { snrDb: -2 });
		const texts = [777, 4096, 65536].map((chunk) => runSat(B125, frames, { chunk }).records.map((x) => x.text));
		expect(texts[0]).toHaveLength(3);
		expect(texts[1]).toEqual(texts[0]);
		expect(texts[2]).toEqual(texts[0]);
	}, 60_000);
	it('takes the Doppler the orbit predicts and shows how far the frame was from it', () => {
		const p868 = new LoraSatPass({ carrierMhz: 868.1 });
		const frames = framesAt(p868, beaconParams(12, 125000, 0x34), [292, 298, 304, 310], 5, { snrDb: -6, first: 10 });
		// the app sends the hint about every second: the Doppler at the start of each frame's pass time, moved on by its rate
		const hint = (t) => {
			const f = frames.find((x) => t < x.endSec) ?? frames.at(-1);
			const pt = f.passSec + (t - f.startSec);
			return { hint: { offsetHz: p868.dopplerHz(pt), rateHzS: p868.rateHzS(pt) }, satellite: { name: 'KOSAR 1.5 868', norad: 67264 } };
		};
		const withHint = runSat(B125, frames, { freqMHz: 868.1, loraSat: hint });
		const without = runSat(B125, frames, { freqMHz: 868.1 });
		const [a, b] = [decoded(withHint.records, frames), decoded(without.records, frames)];
		console.log(`SF12 at 868.1 MHz, -6 dB around the closest approach: ${a} of 4 with the orbit's Doppler, ${b} without`);
		expect(a).toBeGreaterThanOrEqual(b);
		expect(a).toBeGreaterThanOrEqual(3);
		for (const rec of withHint.records.filter((x) => !x.damaged)) {
			expect(field(rec, 'Expected Doppler (orbit)')).toMatch(/^[+−]\d+\.\d\d kHz, [+−]\d+ Hz\/s$/);
			expect(Math.abs(fieldNumber(rec, 'Measured − expected'))).toBeLessThan(0.15);
		}
		expect(withHint.status.at(-1)[0]).toMatch(/ · pass of KOSAR 1\.5 868, expected Doppler [+−]\d+\.\d\d kHz, [+−]\d+ Hz\/s$/);
	}, 120_000);
});
