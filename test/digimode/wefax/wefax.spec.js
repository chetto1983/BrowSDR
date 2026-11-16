import { describe, expect, it } from 'vitest';
import { BAND_LEVELS, bandMeans, bands, faxPlan, faxSignal, faxSink, faxWidth } from './fixtures';
import { DIGIMODES, digimodeInfo } from '@/worker/decoders/digimode/catalog';
import { WEFAX_OFFSET_HZ, WEFAX_RATE, WefaxDecoder } from '@/worker/decoders/digimode/wefax';
import { faxImageWidth } from '@/worker/decoders/digimode/wefax/core';
import { WEFAX_BROADCASTS, WEFAX_STATIONS, wefaxDialKhz, wefaxNext, wefaxStation } from '@/worker/decoders/digimode/wefax/stations';

/** The plan through the decoder as a USB channel centred 2 kHz above the dial, in 0.1 s blocks. */
function receive(plan, options) {
	const iq = faxSignal(plan, { rate: WEFAX_RATE, offsetHz: -WEFAX_OFFSET_HZ, ...options });
	const sink = faxSink();
	const decoder = new WefaxDecoder(sink);
	const block = WEFAX_RATE / 5;
	for (let i = 0; i < iq.length; i += block) decoder.process(iq.subarray(i, Math.min(iq.length, i + block)));
	return { sink, decoder };
}

const field = (record, label) => record.fields.find(([name]) => name === label)?.[1];

describe('weather fax tables', () => {
	it('gives the picture width of an IOC as fldigi does', () => {
		expect(faxImageWidth(576)).toBe(1809);
		expect(faxImageWidth(288)).toBe(904);
		expect(faxImageWidth(0)).toBe(0);
	});
	it('tunes the presets to the USB dial 1.9 kHz below the assigned frequencies of the station table', () => {
		const info = digimodeInfo('wefax');
		expect(info).toMatchObject({ family: 'Maritime', image: true, rate: WEFAX_RATE, offsetHz: WEFAX_OFFSET_HZ });
		expect(DIGIMODES.filter((mode) => mode.id === 'wefax')).toHaveLength(1);
		const carriers = [...wefaxStation('DDK').carrierKhz, 4610, 8040];
		expect(wefaxStation('GYA').carrierKhz).toEqual(expect.arrayContaining([4610, 8040]));
		expect(info.presets.map((preset) => preset.freqMHz)).toEqual(carriers.map((khz) => Number((wefaxDialKhz(khz) / 1000).toFixed(7))));
		expect(wefaxStation('DDK').carrierKhz).toEqual([3855, 7880, 13882.5]);
	});
	it('lists the next broadcasts soonest first, a chart begun up to 10 minutes ago included', () => {
		expect(WEFAX_STATIONS).toHaveLength(29);
		expect(WEFAX_BROADCASTS.every((b) => wefaxStation(b.station))).toBe(true);
		const now = Date.UTC(2026, 10, 16, 10, 35) / 1000;
		const next = wefaxNext(now, 3, 'Europe');
		expect(next.map((n) => [n.station.id, n.broadcast.product, (n.startUtc - now) / 60])).toEqual([
			['DDK', 'Surface analysis', -5],
			['GYA', 'Surface analysis', 265],
			['SVJ4', 'Surface forecast', 325],
		]);
	});
});

