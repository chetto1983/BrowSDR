import type { DspInput, DspOutput } from '@/worker/runtime/dsp-messages.types';
import type { VfoParams } from '@/worker/runtime/types';
import type { WorkerScope } from './types';

/** BrowSDR's per-VFO DSP worker, hosted in this process: same code and WASM as the browser. */
export class DspEngine {
	private queue: Promise<void> = Promise.resolve();
	private chunkId = 0;
	busyMs = 0;
	failure: string | null = null;

	private constructor(
		private readonly scope: WorkerScope,
		private readonly params: VfoParams,
	) {}

	static async start(sampleRate: number, centerMHz: number, params: VfoParams, onOutput: (message: DspOutput) => void): Promise<DspEngine> {
		const scope: WorkerScope = { postMessage: onOutput, onmessage: null };
		// dsp-worker binds itself to `self` when imported, as it would inside a Web Worker.
		Object.defineProperty(globalThis, 'self', { value: scope, configurable: true, writable: true });
		await import('@/worker/dsp-worker');
		const engine = new DspEngine(scope, params);
		await engine.send({ type: 'init', sampleRate, centerFreq: centerMHz, params });
		return engine;
	}

	/** Queues one IQ chunk; chunks are processed strictly in order. */
	process(chunk: Int8Array): void {
		const chunkId = ++this.chunkId;
		this.queue = this.queue.then(async () => {
			if (this.failure) return;
			const start = performance.now();
			try {
				await this.send({ type: 'process', params: this.params, chunk: chunk.buffer, chunkLen: chunk.length, floatIq: false, chunkId });
			} catch (error) {
				this.failure = error instanceof Error ? error.message : String(error);
			}
			this.busyMs += performance.now() - start;
		});
	}

	drain(): Promise<void> {
		return this.queue;
	}

	private async send(data: DspInput): Promise<void> {
		if (!this.scope.onmessage) throw new Error('The DSP worker did not install its message handler.');
		await this.scope.onmessage({ data });
	}
}
