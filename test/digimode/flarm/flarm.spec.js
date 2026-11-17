// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir tests/flarm/test_flarm_rx.cpp (clean frames, privacy flags
// honoured, the newer protocol counted, bad packets rejected, noise alone, no reference position),
// tests/flarm/test_flarm_impair.cpp (AWGN near the threshold, carrier offsets, chip clock errors, collisions, both
// channels at once, the key-time boundary, a wrong key time) and tests/flarm/test_flarm_chase.cpp (Chase decoding and
// the tone chips against hard decisions of the discriminator), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the decoder's channel rate of 400 kS/s only (OnAir: 1 and 2.4 MS/s radio rates); 20 packets per sweep
// point (OnAir: 30); results come from the records and the decoder's counters (OnAir: telemetry); the saved-results
// check is replaced by a look through the records.
import { describe, expect, it } from 'vitest';
import { FlarmDecoder } from '@/worker/decoders/digimode/flarm';
import { ADDR_ANONYMOUS, ADDR_ICAO, emptyV6, packPosition, packVelocity } from '@/worker/decoders/digimode/flarm/flarm-proto';
import { field, flarmScene, mk, RATE, REF_LAT, REF_LON, runDecoder, twice, U0 } from './fixtures';

function decode(iq, { u0 = U0, station = true, block = 16384, options } = {}) {
	return runDecoder(FlarmDecoder, iq, {
		block,
		options,
		setup: (d) => {
			d.setUnixTime(u0);
			if (station) d.setStation(REF_LAT, REF_LON);
		},
	});
}

const ids = (records) => [...new Set(records.map((r) => field(r, 'Aircraft ID')))].sort();

/** n packets of one aircraft, 0.12 s apart on alternating channels (test_flarm_impair.cpp train). */
function train(u0, n, id, { cfo = 0, gainDb = 0, t0 = 0.05, clockAhead = 0 } = {}) {
	return Array.from({ length: n }, (_, i) => {
		const t = t0 + 0.12 * i;
		const p = emptyV6();
		Object.assign(
			p,
			{ addr: id, aircraftType: 1, alt: 900 + Math.floor(t * 3) },
			packPosition(REF_LAT + (1000 + 25 * t) / 111320, REF_LON + 0.01),
		);
		packVelocity(25, 0, 0.5, p);
		return { timeSec: t, channel: i & 1, keyTime: Math.floor(u0 + t + clockAhead), pkt: p, cfoHz: cfo, gainDb };
	});
}

