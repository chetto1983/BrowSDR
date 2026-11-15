import { transfer } from 'comlink';
import type { Backend } from '@/worker/runtime/backend';
import type { TetraEarCallback, TetraEarSymbols } from './types';

const callbacks = new WeakMap<Backend, TetraEarCallback>();

export function setTetraEarCallback(this: Backend, callback: TetraEarCallback | null): void {
	if (callback) callbacks.set(this, callback);
	else callbacks.delete(this);
}

export function routeTetraEar(backend: Backend, worker: Worker, message: TetraEarSymbols): void {
	const index = backend.dspWorkers?.indexOf(worker) ?? -1;
	const params = backend.vfoParams?.[index];
	if (index < 0 || params?.tetraear !== message.session || params.freq !== message.freq) return;
	callbacks.get(backend)?.(index, message.bits ? transfer(message, [message.bits]) : message);
}
