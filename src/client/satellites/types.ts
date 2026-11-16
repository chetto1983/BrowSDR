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
