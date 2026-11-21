import { loraSatBandFor } from '@/worker/decoders/digimode/lora-sat/catalog';
import { LORA_SAT_PRESETS, satnogsLora } from '@/worker/decoders/digimode/lora-sat/presets';
import type { Downlink, Tle, TrackedSatellite } from './types';

/** TinyGS's element file of the satellites it supports (https://api.tinygs.com/v1/tinygs_supported.txt), served by BrowSDR. */
export const TINYGS_TLE_URL = '/api/tinygs/tle';

const khz = (hz: number) => `${+(hz / 1000).toFixed(1)} kHz`;

/** The SatNOGS DB LoRa transmitters of a satellite as downlinks for the LoRa satellite decoder. */
function satnogsDownlinks(norad: number): Downlink[] {
	return satnogsLora(norad)
		.sort((a, b) => Number(b.alive) - Number(a.alive))
		.map((t) => ({
			label: `LoRa ${t.bwHz ? khz(t.bwHz) : '(bandwidth not listed)'} · SatNOGS: ${t.description}${t.alive ? '' : ' (inactive)'}`,
			freqMHz: t.freqMHz,
			mode: 'nfm' as const,
			digimode: loraSatBandFor(t.bwHz || 125000).id,
		}));
}

/** OnAir's presets for satellites whose name starts with the preset's element-file name (FOSSASAT, TIANQI, LACUNA). */
const onairPresets = (name: string) =>
	LORA_SAT_PRESETS.filter((p) => p.tleName && name.toUpperCase().startsWith(p.tleName) && !p.uplinkOnly);

function onairDownlinks(name: string, have: Downlink[]): Downlink[] {
	return onairPresets(name)
		.filter((p) => !have.some((d) => Math.abs(d.freqMHz - p.mhz) < 1e-6))
		.map((p) => ({
			label: `LoRa ${khz(p.bwHz)} · OnAir (${p.confidence}): ${p.name}`,
			freqMHz: p.mhz,
			mode: 'nfm' as const,
			digimode: loraSatBandFor(p.bwHz).id,
		}));
}

const NOTE =
	"In TinyGS's list. Frequencies from SatNOGS DB (CC BY-SA 4.0) and OnAir's list, none checked against a real signal; the decoder searches the spreading factor, sync word and IQ. Decode on VFO keeps the VFO on the frequency and sends the decoder the Doppler the orbit predicts.";
const NO_FREQUENCY =
	"In TinyGS's list, but no LoRa frequency is known here: SatNOGS DB lists none, and TinyGS keeps its settings in its own API. Paste a TinyGS station's modem configuration in Tools → Digital Modes to decode it.";

/**
 * TinyGS's satellites, one per NORAD number (the element file lists some twice, under two names, and shares orbits between
 * new satellites): names joined, satellites already tracked elsewhere left out. Their TLEs carry the joined names.
 */
export function tinygsSatellites(tles: readonly Tle[], skip: ReadonlySet<number>): { tles: Tle[]; satellites: TrackedSatellite[] } {
	const byNorad = new Map<number, { tle: Tle; names: string[] }>();
	for (const tle of tles) {
		if (skip.has(tle.norad) || !Number.isFinite(tle.norad)) continue;
		const entry = byNorad.get(tle.norad);
		const name = tle.name.trim();
		if (!entry) byNorad.set(tle.norad, { tle, names: [name] });
		else if (!entry.names.some((n) => name.startsWith(n))) entry.names.push(name);
	}
	const out = [...byNorad.values()].map(({ tle, names }) => {
		const name = names.join(' / ');
		const satnogs = satnogsDownlinks(tle.norad);
		const downlinks = [...satnogs, ...onairDownlinks(name, satnogs)];
		// OnAir's own notes on its presets say how sure they are
		const onair = [...new Set(onairPresets(name).map((p) => `${p.name} (${p.confidence}): ${p.note}`))];
		const note = downlinks.length ? [NOTE, ...onair.map((n) => `OnAir: ${n}`)].join(' ') : NO_FREQUENCY;
		const satellite: TrackedSatellite = { name, norad: tle.norad, downlinks, note };
		return { tle: { ...tle, name }, satellite };
	});
	return { tles: out.map((item) => item.tle), satellites: out.map((item) => item.satellite) };
}
