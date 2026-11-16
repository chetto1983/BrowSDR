import type { SatelliteInfo } from './types';

/** Meteor-M weather satellites with LRPT downlinks (72k QPSK; 137.100 MHz is the backup frequency). */
export const METEOR_SATELLITES: readonly SatelliteInfo[] = [
	{ name: 'Meteor-M2 3', norad: 57166, freqMHz: 137.9 },
	{ name: 'Meteor-M2 4', norad: 59051, freqMHz: 137.9 },
];
