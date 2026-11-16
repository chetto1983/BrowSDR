import type { DspEngine } from './engine';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Decoders report on a timer (500 ms for Meteor); one more chunk after it elapses flushes their last records. */
export async function flushDecoders(
	engine: Pick<DspEngine, 'drain' | 'process'>,
	wait: (ms: number) => Promise<void> = sleep,
): Promise<void> {
	await engine.drain();
	await wait(600);
	engine.process(new Int8Array(2048));
	await engine.drain();
}
