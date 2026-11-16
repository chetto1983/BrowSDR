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
		id: 'navtex',
		label: 'NAVTEX',
		family: 'Maritime',
		description:
			'Maritime safety broadcasts (ITU-R M.540): navigational and gale warnings, forecasts, search and rescue. SITOR-B, 100 bd FSK ±85 Hz. Tune the VFO to the assigned frequency itself, the centre between the tones (not 1 kHz below as for a USB receiver); tones within ±600 Hz of it are found. Needs LF/MF/HF reception, e.g. an RTL-SDR in direct sampling mode or behind an upconverter.',
		rate: 24000,
		bandwidth: 8000,
		presets: [
			{ label: '518 kHz international', freqMHz: 0.518 },
			{ label: '490 kHz national', freqMHz: 0.49 },
			{ label: '4209.5 kHz HF', freqMHz: 4.2095 },
		],
		source: 'core/src/marine/marine_navtex.cpp, marine_dsp.cpp, marine_rx.cpp',
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
	{
		id: 'sstv-fm',
		label: 'SSTV (FM, ISS)',
		family: 'Satellite',
		description:
			'Slow-scan TV pictures through an FM receiver, as the ISS sends them during ARISS events: Robot, Martin, Scottie, PD and Wraase modes.',
		rate: 24000,
		bandwidth: 16000,
		presets: [{ label: 'ISS SSTV', freqMHz: 145.8 }],
		image: true,
		source: 'core/src/hfdig/hfdig_sstv.cpp, hfdig_sstv_modes.h',
	},
	{
		id: 'sstv-usb',
		label: 'SSTV (USB, HF)',
		family: 'Amateur',
		description: 'Slow-scan TV pictures in the upper sideband, as on the HF SSTV calling frequencies. Tune the VFO to the dial frequency.',
		rate: 8000,
		bandwidth: 3200,
		offsetHz: 1700,
		presets: [
			{ label: '20 m', freqMHz: 14.23 },
			{ label: '40 m', freqMHz: 7.171 },
			{ label: '80 m', freqMHz: 3.735 },
		],
		image: true,
		source: 'core/src/hfdig/hfdig_sstv.cpp, hfdig_sstv_modes.h',
	},
	{
		id: 'vdl2',
		label: 'VDL Mode 2',
		family: 'Aviation',
		description:
			'VHF data link between aircraft and ground stations: D8PSK bursts at 10.5 ksymbol/s carrying AVLC frames with ACARS messages, ATN packets and link management (ICAO Annex 10, Doc 9776).',
		rate: 84000,
		bandwidth: 25000,
		presets: [
			{ label: '136.975 (CSC)', freqMHz: 136.975 },
			{ label: '136.900', freqMHz: 136.9 },
			{ label: '136.875', freqMHz: 136.875 },
			{ label: '136.850', freqMHz: 136.85 },
			{ label: '136.825', freqMHz: 136.825 },
			{ label: '136.775', freqMHz: 136.775 },
			{ label: '136.725', freqMHz: 136.725 },
			{ label: '136.675', freqMHz: 136.675 },
		],
		source: 'core/src/vdl2/vdl2_rx.cpp, vdl2_proto.cpp, rust/onair_vdl2',
	},
	{
		id: 'tones',
		label: 'Tone signalling (CTCSS, DCS, DTMF, selcall)',
		family: 'Two-way radio',
		description:
			'Sub-audible CTCSS tones and DCS codes (normal and inverted), DTMF digits, five-tone selcall (ZVEI, CCIR, EEA, EIA, DZVEI), SELCAL and two-tone pages on an FM voice channel. The status line shows what is on the channel now; the record follows when the tone, code, key group or call ends.',
		rate: 16000,
		bandwidth: 12500,
		presets: [
			{ label: 'PMR446 channel 1', freqMHz: 446.00625 },
			{ label: '2 m FM calling (Region 1)', freqMHz: 145.5 },
		],
		source: 'core/src/tones/tones_rx.cpp, tones_proto.cpp',
	},
];

export const digimodeInfo = (id: string | undefined): DigimodeInfo | undefined => DIGIMODES.find((mode) => mode.id === id);
