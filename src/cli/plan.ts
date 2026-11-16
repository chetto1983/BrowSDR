import { makeDefaultVfo } from '@/app/core/constants';
import type { VfoParams } from '@/worker/runtime/types';
import type { DecodeOptions, DecodePlan, DecoderName, DecoderProfile, RelayStatus } from './types';

const MAX_GAIN_INDEX = 28;

/** A muted narrow VFO built from the app's own defaults, with one decoder switched on. */
function decoderVfo(freq: number, decoder: Partial<VfoParams>): VfoParams {
	return { ...makeDefaultVfo(freq), mode: 'nfm', bandwidth: 12500, deEmphasis: 'none', enabled: false, ...decoder };
}

const PROFILES: Record<DecoderName, DecoderProfile> = {
	adsb: {
		freqMHz: 1090,
		sampleRate: 2400000,
		centerOffsetMHz: 0,
		halfBandHz: 1e6,
		minSampleRate: 2e6,
		params: (freq) => decoderVfo(freq, { adsb: true }),
	},
	rtl433: {
		freqMHz: 433.92,
		sampleRate: 1024000,
		centerOffsetMHz: -0.22,
		halfBandHz: 100e3,
		minSampleRate: 250e3,
		params: (freq, options) => decoderVfo(freq, { rtl433: true, rtl433Protocols: options.protocols }),
	},
	radiosonde: {
		// RS41 4800-baud FSK; the decoder runs its own 48 kHz channel.
		freqMHz: 403,
		sampleRate: 1024000,
		centerOffsetMHz: -0.2,
		halfBandHz: 24e3,
		minSampleRate: 1e6,
		params: (freq) => decoderVfo(freq, { radiosonde: true }),
	},
	meteor: {
		// LRPT 72k QPSK is about 120 kHz wide; the decoder runs a 150 kHz channel at 144 kS/s.
		freqMHz: 137.9,
		sampleRate: 1024000,
		centerOffsetMHz: -0.15,
		halfBandHz: 75e3,
		minSampleRate: 250e3,
		params: (freq) => decoderVfo(freq, { meteor: true, bandwidth: 150000 }),
	},
};

/** Accepts host:port, ws(s):// or http(s):// and returns the relay's WebSocket and status URLs. */
export function relayEndpoints(relay: string): { ws: string; status: string } {
	const text = relay.trim();
	const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `ws://${text}`);
	const secure = url.protocol === 'wss:' || url.protocol === 'https:';
	const host = url.host;
	return { ws: `${secure ? 'wss' : 'ws'}://${host}/`, status: `${secure ? 'https' : 'http'}://${host}/status` };
}

/**
 * Decides how to decode without stepping on another client: tune only when the dongle is free or
 * when --take is given; otherwise decode inside the band the current controller chose.
 */
export function planDecode(decoder: DecoderName, options: DecodeOptions, status: RelayStatus): DecodePlan {
	const profile = PROFILES[decoder];
	const freqMHz = options.freq ?? profile.freqMHz;
	const params = profile.params(freqMHz, options);
	const take = options.take === true;
	if (take || status.clients.length === 0) {
		return {
			decoder,
			role: 'controller',
			take,
			freqMHz,
			centerMHz: options.center ?? freqMHz + profile.centerOffsetMHz,
			sampleRate: options.rate ?? profile.sampleRate,
			gainIndex: options.gain ?? MAX_GAIN_INDEX,
			params,
		};
	}
	const centerMHz = status.state.frequency_hz / 1e6;
	const sampleRate = status.state.sample_rate;
	const band = `${centerMHz.toFixed(3)} MHz at ${(sampleRate / 1e6).toFixed(3)} MS/s`;
	if (sampleRate < profile.minSampleRate) {
		throw new Error(
			`Another client holds the dongle at ${band}; ${decoder} needs at least ${profile.minSampleRate / 1e6} MS/s. Use --take to retune it (this moves the other client too).`,
		);
	}
	if (Math.abs(freqMHz - centerMHz) * 1e6 + profile.halfBandHz > sampleRate / 2) {
		throw new Error(
			`Another client holds the dongle at ${band}; ${freqMHz} MHz is outside that band. Use --take to retune it (this moves the other client too).`,
		);
	}
	return { decoder, role: 'listener', take: false, freqMHz, centerMHz, sampleRate, gainIndex: status.state.gain_index, params };
}

/**
 * During a run: returns why decoding must stop, or null. A listener stops when the controller retunes
 * (its records would come from a band it did not ask for); a controller stops when it lost control.
 */
export function bandChange(plan: DecodePlan, status: RelayStatus, ownToken?: string): string | null {
	if (plan.role === 'controller') {
		// Without our token, or on a relay too old to report tokens, control cannot be checked.
		if (ownToken === undefined || !status.clients.some((client) => client.client)) return null;
		const controller = status.clients.find((client) => client.controller);
		return controller?.client === ownToken
			? null
			: `Another client took control of the dongle (client ${controller?.id ?? 'none'}); stopping.`;
	}
	const { frequency_hz: frequencyHz, sample_rate: sampleRate } = status.state;
	if (frequencyHz === Math.round(plan.centerMHz * 1e6) && sampleRate === plan.sampleRate) return null;
	return `The controller retuned the dongle to ${(frequencyHz / 1e6).toFixed(3)} MHz at ${(sampleRate / 1e6).toFixed(3)} MS/s; stopping so no records come from the wrong band.`;
}
