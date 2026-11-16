import type { AppInstance } from '@/app/core/receiver.types';
import type { Bookmark } from '@/app/workspace/types';
import { makeDefaultVfo } from '@/app/core/constants';
import { applyGroupBookmark } from '@/app/workspace/bookmarks';
import { fetchRelayRole } from '@/devices/rtltcp/relay-control';

export const METEOR_FREQ_MHZ = 137.9;
/** The Pi's address on the cable link; any other relay address means the page came over Wi-Fi. */
const CABLE_HOST = '192.168.250.2';
const REFUSED = 'Another client controls the dongle; Meteor cannot retune it.';

/** Over the Pi's Wi-Fi only the lowest RTL rate fits (about 4 Mbit/s); the cable takes 1.024 MS/s. */
function meteorTuning(relayUrl: string | null, freq: number): { centerFreq: number; sampleRate: number } {
	const relayHost = relayUrl ? new URL(relayUrl).hostname : null;
	const pageHost = globalThis.location?.hostname;
	const wifi = !!relayHost && relayHost === pageHost && relayHost !== CABLE_HOST;
	// The channel stays clear of the DC spike: 150 kHz below at 1.024 MS/s, 40 kHz below at 250 kS/s.
	return wifi
		? { centerFreq: +(freq - 0.04).toFixed(3), sampleRate: 250000 }
		: { centerFreq: +(freq - 0.15).toFixed(3), sampleRate: 1024000 };
}

/**
 * Sets VFO 1 on the Meteor downlink with the decoder on. Refuses when the Pi relay says another client
 * holds the dongle: this client's commands would be ignored, and taking control is the user's call.
 * Returns the refusal or warning to show, or '' when it tuned cleanly.
 */
export async function tuneForMeteor(receiver: AppInstance, freq = METEOR_FREQ_MHZ): Promise<string> {
	const relay = (await receiver.backend?.relayConnection?.()) ?? null;
	const role = relay ? await fetchRelayRole(relay.url, relay.token) : 'controller';
	if (role === 'listener' || role === 'absent') return REFUSED;
	const tuning = meteorTuning(relay?.url ?? null, freq);
	const bookmark: Bookmark = {
		type: 'group',
		name: 'Meteor-M LRPT',
		centerFreq: tuning.centerFreq,
		sampleRate: tuning.sampleRate,
		vfos: [{ ...makeDefaultVfo(freq), mode: 'nfm', bandwidth: 150000, meteor: true }],
		activeVfoIndex: 0,
	};
	await applyGroupBookmark.call(receiver, bookmark);
	// The demodulated QPSK is noise to the ear: keep decoding, mute the audio.
	if (receiver.vfos[0]) receiver.vfos[0].enabled = false;
	receiver.updateBackendVfoParams?.(0);
	return role === 'unknown' ? 'Tuned, but the relay could not confirm this client controls the dongle.' : '';
}
