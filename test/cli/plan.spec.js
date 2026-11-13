import { describe, expect, it } from 'vitest';
import { bandChange, planDecode, relayEndpoints } from '../../src/cli/plan';

const idle = { connected: false, state: { frequency_hz: 0, sample_rate: 0, gain_index: 0 }, clients: [] };
const busyAt = (frequencyHz, sampleRate) => ({
	connected: true,
	state: { frequency_hz: frequencyHz, sample_rate: sampleRate, gain_index: 12 },
	clients: [{ id: 1, kind: 'ws', remote: 'browser', controller: true }],
});

describe('relay endpoints', () => {
	it('derives WebSocket and status URLs from a bare host:port', () => {
		expect(relayEndpoints('192.168.250.2:8765')).toEqual({ ws: 'ws://192.168.250.2:8765/', status: 'http://192.168.250.2:8765/status' });
	});
	it('keeps an explicit secure scheme', () => {
		expect(relayEndpoints('wss://radio.example')).toEqual({ ws: 'wss://radio.example/', status: 'https://radio.example/status' });
	});
});

describe('decode planning', () => {
	it('tunes with decoder defaults when nobody else is connected', () => {
		const plan = planDecode('rtl433', {}, idle);
		expect(plan).toMatchObject({ role: 'controller', take: false, freqMHz: 433.92, sampleRate: 1024000 });
		// The DC spike at the tuned centre stays out of the decoder's channel.
		expect(Math.abs(plan.centerMHz - 433.92)).toBeGreaterThan(0.15);
		expect(plan.params).toMatchObject({ freq: 433.92, rtl433: true, enabled: false });
	});

	it('listens inside the band another client chose, without retuning it', () => {
		const plan = planDecode('rtl433', {}, busyAt(433_700_000, 1_024_000));
		expect(plan).toMatchObject({ role: 'listener', take: false, centerMHz: 433.7, sampleRate: 1024000, freqMHz: 433.92 });
	});

	it('refuses to listen outside the band another client chose', () => {
		expect(() => planDecode('adsb', {}, busyAt(433_700_000, 1_024_000))).toThrow(/--take/);
	});

	it('refuses ADS-B below 2 MS/s even when 1090 MHz is in band', () => {
		expect(() => planDecode('adsb', {}, busyAt(1_090_000_000, 1_024_000))).toThrow(/2 MS\/s/);
	});

	it('takes control only when asked', () => {
		const plan = planDecode('adsb', { take: true, gain: 20 }, busyAt(433_700_000, 1_024_000));
		expect(plan).toMatchObject({ role: 'controller', take: true, centerMHz: 1090, sampleRate: 2400000, gainIndex: 20 });
		expect(plan.params).toMatchObject({ freq: 1090, adsb: true });
	});

	it('plans RS41 radiosondes at 403 MHz with the centre moved off the channel', () => {
		const plan = planDecode('radiosonde', {}, idle);
		expect(plan).toMatchObject({ role: 'controller', freqMHz: 403, centerMHz: 402.8, sampleRate: 1024000 });
		expect(plan.params).toMatchObject({ freq: 403, radiosonde: true });
	});

	it('passes rtl_433 protocol selections through', () => {
		expect(planDecode('rtl433', { protocols: '88,89' }, idle).params.rtl433Protocols).toBe('88,89');
	});
});

describe('band watch during a run', () => {
	const listener = planDecode('rtl433', {}, busyAt(433_700_000, 1_024_000));

	it('accepts an unchanged band', () => {
		expect(bandChange(listener, busyAt(433_700_000, 1_024_000))).toBeNull();
	});

	it('reports a controller that retuned underneath a listener', () => {
		expect(bandChange(listener, busyAt(431_700_000, 1_024_000))).toMatch(/431\.700 MHz/);
		expect(bandChange(listener, busyAt(433_700_000, 2_400_000))).toMatch(/2\.400 MS\/s/);
	});

	it('reports a controller that lost control to another client', () => {
		const controller = planDecode('rtl433', {}, idle);
		const takenOver = { ...busyAt(433_700_000, 1_024_000), clients: [{ id: 2, kind: 'ws', remote: 'b', controller: true }] };
		expect(bandChange(controller, takenOver, 1)).toMatch(/control/);
		const stillMine = { ...busyAt(433_700_000, 1_024_000), clients: [{ id: 1, kind: 'ws', remote: 'me', controller: true }] };
		expect(bandChange(controller, stillMine, 1)).toBeNull();
	});
});
