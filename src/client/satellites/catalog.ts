import type { SatelliteInfo, TrackedSatellite } from './types';

/** Meteor-M weather satellites with LRPT downlinks (72k QPSK; 137.100 MHz is the backup frequency). */
export const METEOR_SATELLITES: readonly SatelliteInfo[] = [
	{ name: 'Meteor-M2 3', norad: 57166, freqMHz: 137.9 },
	{ name: 'Meteor-M2 4', norad: 59051, freqMHz: 137.9 },
];

const ISS: TrackedSatellite = {
	name: 'ISS',
	norad: 25544,
	downlinks: [
		{ label: 'FM voice / SSTV', freqMHz: 145.8, mode: 'nfm' },
		{ label: 'FM repeater', freqMHz: 437.8, mode: 'nfm' },
		{ label: 'APRS digipeater (ARISS 2026-11)', freqMHz: 437.825, mode: 'nfm', decoder: 'aprs' },
		{ label: 'SSTV pictures', freqMHz: 145.8, mode: 'nfm', digimode: 'sstv-fm' },
		{ label: 'APRS digipeater (alternate)', freqMHz: 145.825, mode: 'nfm', decoder: 'aprs' },
	],
	uplink: 'Repeater 145.990 MHz FM, CTCSS 67 Hz · check ARISS for the current APRS channel',
	note: 'ARISS reported APRS on 437.825 MHz in November 2026; 145.825 MHz is an alternate. Check ARISS status before a pass. Crew contacts and SSTV events follow the ARISS schedule.',
};

/** Linear transponders: the tuning point is the middle of the passband; inverting means LSB up, USB down. */
const LINEAR: TrackedSatellite[] = [
	{
		name: 'RS-44',
		norad: 44909,
		downlinks: [
			{ label: 'Transponder', freqMHz: 435.64, mode: 'usb', band: [435.61, 435.67] },
			{ label: 'CW beacon', freqMHz: 435.605, mode: 'cw', bandwidthHz: 1000 },
		],
		uplink: '145.935–145.995 MHz LSB/CW, inverting',
	},
	{
		name: 'FO-29',
		norad: 24278,
		downlinks: [
			{ label: 'Transponder', freqMHz: 435.85, mode: 'usb', band: [435.8, 435.9] },
			{ label: 'CW beacon', freqMHz: 435.795, mode: 'cw', bandwidthHz: 1000 },
		],
		uplink: '145.900–146.000 MHz LSB/CW, inverting',
		note: 'Switched on by schedule; stays on until the battery voltage drops.',
	},
	{
		name: 'AO-7',
		norad: 7530,
		downlinks: [
			{ label: 'Mode B transponder', freqMHz: 145.95, mode: 'usb', band: [145.925, 145.975] },
			{ label: 'Mode A transponder', freqMHz: 29.45, mode: 'usb', band: [29.4, 29.5] },
			{ label: 'Mode A beacon', freqMHz: 29.502, mode: 'cw', bandwidthHz: 1000 },
		],
		uplink: 'Mode B 432.125–432.175 MHz LSB, inverting · Mode A 145.850–145.950 MHz USB',
		note: 'Works only in sunlight; a 24-hour timer alternates mode A (10 m down) and mode B (2 m down).',
	},
	{
		name: 'JO-97',
		norad: 43803,
		downlinks: [{ label: 'Transponder', freqMHz: 145.865, mode: 'usb', band: [145.855, 145.875] }],
		uplink: '435.100–435.120 MHz LSB/CW, inverting',
	},
];

/** Satellites on the tracking map: amateur FM and linear birds (AMSAT frequency tables, November 2026) and Meteor-M. */
export const TRACKED_SATELLITES: readonly TrackedSatellite[] = [
	ISS,
	{
		name: 'SO-50',
		norad: 27607,
		downlinks: [{ label: 'FM repeater', freqMHz: 436.795, mode: 'nfm' }],
		uplink: '145.850 MHz FM, CTCSS 67 Hz; arm the 10-minute timer with 2 s of 74.4 Hz',
	},
	{
		name: 'AO-123',
		norad: 61781,
		downlinks: [{ label: 'FM repeater', freqMHz: 435.4, mode: 'nfm' }],
		uplink: '145.850 MHz FM, CTCSS 67 Hz',
	},
	...LINEAR,
	...METEOR_SATELLITES.map((satellite) => ({
		name: satellite.name,
		norad: satellite.norad,
		downlinks: [{ label: 'LRPT images', freqMHz: satellite.freqMHz, mode: 'nfm' as const, decoder: 'meteor' as const }],
		note: 'Weather pictures: Track opens the Meteor panel with its decoder.',
	})),
];

/** The short name BrowSDR uses for a satellite (Celestrak calls SO-50 "SAUDISAT 1C (SO-50)"). */
export function satelliteName(norad: number, fallback: string): string {
	return TRACKED_SATELLITES.find((satellite) => satellite.norad === norad)?.name ?? fallback;
}
