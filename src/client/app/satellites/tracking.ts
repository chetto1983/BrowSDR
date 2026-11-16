import { toRaw } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import type { Vfo } from '@/app/core/types';
import type { Downlink, TrackedSatellite } from '@/satellites/types';
import { orbitState, receivedMHz, transmittedMHz } from '@/satellites/orbit';

const TICK_MS = 1000;
/** Smaller corrections wait for the next tick: 10 Hz is inaudible on SSB and keeps worker updates rare on FM. */
const MIN_STEP_MHZ = 10e-6;
const DECODERS = [
	'rds',
	'pocsag',
	'gsc',
	'flex',
	'adsb',
	'ais',
	'radiosonde',
	'rtk',
	'ble',
	'acars',
	'aprs',
	'tetra',
	'meteor',
	'rtl433',
] as const satisfies ReadonlyArray<keyof Vfo>;

const timers = new WeakMap<object, ReturnType<typeof setInterval>>();
/** The tracked VFO itself: its index shifts when an earlier VFO is removed, and a loaded bookmark replaces it. */
const trackedVfos = new WeakMap<object, object>();
const cleanupRegistered = new WeakSet<object>();

const round6 = (mhz: number) => Math.round(mhz * 1e6) / 1e6;

function setVfoFreq(receiver: AppInstance, index: number, freq: number): void {
	const vfo = receiver.vfos[index];
	vfo.freq = freq;
	// Leave the field alone while the user is typing a frequency into it.
	if (!vfo.focused) vfo.displayFreq = receiver.formatFreq(freq);
	receiver.updateBackendVfoParams(index);
}

/** Demodulator, filter and decoders for a downlink; other VFO settings stay as the user left them. */
function prepareVfo(receiver: AppInstance, index: number, downlink: Downlink): void {
	const vfo = receiver.vfos[index];
	for (const decoder of DECODERS) vfo[decoder] = false;
	vfo.aprs = downlink.decoder === 'aprs';
	vfo.digimode = '';
	vfo.mode = downlink.mode;
	receiver.applyModeDefaults(index);
	if (downlink.bandwidthHz) vfo.bandwidth = downlink.bandwidthHz;
}

/**
 * Puts the VFO on `freq`. With a single VFO the receiver is centred a little below it, clear of the DC spike
 * and with room for the Doppler swing; with more VFOs the usual fitting (or the conflict dialog) decides.
 */
function tuneVfo(receiver: AppInstance, index: number, freq: number): void {
	const centerLocked = receiver.remoteMode === 'client' && receiver.locks.centerFreq;
	if (receiver.vfos.length === 1 && !centerLocked) {
		const offset = Math.min(0.15, (receiver.radio.sampleRate / 1e6) * 0.15);
		receiver.radio.centerFreq = +(freq - offset).toFixed(3);
		setVfoFreq(receiver, index, freq);
	} else receiver.validateAndApplyVfoFreq(index, freq);
}

export function stopTracking(receiver: AppInstance, notice = ''): void {
	const key = toRaw(receiver);
	clearInterval(timers.get(key));
	timers.delete(key);
	trackedVfos.delete(key);
	receiver.satellites.tracking = null;
	if (notice) receiver.satellites.notice = notice;
}

/** One Doppler step: follow manual retuning, then move the VFO to where the downlink is heard now. */
export function trackingTick(receiver: AppInstance, now = new Date()): void {
	const tracking = receiver.satellites.tracking;
	if (!tracking || receiver._disposed) return stopTracking(receiver);
	const tracked = trackedVfos.get(toRaw(receiver));
	tracking.vfoIndex = receiver.vfos.findIndex((item) => toRaw(item) === tracked);
	const vfo = receiver.vfos[tracking.vfoIndex];
	const tle = receiver.satellites.tles.find((item) => item.norad === tracking.norad);
	const look = tle && receiver.station ? orbitState(tle, receiver.station, now)?.look : null;
	if (!vfo || !look) return stopTracking(receiver, 'Doppler tracking stopped: the VFO or the orbit is gone.');
	if (Math.abs(vfo.freq - tracking.lastMHz) > 0.5e-6) tracking.baseMHz = round6(transmittedMHz(vfo.freq, look.rangeRateKmS));
	const freq = round6(receivedMHz(tracking.baseMHz, look.rangeRateKmS));
	tracking.dopplerHz = Math.round((freq - tracking.baseMHz) * 1e6);
	if (Math.abs(freq - vfo.freq) < MIN_STEP_MHZ) {
		tracking.lastMHz = vfo.freq;
		return;
	}
	if (!receiver.isFreqInBandwidth(freq))
		return stopTracking(receiver, `Doppler tracking stopped: VFO ${tracking.vfoIndex + 1} left the received band.`);
	setVfoFreq(receiver, tracking.vfoIndex, freq);
	tracking.lastMHz = freq;
}

/**
 * Tunes a VFO to a satellite downlink and, for voice and transponder downlinks, keeps correcting Doppler every
 * second until stopped. Returns the notice to show ('' when tracking started cleanly).
 */
export function startTracking(receiver: AppInstance, satellite: TrackedSatellite, downlinkIndex: number, vfoIndex: number): string {
	stopTracking(receiver);
	const downlink = satellite.downlinks[downlinkIndex];
	if (!downlink || !receiver.vfos[vfoIndex]) return 'Choose a downlink and a VFO.';
	const tle = receiver.satellites.tles.find((item) => item.norad === satellite.norad);
	const look = tle && receiver.station ? orbitState(tle, receiver.station, new Date())?.look : null;
	const doppler = !downlink.decoder && !!look;
	const freq = doppler && look ? round6(receivedMHz(downlink.freqMHz, look.rangeRateKmS)) : downlink.freqMHz;
	prepareVfo(receiver, vfoIndex, downlink);
	tuneVfo(receiver, vfoIndex, freq);
	receiver.vfos[vfoIndex].enabled = true;
	receiver.toggleVfoCheckbox(vfoIndex);
	if (downlink.decoder === 'aprs')
		return `APRS decoding on VFO ${vfoIndex + 1} (Tools → APRS). Not Doppler-corrected: the decoder restarts on every retune, and ±3.5 kHz fits its channel.`;
	if (!look) return 'Set the station location for Doppler correction; tuned to the nominal downlink.';
	if (receiver.vfos[vfoIndex].freq !== freq) return 'Fit the VFOs in the dialog, then press Track again.';
	receiver.satellites.tracking = {
		norad: satellite.norad,
		downlink: downlinkIndex,
		vfoIndex,
		baseMHz: downlink.freqMHz,
		lastMHz: freq,
		dopplerHz: Math.round((freq - downlink.freqMHz) * 1e6),
	};
	const key = toRaw(receiver);
	trackedVfos.set(key, toRaw(receiver.vfos[vfoIndex]));
	timers.set(
		key,
		setInterval(() => trackingTick(receiver), TICK_MS),
	);
	if (!cleanupRegistered.has(key)) {
		cleanupRegistered.add(key);
		receiver._cleanup?.push(() => stopTracking(receiver));
	}
	return '';
}
