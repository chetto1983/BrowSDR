import type { Backend } from '@/worker/runtime/backend';
import type { HostCallback, TetraCallback } from '@/worker/runtime/callbacks.types';
import type { DspOutput } from '@/worker/runtime/dsp-messages.types';
import type { RemoteClientState } from '@/worker/runtime/types';

export function setRemoteHostTetraCallback(this: Backend, callback: HostCallback<Parameters<TetraCallback>>): void {
	this._remoteHostTetraCb = callback;
}

/** Forward a remote client's TETRA telemetry while its VFO still decodes the reported carrier. */
export function forwardTetra(backend: Backend, clientId: string, state: RemoteClientState, index: number, msg: DspOutput): boolean {
	if (msg.type !== 'tetra') return false;
	const params = state.params[index];
	if (params?.tetra && params.freq === msg.freq) backend._remoteHostTetraCb?.(clientId, index, params.freq, msg);
	return true;
}
