import type { AppInstance } from '@/app/core/receiver.types';
import type { DabMessage } from '@/worker/decoders/dabplus/types';

export const dabMethods = {
	/** Plays this service (SId) of the ensemble; 0 picks the first DAB+ service. */
	setDabService(this: AppInstance, index: number, sid: number): void {
		const vfo = this.vfos[index];
		if (!vfo) return;
		vfo.dabService = sid;
		this._resetAudioPlayback();
		this.updateBackendVfoParams(index);
	},
	/** Tunes the VFO to a Band III block, keeping the whole ensemble inside the received band. */
	tuneDabChannel(this: AppInstance, index: number, mhz: number): void {
		const vfo = this.vfos[index];
		if (!vfo) return;
		vfo.dabService = 0;
		this.dabStatus[index] = null;
		this.validateAndApplyVfoFreq(index, mhz);
	},
	_onDabMessage(this: AppInstance, index: number, frequency: number, message: DabMessage): void {
		const vfo = this.vfos[index];
		if (!vfo || vfo.mode !== 'dab' || vfo.freq !== frequency || message.freq !== frequency) return;
		this.dabStatus[index] = message.status;
	},
};
