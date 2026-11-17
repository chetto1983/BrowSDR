// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir tests/adsl/test_adsl_rx.cpp (fields end to end, every M-band
// channel, key index, parity and version with the default and the shortest preamble, carrier offset and clock error,
// an inverted spectrum, a noise sweep, overlapping packets, a garbled length byte, the CRC repair of a known aircraft
// only, a reserved key, Status and Traffic Uplink, noise alone, FLARM in the same capture) and
// tests/adsl/test_adsl_tone.cpp (tone chips against the discriminator near the threshold, ±15 kHz),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: the M-band only (868.2 / 868.4 MHz) on the decoder's
// 400 kS/s channel; Traffic Uplink on the M-band with Reed-Solomon parity (OnAir sends it on the O-band HDR channel);
// 2 noise seeds per point (OnAir: 3); the strong neighbour is made at 1.6 MS/s and filtered down to the channel; results
// from the records and the decoder's counters.
import { describe, expect, it } from 'vitest';
import { FlarmDecoder } from '@/worker/decoders/digimode/flarm';
import * as A from '@/worker/decoders/digimode/flarm/adsl-proto';
import {
	adslAircraft,
	adslBurst,
	adslChips,
	adslTrafficNet,
	field,
	flarmBursts,
	mk,
	RATE,
	REF_LAT,
	REF_LON,
	runDecoder,
	scene,
	U0,
	wideScene,
} from './fixtures';

const decode = (iq, options) =>
	runDecoder(FlarmDecoder, iq, {
		options,
		setup: (d) => {
			d.setStation(REF_LAT, REF_LON);
			d.setUnixTime(U0);
		},
	});
const tail = (bursts) => Math.max(...bursts.map((b) => b.timeSec + b.chips.length / 100000)) + 0.05;
const run = (bursts, snr = 25, opts = {}) => decode(scene(RATE, tail(bursts), bursts, snr, opts), opts.options);
const idsOf = (records) => [...new Set(records.filter((r) => r.text.startsWith('ADS-L')).map((r) => field(r, 'Aircraft ID')))].sort();

function goodCount(channel, snr, { cfo = 0, ppm = 0, n = 4, seed = 7, version = 1, key = 0, fec = false, preamble = 8, options } = {}) {
	const bursts = Array.from({ length: n }, (_, i) =>
		adslBurst(0.05 + i * 0.05, channel, adslTrafficNet(adslAircraft(0x400000 + i), version, key, fec), { cfoHz: cfo, preamble }),
	);
	return idsOf(run(bursts, snr, { ppm, seed, options }).records).length;
}

