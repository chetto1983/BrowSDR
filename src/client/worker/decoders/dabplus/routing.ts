import type { Backend } from '@/worker/runtime/backend';
import type { DabCallback } from '@/worker/runtime/callbacks.types';
import type { DabMessage } from './types';

const callbacks = new WeakMap<Backend, DabCallback>();

/** The app's handler for DAB+ status (ensemble, services, now playing). */
export function setDabCallback(this: Backend, callback: DabCallback | null): void {
	if (callback) callbacks.set(this, callback);
	else callbacks.delete(this);
}

/** Delivers a worker's DAB+ status while that worker still serves a DAB VFO on the same frequency. */
export function routeDab(backend: Backend, worker: Worker, message: DabMessage): void {
	const index = backend.dspWorkers?.indexOf(worker) ?? -1;
	const params = backend.vfoParams?.[index];
	if (index < 0 || params?.mode !== 'dab' || params.freq !== message.freq) return;
	callbacks.get(backend)?.(index, params.freq, message);
}
