// HFDL aircraft positions on the ADS-B tool's aircraft map: the records carry them, the app keeps them as aircraft
// tagged HFDL, and the map shows them beside the ADS-B aircraft for as long as an HFDL position stays useful.

import { describe, expect, it } from 'vitest';
import { HfdlDecoder } from '@/worker/decoders/digimode/hfdl';
import { validDigimodeMessage } from '@/worker/decoders/digimode/validation';
import { HFDL_POSITION_MS, mergeHfdlPositions } from '@/app/decoders/adsb/hfdl';
import { hasLivePosition, visibleAircraft } from '@/app/decoders/adsb/aircraft';
import { logonConfirm, mpduDown, mpduUp, perfData, play, unnumbered } from './fixtures';

const message = (records) => ({
	type: 'digimode',
	freq: 8.942,
	mode: 'hfdl',
	status: { state: 'receiving', message: '', records: records.length, locked: true },
	records: records.map((r, i) => ({ id: i + 1, time: 0, mode: 'hfdl', text: r.text ?? 'x', ...r })),
});

describe('HFDL positions for the aircraft map', () => {
	it('puts the aircraft position on the record: by address after a logon, else by its id at the ground station', () => {
		const records = [];
		const dec = new HfdlDecoder({ record: (r) => records.push(r), status: () => {} }, Infinity);
		const tx = [
			{ m1: 1, pdu: mpduUp(7, 0, [logonConfirm(0x4ca2b1, 45)]), t: 0.3 },
			{ m1: 1, pdu: mpduDown(7, 45, [unnumbered(perfData('EI0105', 53.25, -20.5, 40000, 7, 2))]), t: 3 },
			{ m1: 1, pdu: mpduDown(7, 46, [unnumbered(perfData('BA0117', 55, -30, 40100, 7, 2))]), t: 6 },
		];
		play(tx, { snrDb: 30, secs: 9.5, chunk: 4096, each: (b) => dec.process(b) });
		dec.flush();
		expect(records.map((r) => r.position)).toEqual([
			undefined,
			{ id: '4CA2B1', lat: expect.closeTo(53.25, 3), lon: expect.closeTo(-20.5, 3), label: 'EI0105' },
			{ id: 'HFDL 7/46', lat: expect.closeTo(55, 3), lon: expect.closeTo(-30, 3), label: 'BA0117' },
		]);
		expect(validDigimodeMessage(message(records))).toBe(true);
	});

	it('checks the position of records from the worker and remote peers', () => {
		expect(validDigimodeMessage(message([{ position: { id: 'A1B2C3', lat: 10, lon: 20 } }]))).toBe(true);
		expect(validDigimodeMessage(message([{ position: { id: 'A1B2C3', lat: 91, lon: 20 } }]))).toBe(false);
		expect(validDigimodeMessage(message([{ position: { id: 'x'.repeat(40), lat: 1, lon: 2 } }]))).toBe(false);
		expect(validDigimodeMessage(message([{ position: { id: 'A1', lat: 1, lon: 2, label: 7 } }]))).toBe(false);
	});

	it('keeps HFDL aircraft tagged, newest position each, and drops them after 30 minutes', () => {
		const t0 = 1_000_000;
		let list = mergeHfdlPositions([], [{ position: { id: '4CA2B1', lat: 53, lon: -20, label: 'EI0105' } }, { text: 'squitter' }], t0);
		list = mergeHfdlPositions(list, [{ position: { id: 'HFDL 7/46', lat: 55, lon: -30 } }], t0 + 1000);
		list = mergeHfdlPositions(list, [{ position: { id: '4CA2B1', lat: 54, lon: -22 } }], t0 + 2000);
		expect(list.map((a) => [a.icao, a.callsign, a.latitude, a.source, a.messages])).toEqual([
			['HFDL 7/46', undefined, 55, 'hfdl', 1],
			['4CA2B1', 'EI0105', 54, 'hfdl', 2],
		]);
		expect(mergeHfdlPositions(list, [], t0 + 1000 + HFDL_POSITION_MS + 1).map((a) => a.icao)).toEqual(['4CA2B1']);
	});

	it('shows HFDL aircraft with the ADS-B ones, ADS-B first for the same address', () => {
		const now = 5_000_000;
		const adsb = [{ icao: '4CA2B1', latitude: 53.4, longitude: -6.2, positionTime: now - 1000, lastSeen: now - 1000, messages: 40 }];
		const hfdl = mergeHfdlPositions(
			[],
			[{ position: { id: '4CA2B1', lat: 53, lon: -20 } }, { position: { id: 'A00001', lat: 50, lon: -40, label: 'UA0901' } }],
			now - 20 * 60_000,
		);
		const shown = visibleAircraft([adsb], now, hfdl);
		expect(shown.map((a) => [a.icao, a.source ?? 'adsb'])).toEqual([
			['4CA2B1', 'adsb'],
			['A00001', 'hfdl'],
		]);
		expect(shown.every((a) => hasLivePosition(a, now))).toBe(true);
		expect(hasLivePosition(shown[1], now + 11 * 60_000)).toBe(false);
		expect(visibleAircraft([adsb], now + HFDL_POSITION_MS, hfdl)).toEqual([]);
	});
});
