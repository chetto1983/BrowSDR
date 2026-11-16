import type { DigimodeInfo } from './types';

/** Decoders of the Digital Modes panel. Each is ported from OnAir (see third_party/onair). */
export const DIGIMODES: readonly DigimodeInfo[] = [
	{
		id: 'dsc-vhf',
		label: 'DSC (VHF channel 70)',
		family: 'Maritime',
		description: 'Digital selective calling: distress, safety and routine calls between ships and coast stations (ITU-R M.493).',
		rate: 24000,
		bandwidth: 16000,
		presets: [{ label: 'Channel 70', freqMHz: 156.525 }],
		source: 'core/src/marine/marine_dsc.cpp, marine_dsp.cpp',
	},
	{
		id: 'ax25-sat',
		label: 'CubeSat AX.25 telemetry',
		family: 'Satellite',
		description:
			'AX.25 frames from amateur satellites: 1200 bd AFSK and 9600 / 4800 bd G3RUH FSK at once. Pair with Tools → Satellites for Doppler.',
		rate: 96000,
		bandwidth: 30000,
		presets: [{ label: 'ISS packet', freqMHz: 145.825 }],
		source: 'core/src/cubesat/cubesat_rx.cpp, core/include/dect2/packet/packet_demod.h',
	},
];

export const digimodeInfo = (id: string | undefined): DigimodeInfo | undefined => DIGIMODES.find((mode) => mode.id === id);
