import { describe, expect, it } from 'vitest';
import { bookmarkDecode, describeBookmark } from '../../src/cli/bookmarks';

const decoderGroup = (id, name, centerFreq, sampleRate, vfo) => ({
	id,
	type: 'group',
	name,
	centerFreq,
	sampleRate,
	vfos: [{ mode: 'nfm', bandwidth: 12500, ...vfo }],
});
const BOOKMARKS = [
	{ id: 'radiopi-fm-100.6', type: 'individual', name: 'FM 100.6', freq: 100.6, mode: 'wfm' },
	decoderGroup('radiopi-adsb-1090', 'ADS-B 1090 (decoder)', 1090, 2400000, { freq: 1090, adsb: true }),
	decoderGroup('radiopi-tpms-433.92', 'rtl_433 433.92 (TPMS)', 433.7, 1024000, { freq: 433.92, rtl433: true, rtl433Protocols: '88' }),
	decoderGroup('radiopi-srd-868', 'rtl_433 868.3 (SRD)', 868.08, 1024000, { freq: 868.3, rtl433: true }),
];

describe('decoding from a bookmark', () => {
	it('turns a decoder group into the decoder and its tuning', () => {
		expect(bookmarkDecode(BOOKMARKS, 'tpms')).toEqual({
			decoder: 'rtl433',
			options: { freq: 433.92, center: 433.7, rate: 1024000, protocols: '88' },
		});
		expect(bookmarkDecode(BOOKMARKS, 'radiopi-adsb-1090')).toEqual({
			decoder: 'adsb',
			options: { freq: 1090, center: 1090, rate: 2400000 },
		});
	});

	it('refuses a bookmark that is only for listening', () => {
		expect(() => bookmarkDecode(BOOKMARKS, 'FM 100.6')).toThrow(/no decoder/);
	});

	it('refuses a query that matches more than one bookmark', () => {
		expect(() => bookmarkDecode(BOOKMARKS, 'rtl_433')).toThrow(/radiopi-tpms-433\.92.*radiopi-srd-868/);
	});

	it('refuses a query that matches nothing', () => {
		expect(() => bookmarkDecode(BOOKMARKS, 'ais')).toThrow(/No bookmark/);
	});
});

describe('bookmark listing', () => {
	it('shows id, frequency and what the bookmark runs', () => {
		expect(describeBookmark(BOOKMARKS[0])).toEqual({ id: 'radiopi-fm-100.6', name: 'FM 100.6', freq_mhz: 100.6, use: 'wfm' });
		expect(describeBookmark(BOOKMARKS[2])).toEqual({
			id: 'radiopi-tpms-433.92',
			name: 'rtl_433 433.92 (TPMS)',
			freq_mhz: 433.92,
			use: 'decode rtl433',
		});
	});
});

describe('station Meteor bookmarks', () => {
	it('decodes Meteor LRPT from the station file', async () => {
		const { STATION_BOOKMARKS } = await import('@/app/workspace/station-bookmarks');
		expect(bookmarkDecode(STATION_BOOKMARKS, 'radiopi-meteor-lrpt')).toEqual({
			decoder: 'meteor',
			options: { freq: 137.9, center: 137.75, rate: 1024000 },
		});
		expect(bookmarkDecode(STATION_BOOKMARKS, 'radiopi-meteor-lrpt-backup').options.freq).toBe(137.1);
	});
});
