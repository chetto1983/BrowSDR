import { describe, expect, it } from 'vitest';
import { predictPasses } from '@/satellites/passes';
import { fetchTleText, noradNumber, parseTle } from '@/satellites/tle';
import { TINYGS_TLE_URL, tinygsSatellites } from '@/satellites/tinygs';
import { SITE, TINYGS_TLE } from './fixtures';

describe("TinyGS's LoRa satellites", () => {
	it('reads Alpha-5 NORAD numbers', () => {
		expect([' 7530', '25544', 'A0001', 'A1140', 'H9999', 'J0000', 'Z9999', 'I0001', 'O0001', 'A12'].map(noradNumber)).toEqual([
			7530,
			25544,
			100001,
			101140,
			179999,
			180000,
			339999,
			NaN,
			NaN,
			NaN,
		]);
		expect(parseTle(TINYGS_TLE).map((tle) => tle.norad)).toEqual([57179, 57191, 61747, 57191, 62676, 101140, 61747]);
	});
	it("fetches BrowSDR's copy of the element file", async () => {
		const tles = await fetchTleText(TINYGS_TLE_URL, async (url) => {
			expect(url).toBe('/api/tinygs/tle');
			return new Response(TINYGS_TLE);
		});
		expect(tles).toHaveLength(7);
		await expect(fetchTleText(TINYGS_TLE_URL, async () => new Response('Bad gateway', { status: 502 }))).rejects.toThrow('HTTP 502');
	});
	it('lists each satellite once with its names, SatNOGS and OnAir frequencies, or none', () => {
		const { tles, satellites } = tinygsSatellites(parseTle(TINYGS_TLE), new Set([62676]));
		expect(satellites.map((s) => [s.norad, s.name, s.downlinks.map((d) => [d.freqMHz, d.digimode])])).toEqual([
			[57179, 'Norby-2', [[436.5, 'lora-sat-250']]],
			[57191, 'Polytech_Universe-3', [[436.55, 'lora-sat-62']]],
			[61747, 'Polytech_Universe-4 / Surve-260827-K4KDR', []],
			[
				101140,
				'FossaSat-2E27',
				[
					[436.8, 'lora-sat'],
					[436.2, 'lora-sat'],
					[401.703, 'lora-sat'],
				],
			],
		]);
		expect(tles.map((tle) => tle.name)).toEqual(satellites.map((s) => s.name));
		expect(satellites[0].downlinks[0].label).toBe('LoRa 250 kHz · SatNOGS: Mode U - LoRa (SF:10 CR:5 BW:250)');
		expect(satellites[3].downlinks[0].label).toMatch(/^LoRa 125 kHz · OnAir \(uncertain\): FOSSA Systems/);
		expect(satellites[0].note).toMatch(/none checked against a real signal/);
		expect(satellites[2].note).toMatch(/no LoRa frequency is known here/);
	});
	it('predicts their passes, the Alpha-5 one too', () => {
		const { tles } = tinygsSatellites(parseTle(TINYGS_TLE), new Set());
		const passes = predictPasses(tles, SITE, new Date('2026-11-21T00:00:00Z'), 24);
		expect(new Set(passes.map((p) => p.norad))).toEqual(new Set([57179, 57191, 61747, 62676, 101140]));
		expect(passes.find((p) => p.norad === 61747).satellite).toBe('Polytech_Universe-4 / Surve-260827-K4KDR');
	});
});