describe('weather fax decoder', () => {
	it('decodes a 120 lpm IOC 576 chart with noise, a tuning error and a clock error', () => {
		const rows = 24;
		const plan = faxPlan({ ioc: 576, lpm: 120, startS: 3, phasing: 10, rows, stopS: 3, blackS: 1 });
		const { sink, decoder } = receive(plan, { mistuneHz: 40, ppm: 30, snrDb: 20, seed: 5 });
		const st = decoder.fax.status();
		expect(st).toMatchObject({ state: 3, ioc: 576, lpm: 120, lines: rows + 1, width: 1809, phasingLines: 10 });
		expect(st.blackHz).toBeCloseTo(1540, -1);
		expect(st.slantPpm).toBeGreaterThan(-40);
		expect(st.slantPpm).toBeLessThan(-20);
		expect(sink.records).toHaveLength(1);
		const [record] = sink.records;
		expect(record).toMatchObject({ text: 'Weather fax chart, 25 lines (120 lpm, IOC 576)', damaged: false });
		expect(field(record, 'Start')).toBe('Phasing, 10 lines');
		expect(field(record, 'End')).toBe('Stop tone');
		expect(field(record, 'Tuning')).toMatch(/^\+(3[5-9]|4[0-5]) Hz/);
		expect(parseFloat(field(record, 'SNR (phasing)'))).toBeGreaterThan(15);
		expect(sink.statuses.map((s) => s.message)).toEqual(
			expect.arrayContaining(['Start tone heard (IOC 576), waiting for phasing', 'Phasing, 120 lpm, IOC 576, tuning +40 Hz']),
		);
		// The rows the app gets: the white line after the phasing, then the bands, edges in place despite the clock error.
		const W = faxWidth(576);
		const pic = sink.picture;
		expect(new Set(sink.images.map((rows) => `${rows.picture} ${rows.width}`)).size).toBe(1);
		expect(pic.rows).toHaveLength(rows + 1);
		pic.rows.forEach((row, r) => expect(row).toEqual(decoder.fax.picture.row(r)));
		expect(pic.rows[0].filter((v) => v < 200).length).toBeLessThan(20);
		for (const row of pic.rows.slice(1)) {
			bandMeans(row, W).forEach((mean, b) => expect(Math.abs(mean - BAND_LEVELS[b])).toBeLessThan(8));
			for (const e of [1, 2, 3]) expect(Math.abs(edge(row, e * Math.floor(W / 9)) - e * Math.floor(W / 9))).toBeLessThan(1);
		}
	}, 20_000);
	it('decodes a 60 lpm IOC 288 chart from its 675 Hz start tone in strong noise', () => {
		const rows = 12;
		const plan = faxPlan({ ioc: 288, lpm: 60, startS: 3, phasing: 8, rows, stopS: 3, blackS: 1 });
		const { sink, decoder } = receive(plan, { mistuneHz: -25, ppm: -20, snrDb: 12, seed: 9 });
		expect(decoder.fax.status()).toMatchObject({ ioc: 288, lpm: 60, lines: rows + 1, width: 904 });
		expect(sink.records.map((record) => record.text)).toEqual(['Weather fax chart, 13 lines (60 lpm, IOC 288)']);
		const pic = sink.picture;
		expect(pic.width).toBe(904);
		expect(pic.rows).toHaveLength(rows + 1);
		for (const row of pic.rows.slice(1))
			bandMeans(row, 904, 6).forEach((mean, b) => expect(Math.abs(mean - BAND_LEVELS[b])).toBeLessThan(12));
	}, 20_000);
	it('picks up a chart joined midway (no start tone, no phasing) from its line rate', () => {
		const rows = 30;
		const plan = faxPlan({ ioc: 576, lpm: 120, startS: 0, phasing: 0, white: false, rows, stopS: 3, blackS: 1 });
		const { sink } = receive(plan, { snrDb: 25, seed: 2 });
		expect(sink.records).toHaveLength(1);
		const [record] = sink.records;
		expect(record.text).toMatch(/^Weather fax chart, \d+ lines \(120 lpm, IOC 576\)$/);
		expect(field(record, 'Start')).toBe('Joined midway (line rate from the picture)');
		expect(field(record, 'SNR (phasing)')).toBeUndefined();
		const pic = sink.picture;
		expect(pic.rows.length).toBeGreaterThanOrEqual(rows - 6);
		// The line start is wherever the search began: every row is the band pattern rolled by the same amount.
		const W = faxWidth(576);
		const pattern = bands(W);
		const error = (row, shift) => row.reduce((sum, v, x) => sum + Math.abs(v - pattern(0, (x + shift) % W)), 0) / W;
		const middle = pic.rows[pic.rows.length >> 1];
		let shift = 0;
		for (let k = 1; k < W; k++) if (error(middle, k) < error(middle, shift)) shift = k;
		for (const row of pic.rows) expect(error(row, shift)).toBeLessThan(8);
	}, 20_000);
	it('reports a chart cut short by the next start tone, and one interrupted by a reset', () => {
		const first = faxPlan({ ioc: 576, lpm: 120, startS: 3, phasing: 10, rows: 10, stopS: 0, blackS: 0 });
		const second = faxPlan({ ioc: 576, lpm: 120, startS: 3, phasing: 10, rows: 8, stopS: 3, blackS: 1 });
		// The tone rows before the new start tone are dropped (a weaker signal can keep one: the 300 Hz tone is in the stop
		// band of the decoder's narrow low pass, so the noise decides what that row reads).
		const { sink } = receive([...first, ...second], { mistuneHz: -30, snrDb: 40, seed: 4 });
		expect(sink.records.map((record) => [record.text, record.damaged])).toEqual([
			['Weather fax chart, 11 lines (120 lpm, IOC 576) · cut short by a new start tone', true],
			['Weather fax chart, 9 lines (120 lpm, IOC 576)', false],
		]);
		expect(sink.picture.rows).toHaveLength(9);
		const iq = faxSignal(second, { rate: WEFAX_RATE, offsetHz: -WEFAX_OFFSET_HZ, snrDb: 25 });
		const cut = faxSink();
		const decoder = new WefaxDecoder(cut);
		decoder.process(iq.subarray(0, 2 * WEFAX_RATE * 11));
		decoder.reset();
		expect(cut.records).toHaveLength(1);
		expect(cut.records[0]).toMatchObject({ damaged: true });
		expect(field(cut.records[0], 'End')).toBe('Reception interrupted');
		expect(cut.picture.rows.length).toBe(Number(field(cut.records[0], 'Lines')));
		expect(cut.statuses.at(-1)).toEqual({ message: 'Waiting for a start tone or phasing lines', locked: false });
	}, 20_000);
});

/** Position of the 50 % crossing nearest `x0` (±25 px), sub-pixel. */
function edge(row, x0) {
	for (let x = x0 - 25; x < x0 + 25; x++) {
		const [a0, a1] = [row[x], row[x + 1]];
		if ((a0 - 127.5) * (a1 - 127.5) < 0) return x + (127.5 - a0) / (a1 - a0) + 0.5;
	}
	return NaN;
}