describe('FLARM receiver', () => {
	it('removes a previously visible aircraft after confirmed privacy packets', () => {
		const clear = [mk(0.1, 0, 0xdd1234, 1500, -2000), mk(0.3, 1, 0xdd1234, 1500, -2000)];
		const privatePackets = [mk(0.7, 0, 0xdd1234, 1500, -2000), mk(0.9, 1, 0xdd1234, 1500, -2000)];
		for (const packet of privatePackets) packet.pkt.noTrack = true;
		const { decoder, records } = decode(flarmScene(RATE, 1.2, [...clear, ...privatePackets], 25, { seed: 1 }));
		expect(ids(records)).toEqual(['DD1234']);
		expect(decoder.stats.flarm.privacyFlagged).toBe(1);
		expect(decoder.heard().has(`flarm:${0xdd1234}`)).toBe(false);
		expect(decoder.aircraftCount()).toBe(0);
	});

	it('lists the aircraft of clean frames, honours the privacy flags and counts the newer protocol', () => {
		const txs = [mk(0.1, 0, 0xdd1234, 1500, -2000), mk(0.3, 1, 0xdda5b6, -4000, 3000, 2), mk(0.5, 0, 0x3f7c11, 800, 800, 8)];
		txs[2].pkt.addrType = ADDR_ICAO;
		const nt = mk(0.7, 1, 0xdd9999, 100, 100);
		nt.pkt.noTrack = true;
		const st = mk(0.9, 0, 0xdd8888, 200, 100);
		st.pkt.stealth = true;
		const an = mk(1.1, 1, 0xdd6666, 300, 100);
		an.pkt.addrType = ADDR_ANONYMOUS;
		const v7 = { timeSec: 1.3, channel: 0, raw: [0x77, 0x77, 0xdd, 0x02, ...Array(20).fill(0x5a)] };
		const bc = { ...mk(1.5, 0, 0xdd5555, 10, 10), badCrc: true };
		const wk = mk(1.7, 1, 0xdd4444, 10, 10);
		wk.keyTime += 64 * 40;
		const iq = flarmScene(RATE, 4.8, twice([...txs, nt, st, an, v7, bc, wk]), 25, { seed: 1 });
		const { records, decoder } = decode(iq);
		const s = decoder.stats.flarm;
		expect([s.ok, ids(records)]).toEqual([6, ['3F7C11', 'DD1234', 'DDA5B6']]);
		const a = records.find((r) => field(r, 'Aircraft ID') === 'DD1234');
		expect(a.text).toMatch(/^FLARM DD1234 · glider · /);
		const [lat] = field(a, 'Position').split(', ').map(Number);
		expect(Math.abs(lat - (REF_LAT + 1500 / 111320))).toBeLessThan(3e-4);
		expect(field(a, 'Altitude')).toBe('800 m');
		expect(Math.abs(parseFloat(field(a, 'Speed')) - 90)).toBeLessThan(4);
		expect(Math.abs(parseFloat(field(a, 'Track')) - 90)).toBeLessThan(6);
		expect(Math.abs(parseFloat(field(a, 'Climb')) - 1)).toBeLessThan(0.3);
		expect(Math.abs(parseFloat(field(a, 'Distance')) - 2.5)).toBeLessThan(0.2);
		expect(
			field(
				records.find((r) => field(r, 'Aircraft ID') === '3F7C11'),
				'ID type',
			),
		).toBe('ICAO');
		expect(
			field(
				records.find((r) => field(r, 'Aircraft ID') === 'DDA5B6'),
				'Aircraft type',
			),
		).toBe('tow plane');
		// privacy: none of the flagged ones appears anywhere, only the count does
		expect(JSON.stringify(records)).not.toMatch(/DD9999|DD8888|DD6666|DD5555|DD4444/);
		expect([s.privacyFlagged, s.newProtocol, s.newProtocolDevices]).toEqual([3, 2, 1]);
		expect(s.bad).toBeGreaterThanOrEqual(1);
	}, 60_000);

	it('gives nothing on noise alone', () => {
		const { records, decoder } = decode(flarmScene(RATE, 4, [], 0, { seed: 7 }));
		expect(records).toEqual([]);
		expect([decoder.stats.flarm.ok, decoder.stats.flarm.newProtocol, decoder.stats.flarm.privacyFlagged]).toEqual([0, 0, 0]);
		expect([decoder.stats.ogn.ok, decoder.stats.adsl.ok]).toEqual([0, 0]);
	}, 60_000);

	it('decodes without a station but shows no position', () => {
		const { records } = decode(flarmScene(RATE, 3, twice([mk(0.1, 0, 0xdd1234, 1000, 1000)]), 30, { seed: 2 }), { station: false });
		expect(records.length).toBe(1);
		expect(field(records[0], 'Position')).toBe('needs the station location');
		expect(field(records[0], 'Altitude')).toBe('800 m');
	}, 60_000);

	it('costs about a tenth of a core', () => {
		const iq = flarmScene(RATE, 4, twice([mk(0.1, 0, 0xdd1234, 1500, -2000), mk(0.4, 1, 0x3f7c11, 800, 800, 8)]), 15, { seed: 8 });
		let best = Infinity;
		for (let rep = 0; rep < 3; rep++) {
			const t0 = performance.now();
			decode(iq, { block: 16384 });
			best = Math.min(best, (performance.now() - t0) / 4);
		}
		console.log(`FLARM / OGN / ADS-L receiver: ${best.toFixed(0)} ms of CPU per second of signal (400 kS/s, both channels)`);
		expect(best).toBeLessThan(500);
	}, 60_000);

	it('takes small chunks as it takes large ones', () => {
		const iq = flarmScene(RATE, 3, twice([mk(0.1, 0, 0xdd1234, 1500, -2000), mk(0.4, 1, 0x3f7c11, 800, 800, 8)]), 20, { seed: 4 });
		const big = decode(iq, { block: 65536 }).records.map((r) => r.text);
		const small = decode(iq, { block: 999 }).records.map((r) => r.text);
		expect(big.length).toBe(2);
		expect(small).toEqual(big);
	}, 60_000);
});

const N = 20;
const U = 1800000000 - (1800000000 % 64) + 20;
const okOf = (txs, snr, { ppm = 0, seed = 3, u0 = U, options } = {}) =>
	decode(flarmScene(RATE, 0.12 * txs.length + 0.3, txs, snr, { ppm, seed }), { u0, options }).decoder;

