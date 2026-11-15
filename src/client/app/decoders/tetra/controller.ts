import type { AppInstance } from '@/app/core/receiver.types';
import type { TetraMessage } from '@/worker/decoders/tetra/types';

export const tetraMethods = {
	toggleTetraPanel(this: AppInstance): void {
		this.tetra.panelOpen = !this.tetra.panelOpen;
	},
	_onTetraMessage(this: AppInstance, index: number, freq: number, message: TetraMessage): void {
		const vfo = this.vfos[index];
		if (!this.running || !vfo?.tetra || vfo.freq !== freq || message.freq !== freq) return;
		this.tetra.status[index] = message.status;
		this.tetra.sources[index] = { freq, cells: message.cells };
	},
	tetraStatusText(this: AppInstance, index: number): string {
		if (!this.running) return 'Start reception to decode';
		const status = this.tetra.sources[index]?.freq === this.vfos[index]?.freq ? this.tetra.status[index] : null;
		if (!status) return 'Starting decoder…';
		if (status.state !== 'receiving') return status.message;
		const signal = status.quality > 0 ? ` · quality ${status.quality.toFixed(2)} · offset ${Math.round(status.freqOffsetHz)} Hz` : '';
		return `${status.message} · ${status.frames}/${status.bursts} sync bursts decoded${signal}`;
	},
};
