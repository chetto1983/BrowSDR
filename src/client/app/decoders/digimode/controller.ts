import { toRaw } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import type { DigimodeMessage, DigimodeStatus } from '@/worker/decoders/digimode/types';
import { digimodeInfo } from '@/worker/decoders/digimode/catalog';
import { mergeHfdlPositions } from '@/app/decoders/adsb/hfdl';
import { readApplication } from './application';
import { DigimodePicture } from './image';
import type { DigimodeLogEntry } from './types';

const LOG_LIMIT = 500;

/** Pictures live outside Vue's reactivity; `digimodes.imageVersion` signals changes. */
const pictures = new WeakMap<object, DigimodePicture[]>();

export function digimodePicture(receiver: AppInstance, index: number): DigimodePicture {
	const key = toRaw(receiver);
	const list = pictures.get(key) ?? [];
	pictures.set(key, list);
	return (list[index] ??= new DigimodePicture());
}

export function digimodePanelState() {
	return {
		panelOpen: false,
		status: [] as Array<DigimodeStatus | null>,
		/** Newest first. */
		log: [] as DigimodeLogEntry[],
		imageVersion: 0,
	};
}

export const digimodeMethods = {
	toggleDigimodePanel(this: AppInstance): void {
		this.digimodes.panelOpen = !this.digimodes.panelOpen;
	},
	_onDigimodeMessage(this: AppInstance, index: number, freq: number, message: DigimodeMessage): void {
		const vfo = this.vfos[index];
		if (!vfo?.digimode || vfo.digimode !== message.mode || vfo.freq !== freq || message.freq !== freq) return;
		this.digimodes.status[index] = message.status;
		if (message.records.length) {
			const entries = message.records.map((record) => ({ ...readApplication(record), vfo: index, freq })).reverse();
			this.digimodes.log = [...entries, ...this.digimodes.log].slice(0, LOG_LIMIT);
		}
		// HFDL aircraft positions go to the ADS-B tool's aircraft map
		if (message.mode === 'hfdl' && message.records.some((record) => record.position))
			this.adsb.hfdl = mergeHfdlPositions(this.adsb.hfdl, message.records, Date.now());
		if (message.image) {
			digimodePicture(this, index).append(message.image);
			this.digimodes.imageVersion++;
		}
	},
	digimodeStatusText(this: AppInstance, index: number): string {
		if (!this.running) return 'Start reception to decode';
		const status = this.digimodes.status[index];
		if (!status) return 'Starting decoder…';
		return status.state === 'receiving' ? `${status.message} · ${status.records} decoded` : status.message;
	},
	/** Chooses the Digital Modes decoder of a VFO ('' = off). */
	setVfoDigimode(this: AppInstance, index: number, mode: string): void {
		const vfo = this.vfos[index];
		if (!vfo) return;
		vfo.digimode = digimodeInfo(mode) ? mode : '';
		this.digimodes.status[index] = null;
		this.updateBackendVfoParams(index);
	},
	tuneDigimodeVfo(this: AppInstance, frequency: number, index = this.activeVfoIndex): void {
		if (this.vfos[index]) this.validateAndApplyVfoFreq(index, frequency);
	},
	clearDigimodeLog(this: AppInstance): void {
		this.digimodes.log = [];
	},
};
