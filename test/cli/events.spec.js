import { describe, expect, it } from 'vitest';
import { DecodedEvents, formatEvent } from '../../src/cli/events';

const at = new Date('2026-11-13T16:46:03.000Z');
const tpms = { protocol: 88, model: 'Toyota', type: 'TPMS', id: 'd5900009', pressure_kPa: 227.52699, temperature_C: 13, snr: 20.04 };
const adsb = (aircraft) => ({ type: 'adsb', freq: 1090, status: { state: 'receiving', frames: 1 }, aircraft });

describe('decoded events', () => {
	it('turns an rtl_433 event into one record', () => {
		const events = new DecodedEvents();
		expect(events.accept({ type: 'rtl433_event', freq: 433.92, event: tpms }, at)).toEqual([
			{ kind: 'rtl433', time: '2026-11-13T16:46:03.000Z', freq_mhz: 433.92, ...tpms },
		]);
		expect(events.count).toBe(1);
	});

	it('reports an aircraft only when it has new messages', () => {
		const events = new DecodedEvents();
		const first = { icao: '400E5A', callsign: 'EZY79DX', altitude: 37950, messages: 3, lastSeen: 1 };
		expect(events.accept(adsb([first]), at)).toHaveLength(1);
		expect(events.accept(adsb([first]), at)).toHaveLength(0);
		const moved = { ...first, messages: 4, latitude: 44.6, longitude: 7.9 };
		expect(events.accept(adsb([moved]), at)).toEqual([{ kind: 'aircraft', time: '2026-11-13T16:46:03.000Z', freq_mhz: 1090, ...moved }]);
		expect(events.aircraft).toBe(1);
	});

	it('reports a radiosonde once per new frame', () => {
		const events = new DecodedEvents();
		const sonde = { id: 'U3160242', model: 'RS41', frame: 100, lastSeen: 1, messages: 1, frequency: 403, altitude: 8417 };
		const message = (s) => ({ type: 'radiosonde', freq: 403, status: { state: 'receiving' }, sondes: [s] });
		expect(events.accept(message(sonde), at)).toEqual([{ kind: 'radiosonde', time: '2026-11-13T16:46:03.000Z', freq_mhz: 403, ...sonde }]);
		expect(events.accept(message(sonde), at)).toHaveLength(0);
		expect(events.accept(message({ ...sonde, frame: 101, messages: 2 }), at)).toHaveLength(1);
	});

	it('ignores audio, status and debug traffic', () => {
		const events = new DecodedEvents();
		expect(events.accept({ type: 'audio', samples: null, chunkId: 1 }, at)).toEqual([]);
		expect(events.accept({ type: 'rtl433_status', freq: 433.92, status: { state: 'receiving' } }, at)).toEqual([]);
	});
});

describe('human formatting', () => {
	it('puts the identifying fields of a sensor first', () => {
		const line = formatEvent({ kind: 'rtl433', time: '2026-11-13T16:46:03.000Z', freq_mhz: 433.92, ...tpms });
		expect(line).toMatch(/^16:46:03Z +Toyota TPMS d5900009 /);
		expect(line).toContain('pressure_kPa=227.5');
		expect(line).toContain('temperature_C=13');
	});

	it('summarises a radiosonde on one line', () => {
		const line = formatEvent({
			kind: 'radiosonde',
			time: '2026-11-13T16:46:03.000Z',
			freq_mhz: 403,
			id: 'U3160242',
			model: 'RS41',
			frame: 101,
			altitude: 8417.4,
			latitude: 45.1,
			longitude: 8.2,
		});
		expect(line).toMatch(/^16:46:03Z +RS41 U3160242 frame 101 +8417 m +45\.1000,8\.2000/);
	});

	it('summarises an aircraft on one line', () => {
		const line = formatEvent({
			kind: 'aircraft',
			time: '2026-11-13T16:46:03.000Z',
			freq_mhz: 1090,
			icao: '400E5A',
			callsign: 'EZY79DX',
			altitude: 37950,
			latitude: 44.6,
			longitude: 7.9,
		});
		expect(line).toMatch(/^16:46:03Z +400E5A EZY79DX +37950 ft +44\.6000,7\.9000/);
	});
});

describe('Meteor records', () => {
	const status = {
		state: 'receiving',
		message: 'Locked',
		locked: true,
		quality: 0.8,
		freqOffsetHz: 900,
		rs: 1,
		vit: 900,
		mpdus: 4,
		rows: 8,
		apids: [66, 65, 64],
	};
	const rows = { from: 0, to: 8, width: 1568, channels: [0, 1, 2].map((c) => new Uint8Array(8 * 1568).fill(c)) };
	it('reports the decoder status every ten seconds and keeps the image', () => {
		const events = new DecodedEvents();
		const first = events.accept({ type: 'meteor', freq: 137.9, status, rows }, at);
		expect(first).toEqual([{ kind: 'meteor', time: at.toISOString(), freq_mhz: 137.9, ...status }]);
		expect(events.accept({ type: 'meteor', freq: 137.9, status }, new Date(at.getTime() + 5000))).toEqual([]);
		expect(events.accept({ type: 'meteor', freq: 137.9, status }, new Date(at.getTime() + 10000))).toHaveLength(1);
		expect(events.meteorImage.rows).toBe(8);
		expect(events.count).toBe(0);
	});
	it('prints a readable status line', () => {
		expect(formatEvent({ kind: 'meteor', time: at.toISOString(), freq_mhz: 137.9, ...status })).toBe(
			'16:46:03Z  Meteor 137.900 MHz  Locked  lines 8  MPDUs 4  Viterbi 900  RS 1  offset 900 Hz',
		);
	});
});
