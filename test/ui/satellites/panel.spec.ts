import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ReceiverView } from '../helpers/receiver-view';
import { makeDefaultVfo } from '@/app/core/constants';
import { orbitState, receivedMHz } from '@/satellites/orbit';
import { parseTle } from '@/satellites/tle';
import { AMATEUR_TLE, METEOR_TLE, SITE } from '../../satellites/fixtures.js';

vi.mock('leaflet', () => ({}));
vi.mock('@/app/satellites/map', () => ({
	SatelliteMap: vi.fn().mockImplementation(() => ({
		update: vi.fn(),
		setSelection: vi.fn(),
		setStation: vi.fn(),
		focus: vi.fn(),
		resize: vi.fn(),
		destroy: vi.fn(),
	})),
}));

const TLES = parseTle(AMATEUR_TLE + METEOR_TLE);
/** Mid-pass of SO-50 over Caraglio (peak 76° at 22:51 UTC). */
const DURING_SO50 = new Date('2026-11-16T22:51:00Z');

function celestrak() {
	const blocks = (AMATEUR_TLE + METEOR_TLE).trim().split('\n');
	return vi.fn(async (url: string) => {
		const norad = Number(new URL(url).searchParams.get('CATNR'));
		const at = blocks.findIndex((line) => line.startsWith('1 ') && Number(line.slice(2, 7)) === norad);
		return new Response(blocks.slice(at - 1, at + 2).join('\n'));
	});
}

const heardNow = (norad: number, freqMHz: number) => {
	const tle = TLES.find((item) => item.norad === norad)!;
	return receivedMHz(freqMHz, orbitState(tle, SITE, new Date())!.look!.rangeRateKmS);
};

let wrapper: VueWrapper;
let play: ReturnType<typeof vi.spyOn>;
async function openPanel(extra: Record<string, unknown> = {}) {
	wrapper = mount(ReceiverView);
	await wrapper.setData({
		running: true,
		backend: { setVfoParams: vi.fn() },
		vfos: [makeDefaultVfo(100)],
		station: SITE,
		...extra,
	});
	wrapper.vm.toggleSatellitesPanel();
	await flushPromises();
	return wrapper;
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
	vi.setSystemTime(DURING_SO50);
	vi.stubGlobal('fetch', celestrak());
	vi.stubGlobal(
		'AudioContext',
		vi.fn().mockImplementation(() => ({ state: 'running', destination: {}, createGain: () => ({ gain: { value: 1 }, connect: vi.fn() }) })),
	);
	play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
});
afterEach(() => {
	wrapper?.unmount();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
	play.mockRestore();
	localStorage.clear();
});