describe('FLARM receiver under impairments', () => {
	it('decodes near the threshold in white noise and makes nothing up', () => {
		const got = [];
		for (const snr of [20, 16, 11, 7]) {
			const d = okOf(train(U, N, 0xdd1234), snr);
			got.push(d.stats.flarm.ok);
			expect(d.heard().size).toBeLessThanOrEqual(1);
		}
		console.log(`FLARM packets of ${N} at 20 / 16 / 11 / 7 dB in 200 kHz: ${got.join(' / ')}`);
		expect(got[0]).toBeGreaterThanOrEqual(N - 2);
		expect(got[1]).toBeGreaterThanOrEqual((N * 8) / 10);
	}, 60_000);

	it('takes carrier offsets to ±14 kHz and chip clock errors of ±50 ppm', () => {
		const got = [-14000, -4000, 10000].map((cfo) => okOf(train(U, N, 0xdd1234, { cfo }), 22, { seed: 4 }).stats.flarm.ok);
		const clock = [-50, 50].map((ppm) => okOf(train(U, N, 0xdd1234), 22, { ppm, seed: 5 }).stats.flarm.ok);
		for (const ok of [...got, ...clock]) expect(ok).toBeGreaterThanOrEqual(N - 2);
	}, 60_000);

	it('keeps the stronger of two colliding transmitters and never a wrong aircraft', () => {
		const v = [];
		for (const a of train(U, N, 0xdd1234))
			v.push(a, { ...train(U, 1, 0xdd2222, { t0: a.timeSec + 0.0015, gainDb: -14 })[0], channel: a.channel });
		const d = okOf(v, 28, { seed: 6 });
		const heard = d.heard();
		expect([...heard.keys()].every((k) => k === `flarm:${0xdd1234}` || k === `flarm:${0xdd2222}`)).toBe(true);
		expect(heard.get(`flarm:${0xdd1234}`).packets).toBeGreaterThanOrEqual((N * 7) / 10);
		const equal = [];
		for (const a of train(U, N, 0xdd1234)) equal.push(a, { ...train(U, 1, 0xdd2222, { t0: a.timeSec + 0.002 })[0], channel: a.channel });
		expect([...okOf(equal, 28, { seed: 7 }).heard().keys()].every((k) => k === `flarm:${0xdd1234}` || k === `flarm:${0xdd2222}`)).toBe(
			true,
		);
	}, 60_000);

	it('hears both channels at once', () => {
		const v = train(U, N, 0xdd1234).flatMap((a) => [
			{ ...a, channel: 0 },
			{ ...train(U, 1, 0xdd2222, { t0: a.timeSec })[0], channel: 1 },
		]);
		const d = okOf(v, 24, { seed: 8 });
		expect(d.heard().size).toBe(2);
		expect(d.stats.flarm.ok).toBeGreaterThanOrEqual(2 * N - 6);
	}, 60_000);

	it('finds the key time at a 64 s step boundary and none for a clock minutes off', () => {
		for (const ahead of [-4, 4]) {
			const ub = 1800000000 - (1800000000 % 64) + (ahead > 0 ? 62 : 2);
			expect(okOf(train(ub, 12, 0xdd1234, { clockAhead: ahead }), 24, { seed: 9, u0: ub }).stats.flarm.ok).toBeGreaterThanOrEqual(10);
		}
		const d = okOf(train(U, N, 0xdd1234, { clockAhead: 300 }), 24, { seed: 10 });
		expect(d.heard().size === 0 || d.stats.flarm.ok < 4).toBe(true);
	}, 60_000);

	it('accepts more packets near the threshold with tone chips and Chase decoding than with hard discriminator chips', () => {
		let hard = 0;
		let soft = 0;
		for (const snr of [6, 5]) {
			const txs = train(U, N, 0xdd1234, { cfo: 3000 });
			const iq = flarmScene(RATE, 0.12 * N + 0.3, txs, snr, { seed: 1 });
			const h = decode(iq, { options: { chase: false, toneDetect: false } }).decoder;
			const c = decode(iq).decoder;
			console.log(`FLARM ${snr} dB: discriminator, hard ${h.stats.flarm.ok}; tone chips + Chase ${c.stats.flarm.ok} of ${N}`);
			expect(c.heard().size).toBeLessThanOrEqual(1);
			hard += h.stats.flarm.ok;
			soft += c.stats.flarm.ok;
		}
		expect(soft).toBeGreaterThan(hard);
	}, 60_000);
});
