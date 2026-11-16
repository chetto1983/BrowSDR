import { transfer } from 'comlink';
import type { Backend } from '@/worker/runtime/backend';
import type { DigimodeCallback } from '@/worker/runtime/callbacks.types';
import type { DigimodeMessage } from './types';

const callbacks = new WeakMap<Backend, DigimodeCallback>();

/** The app's handler for Digital Modes output (status, new records, picture rows). */
export function setDigimodeCallback(this: Backend, callback: DigimodeCallback | null): void {
	if (callback) callbacks.set(this, callback);
	else callbacks.delete(this);
}

/** Delivers a worker's message while that worker still runs the same mode on the same frequency. */
export function routeDigimode(backend: Backend, worker: Worker, message: DigimodeMessage): void {
	const index = backend.dspWorkers?.indexOf(worker) ?? -1;
	const params = backend.vfoParams?.[index];
	if (index < 0 || !params?.digimode || params.digimode !== message.mode || params.freq !== message.freq) return;
	const buffer = message.image?.rgb.buffer as ArrayBuffer | undefined;
	callbacks.get(backend)?.(index, params.freq, buffer ? transfer(message, [buffer]) : message);
}
