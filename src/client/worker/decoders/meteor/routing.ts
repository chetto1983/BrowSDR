import { transfer } from 'comlink';
import type { Backend } from '@/worker/runtime/backend';
import type { MeteorCallback } from '@/worker/runtime/callbacks.types';
import type { MeteorMessage } from './types';

const callbacks = new WeakMap<Backend, MeteorCallback>();

/** The app's handler for Meteor decoder output (status and new image rows). */
export function setMeteorCallback(this: Backend, callback: MeteorCallback | null): void {
	if (callback) callbacks.set(this, callback);
	else callbacks.delete(this);
}

/** Delivers a worker's Meteor message while that worker still serves a Meteor VFO on the same frequency. */
export function routeMeteor(backend: Backend, worker: Worker, message: MeteorMessage): void {
	const index = backend.dspWorkers?.indexOf(worker) ?? -1;
	const params = backend.vfoParams?.[index];
	if (index < 0 || !params?.meteor || params.freq !== message.freq) return;
	const buffers = message.rows ? message.rows.channels.map((channel) => channel.buffer as ArrayBuffer) : [];
	callbacks.get(backend)?.(index, params.freq, buffers.length ? transfer(message, buffers) : message);
}