describe('ADS-L on the M-band', () => {
	it('reads the fields of a Traffic packet', () => {
		const { records, decoder } = run([adslBurst(0.05, 0, adslTrafficNet(adslAircraft(0xdd4711)))], 30);
		expect(records.length).toBe(1);
		const r = records[0];
		expect(r.text).toMatch(/^ADS-L DD4711 · glider · 54\.70000, 25\.30000 · 1234 m · 113 km\/h · track 248° · -1\.\d m\/s · 0\.0 km$/);
		expect([field(r, 'ID type'), field(r, 'Flight state'), field(r, 'Emergency'), field(r, 'Channel')]).toEqual([
			'FLARM',
			'airborne',
			'none',
			'868.2 MHz',
		]);
		expect(Math.abs(parseFloat(field(r, 'Climb')) + 1.25)).toBeLessThan(0.07);
		expect([decoder.stats.adsl.ok, decoder.stats.adsl.traffic]).toEqual([1, 1]);
	});

	it('decodes every channel, key index, parity and version with the default and the shortest preamble', () => {
		const wrong = [];
		for (const channel of [0, 1])
			for (const key of [0, 3])
				for (const fec of [false, true])
					for (const version of [0, 1])
						for (const preamble of [8, 5]) {
							const got = goodCount(channel, 25, { key, fec, version, preamble });
							if (got !== 4) wrong.push(`${channel} ${key} ${fec} ${version} ${preamble}: ${got}`);
						}
		expect(wrong).toEqual([]);
	}, 60_000);

	it('takes carrier offsets to ±20 kHz with ±40 ppm of clock error, and an inverted spectrum', () => {
		const wrong = [];
		for (const cfo of [-20000, -10000, 0, 10000, 20000])
			for (const ppm of [-40, 40]) {
				const got = goodCount(cfo > 0 ? 1 : 0, 25, { cfo, ppm, seed: 11 });
				if (got !== 4) wrong.push(`${cfo} ${ppm}: ${got}`);
			}
		expect(wrong).toEqual([]);
		const iq = scene(RATE, 0.3, [adslBurst(0.05, 0, adslTrafficNet(adslAircraft(0x111111)))], 25);
		for (let i = 1; i < iq.length; i += 2) iq[i] = -iq[i];
		expect(idsOf(decode(iq).records)).toEqual(['111111']);
	}, 60_000);

	it('decodes in white noise and gives nothing on noise alone', () => {
		const got = [18, 12, 8].map((snr) => goodCount(0, snr, { cfo: 3000, n: 8, seed: 1 }) + goodCount(1, snr, { cfo: 3000, n: 8, seed: 2 }));
		console.log(`ADS-L packets of 16 at 18 / 12 / 8 dB in 200 kHz: ${got.join(' / ')}`);
		expect(got[0]).toBe(16);
		const { records, decoder } = decode(scene(RATE, 6, [], 0, { seed: 5 }));
		expect([records.length, decoder.stats.adsl.ok]).toEqual([0, 0]);
	}, 60_000);

	it('keeps the stronger of a collision and takes packets back to back, on both channels and beside a strong neighbour', () => {
		const a = adslTrafficNet(adslAircraft(0x777777));
		const q = adslTrafficNet(adslAircraft(0x888888));
		expect(idsOf(run([adslBurst(0.05, 0, a), adslBurst(0.0515, 0, q, { gainDb: -14 })]).records)).toContain('777777');
		expect(idsOf(run([adslBurst(0.05, 0, a), adslBurst(0.05, 1, q)]).records)).toEqual(['777777', '888888']);
		expect(idsOf(run([adslBurst(0.05, 0, a), adslBurst(0.0548, 0, q)]).records)).toEqual(['777777', '888888']);
		// a neighbour 20 dB stronger (made wide and filtered down, as the DDC does, so that it does not fold into the band)
		const wide = wideScene(0.3, [adslBurst(0.05, 0, a, { gainDb: -20 }), adslBurst(0.05, 1, q)], 45);
		expect(idsOf(decode(wide).records)).toEqual(['777777', '888888']);
	});

	it('survives a garbled length byte', () => {
		const net = adslTrafficNet(adslAircraft(0x123123));
		const chips = adslChips(net);
		const o = 2 * 8 + 8 + 16 * 2; // preamble, "1001 1001", the two sync bytes
		for (let i = 0; i < 4; i++) chips[o + i] ^= 1;
		expect(idsOf(run([{ timeSec: 0.05, channelHz: 868.2e6, chips }]).records)).toEqual(['123123']);
	});

	it('repairs a bad bit only for an aircraft already known', () => {
		const bad = adslTrafficNet(adslAircraft(0x654321));
		bad[9] ^= 0x10;
		let r = run([adslBurst(0.05, 0, bad)]);
		expect([r.decoder.stats.adsl.corrected, r.records.length]).toEqual([1, 0]);
		r = run([adslBurst(0.02, 0, adslTrafficNet(adslAircraft(0x654321))), adslBurst(0.1, 0, bad)]);
		expect([r.decoder.stats.adsl.corrected, r.decoder.heard().get(`adsl:6:${0x654321}`).packets]).toEqual([1, 2]);
	});

	it('counts a reserved key, adds Status to a known aircraft and lists Traffic Uplink targets', () => {
		let r = run([adslBurst(0.05, 0, adslTrafficNet(adslAircraft(0x222222), 1, 1, false))]);
		expect([r.decoder.stats.adsl.encrypted, r.records.length]).toEqual([1, 0]);
		const st = A.makeNetwork(
			A.makeData(
				A.TYPE_STATUS,
				A.AMT_FLARM,
				0x333333,
				false,
				A.packStatus({
					maxVersion: 1,
					mRx: 3,
					ldrRx: 0,
					hdrRx: 0,
					mobile: 0,
					econRx: 0,
					econTx: 0,
					xpdr: 0,
					trafficClient: false,
					fisClient: false,
				}),
			),
			1,
			0,
			false,
		);
		const up = [];
		for (const id of [0x500001, 0x500002, 0x500003]) {
			const e = new Uint8Array(19);
			const w = (A.AMT_ICAO | (id << 6)) >>> 0;
			e.set([w & 255, (w >>> 8) & 255, (w >>> 16) & 255, w >>> 24]);
			e.set(A.packTraffic(adslAircraft(id, 1, 50 + (id & 15))), 4);
			up.push(...e);
		}
		while ((up.length + 5) % 4) up.push(0);
		const unet = A.makeNetwork(A.makeData(A.TYPE_UPLINK, A.AMT_OGN, 0xf00001, false, up), 1, 0, true);
		r = run([
			adslBurst(0.02, 1, adslTrafficNet(adslAircraft(0x333333))),
			adslBurst(0.08, 0, st),
			adslBurst(0.14, 0, unet),
			adslBurst(5.2, 1, adslTrafficNet(adslAircraft(0x333333))),
		]);
		expect([r.decoder.stats.adsl.status, r.decoder.stats.adsl.uplink]).toEqual([1, 1]);
		const later = r.records.filter((x) => field(x, 'Aircraft ID') === '333333').at(-1);
		expect(field(later, 'Receives')).toBe('M-band 3, O-band LDR 0, HDR 0');
		const target = r.records.find((x) => field(x, 'Aircraft ID') === '500002');
		expect([field(target, 'ID type'), field(target, 'Received'), field(target, 'Position').startsWith('52.00000')]).toEqual([
			'ICAO',
			'through a ground uplink',
			true,
		]);
	});

	it('hears FLARM and ADS-L out of the same channel', () => {
		const bursts = [
			adslBurst(0.05, 1, adslTrafficNet(adslAircraft(0x77abcd))),
			...flarmBursts([mk(0.3, 0, 0xdd1234, 1000, 1000), mk(0.6, 1, 0xdd1234, 1000, 1000)]),
		];
		const { records } = run(bursts);
		expect(records.map((r) => r.text.split(' · ')[0]).sort()).toEqual(['ADS-L 77ABCD', 'FLARM DD1234']);
	});

	it('takes more packets near the threshold with tone chips than with the discriminator', () => {
		let dis = 0;
		let ton = 0;
		for (const channel of [0, 1]) {
			expect(goodCount(channel, 20, { cfo: 15000, n: 10, seed: 2 })).toBe(10);
			expect(goodCount(channel, 20, { cfo: -15000, n: 10, seed: 3 })).toBe(10);
			dis += goodCount(channel, 5, { cfo: 2000, n: 20, seed: 10, options: { toneDetect: false } });
			ton += goodCount(channel, 5, { cfo: 2000, n: 20, seed: 10 });
		}
		console.log(`ADS-L at 5 dB: discriminator ${dis}, tone chips ${ton} of 40`);
		expect(ton).toBeGreaterThan(dis);
	}, 60_000);
});
