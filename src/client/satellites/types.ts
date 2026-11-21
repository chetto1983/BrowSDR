import type { LoraSatHint, LoraSatSatellite } from '@/worker/decoders/digimode/lora-sat/types';

/** Where the station is, for pass predictions. */
export interface Site {
	lat: number;
	lon: number;
	altM: number;
}

export interface Tle {
	name: string;
	norad: number;
	line1: string;
	line2: string;
	epoch: Date;
}

/** One pass above the minimum elevation: rise (AOS), closest approach (TCA) and set (LOS). */
export interface Pass {
	satellite: string;
	norad: number;
	aos: Date;
	tca: Date;
	los: Date;
	maxElevation: number;
	aosAzimuth: number;
	losAzimuth: number;
	/** The satellite was already up at the start of the search. */
	inProgress: boolean;
	/** Below 20°: too low and short to be worth a capture. */
	poor: boolean;
}

export interface SatelliteInfo {
	name: string;
	norad: number;
	freqMHz: number;
}

/** What a TLE cache stores: TLEs with their epochs as ISO strings. */
export interface StoredTles {
	fetchedAt: string;
	tles: Array<Omit<Tle, 'epoch'> & { epoch: string }>;
}

/** Elevation and azimuth of a satellite seen from the station, in degrees. */
export interface Look {
	elevation: number;
	azimuth: number;
}

/** One line of a pass list. */
export interface PassRow {
	key: string;
	label: string;
	/** Local start time, e.g. "lun 16 14:10". */
	when: string;
	/** e.g. "max 50° · 10 min · SE→N". */
	detail: string;
	poor: boolean;
	inProgress: boolean;
	pass: Pass;
}

/** How BrowSDR receives a downlink: demodulator, tuning point and, for linear transponders, the passband. */
export interface Downlink {
	label: string;
	freqMHz: number;
	mode: 'nfm' | 'usb' | 'cw';
	/** Receive filter width when the mode default does not fit (CW beacons need room for Doppler and dongle error). */
	bandwidthHz?: number;
	/** Passband of a linear transponder, in MHz. */
	band?: [number, number];
	/** A decoder that takes the downlink instead of Doppler tracking (its decoder restarts when the frequency changes). */
	decoder?: 'aprs' | 'meteor';
	/** A Digital Modes decoder (Tools → Digital Modes) that takes the downlink, also without Doppler tracking. */
	digimode?: string;
}

/** A satellite on the tracking map, with what it transmits and how to work it. */
export interface TrackedSatellite {
	name: string;
	norad: number;
	downlinks: Downlink[];
	/** Uplink for stations that transmit; BrowSDR only receives. */
	uplink?: string;
	note?: string;
}

/** Where a satellite is at one instant, and how it looks from the station when one is set. */
export interface OrbitState {
	norad: number;
	latitude: number;
	longitude: number;
	altitudeKm: number;
	sunlit: boolean;
	look: (Look & { rangeKm: number; rangeRateKmS: number }) | null;
}

/** Doppler tracking of one downlink on one VFO. */
export interface SatelliteTracking {
	norad: number;
	downlink: number;
	vfoIndex: number;
	/** Downlink frequency at the satellite, in MHz; follows the VFO when the user retunes it. */
	baseMHz: number;
	/** Frequency the tracker last set, to notice manual retuning. */
	lastMHz: number;
	dopplerHz: number;
	/** A LoRa satellite decoder takes the pass: the VFO stays put and the decoder gets the satellite and its Doppler. */
	decode?: boolean;
	satellite?: LoraSatSatellite;
	/** The Doppler the orbit predicts for the decoder, from the VFO frequency. */
	hint?: LoraSatHint;
}

/** A map point in degrees; longitudes may run past ±180° so lines stay continuous. */
export type LatLon = [latitude: number, longitude: number];