describe('Satellites panel', () => {
	it('lists every satellite with pointing and the next pass', async () => {
		await openPanel();
		expect(fetch).toHaveBeenCalledTimes(9);
		const text = wrapper.text();
		for (const name of ['ISS', 'SO-50', 'AO-123', 'RS-44', 'FO-29', 'AO-7', 'JO-97', 'Meteor-M2 3']) expect(text).toContain(name);
		// SO-50 is up, high in the west.
		const so50 = wrapper.findAll('tbody tr').find((row) => row.text().startsWith('SO-50'))!;
		expect(so50.text()).toMatch(/27\d° W · 7\d°/);
		expect(so50.text()).toContain('now');
		expect(so50.classes()).toContain('satellite-up');
	});
	it('asks for the station before predicting passes', async () => {
		await openPanel({ station: null });
		expect(wrapper.text()).toContain('Set the station location for passes, pointing and Doppler.');
	});
	it('tunes a VFO with Doppler correction and follows the pass', async () => {
		await openPanel();
		wrapper.vm.satelliteSelect(27607);
		await wrapper.vm.$nextTick();
		await wrapper
			.findAll('button')
			.find((button) => button.text() === 'Track on VFO 1')!
			.trigger('click');
		const vfo = wrapper.vm.vfos[0];
		expect(vfo).toMatchObject({ mode: 'nfm', bandwidth: 12500, enabled: true });
		// Approaching at 0.89 km/s: 436.795 MHz is heard 1.3 kHz high.
		expect(Math.abs(vfo.freq - heardNow(27607, 436.795)) * 1e6).toBeLessThan(1);
		expect((vfo.freq - 436.795) * 1e6).toBeCloseTo(1295, -1);
		expect(wrapper.vm.radio.centerFreq).toBe(+(vfo.freq - 0.15).toFixed(3));
		expect(wrapper.vm.satellites.tracking).toMatchObject({ norad: 27607, vfoIndex: 0 });

		vi.advanceTimersByTime(4 * 60_000);
		// After the peak the satellite recedes: the downlink falls below 436.795.
		expect(Math.abs(wrapper.vm.vfos[0].freq - heardNow(27607, 436.795)) * 1e6).toBeLessThan(15);
		expect(wrapper.vm.vfos[0].freq).toBeLessThan(436.795);
		await wrapper.vm.$nextTick();
		expect(wrapper.text()).toMatch(/Tracking SO-50 FM repeater on VFO 1 · 436\.78\d\d MHz · Doppler −9\.\d kHz/);
	});
	it('keeps a manual retune and tracks from there', async () => {
		await openPanel();
		await wrapper.vm.satelliteTrack(44909, 0);
		expect(wrapper.vm.vfos[0]).toMatchObject({ mode: 'usb', bandwidth: 2800 });
		// The user moves to a QSO 12 kHz below the middle of the RS-44 passband.
		wrapper.vm.vfos[0].freq = +(wrapper.vm.vfos[0].freq - 0.012).toFixed(6);
		vi.advanceTimersByTime(1000);
		expect(wrapper.vm.satellites.tracking.baseMHz).toBeCloseTo(435.628, 4);
		vi.advanceTimersByTime(60_000);
		expect(Math.abs(wrapper.vm.vfos[0].freq - heardNow(44909, wrapper.vm.satellites.tracking.baseMHz)) * 1e6).toBeLessThan(15);
	});
	it('stops tracking on request', async () => {
		await openPanel();
		await wrapper.vm.satelliteTrack(27607, 0);
		await wrapper.vm.$nextTick();
		await wrapper
			.findAll('button')
			.find((button) => button.text() === 'Stop')!
			.trigger('click');
		expect(wrapper.vm.satellites.tracking).toBeNull();
		const freq = wrapper.vm.vfos[0].freq;
		vi.advanceTimersByTime(10_000);
		expect(wrapper.vm.vfos[0].freq).toBe(freq);
	});
	it('follows the tracked VFO when an earlier one is removed, and stops when it goes', async () => {
		await openPanel({ vfos: [makeDefaultVfo(100), makeDefaultVfo(101)], activeVfoIndex: 1 });
		await wrapper.vm.satelliteTrack(27607, 0);
		const tracked = wrapper.vm.vfos[1];
		wrapper.vm.vfos.splice(0, 1);
		vi.advanceTimersByTime(30_000);
		expect(wrapper.vm.satellites.tracking.vfoIndex).toBe(0);
		expect(Math.abs(tracked.freq - heardNow(27607, 436.795)) * 1e6).toBeLessThan(15);
		wrapper.vm.vfos.splice(0, 1, makeDefaultVfo(100));
		vi.advanceTimersByTime(1000);
		expect(wrapper.vm.satellites.tracking).toBeNull();
		expect(wrapper.vm.satellites.notice).toContain('Doppler tracking stopped');
	});
	it('hands ISS SSTV to the Digital Modes decoder', async () => {
		await openPanel();
		await wrapper.vm.satelliteTrack(25544, 3);
		expect(wrapper.vm.vfos[0]).toMatchObject({ freq: 145.8, mode: 'nfm', digimode: 'sstv-fm', aprs: false });
		expect(wrapper.vm.satellites.tracking).toBeNull();
		expect(wrapper.vm.satellites.notice).toContain('SSTV pictures decoding on VFO 1');
	});
	it('decodes the ISS APRS digipeater without retuning it', async () => {
		await openPanel({ vfos: [{ ...makeDefaultVfo(137.9), meteor: true }] });
		await wrapper.vm.satelliteTrack(25544, 2);
		expect(wrapper.vm.vfos[0]).toMatchObject({ freq: 145.825, mode: 'nfm', aprs: true, meteor: false });
		expect(wrapper.vm.satellites.tracking).toBeNull();
		expect(wrapper.vm.satellites.notice).toContain('APRS decoding on VFO 1');
	});
});
