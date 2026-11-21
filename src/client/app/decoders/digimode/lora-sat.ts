import { toRaw } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import type { Vfo } from '@/app/core/types';
import { isLoraSat, loraSatBandFor } from '@/worker/decoders/digimode/lora-sat/catalog';
import { fskSummary, loraConfigSummary, parseTinygsModem } from '@/worker/decoders/digimode/lora-sat/tinygs';
import type { LoraSatParams } from '@/worker/decoders/digimode/lora-sat/types';

/**
 * The LoRa satellite decoder's VFO parameters as plain objects (Vue proxies do not clone): the pasted TinyGS
 * configuration, and the satellite and Doppler of the Satellites tool when it decodes a pass on this VFO.
 */
export function loraSatParams(receiver: AppInstance, vfo: Vfo, index: number): LoraSatParams | undefined {
	if (!isLoraSat(vfo.digimode)) return undefined;
	const params: LoraSatParams = {};
	if (vfo.loraSatConfig) params.config = { ...toRaw(vfo.loraSatConfig) };
	const tracking = receiver.satellites.tracking;
	if (tracking?.decode && tracking.vfoIndex === index && toRaw(receiver.vfos[index]) === toRaw(vfo)) {
		if (tracking.satellite) params.satellite = { ...toRaw(tracking.satellite) };
		if (tracking.hint) params.hint = { ...toRaw(tracking.hint) };
	}
	return params;
}

/** A configuration is kept only on the entry of its bandwidth. */
export function keepLoraSatConfig(vfo: Vfo): void {
	if (vfo.loraSatConfig && loraSatBandFor(vfo.loraSatConfig.bwHz).id !== vfo.digimode) vfo.loraSatConfig = undefined;
}

export const loraSatMethods = {
	/**
	 * Reads a TinyGS modem configuration for a VFO: LoRa switches it to the entry of the bandwidth, runs the settings
	 * exactly and tunes the configuration's frequency. Returns what happened, for the panel.
	 */
	applyLoraSatConfig(this: AppInstance, index: number, json: string): string {
		const vfo = this.vfos[index];
		if (!vfo) return 'Choose a VFO first.';
		const modem = parseTinygsModem(json.trim());
		if (modem.kind === 'error') return modem.message;
		if (modem.kind === 'fsk') return fskSummary(modem.fsk);
		const config = modem.config;
		const band = loraSatBandFor(config.bwHz);
		vfo.digimode = band.id;
		vfo.loraSatConfig = config;
		this.digimodes.status[index] = null;
		this.updateBackendVfoParams(index);
		if (vfo.freq !== config.freqMHz) this.validateAndApplyVfoFreq(index, config.freqMHz);
		return `Decoding with ${loraConfigSummary(config)}.`;
	},
	/** Back to the blind search on the VFO's entry. */
	clearLoraSatConfig(this: AppInstance, index: number): void {
		const vfo = this.vfos[index];
		if (!vfo?.loraSatConfig) return;
		vfo.loraSatConfig = undefined;
		this.digimodes.status[index] = null;
		this.updateBackendVfoParams(index);
	},
};
