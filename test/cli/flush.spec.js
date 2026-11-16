import { describe, expect, it } from 'vitest';
import { flushDecoders } from '../../src/cli/flush';

describe('flushing the decoders at the end of a run', () => {
	it('drains, waits out the report timer, then pushes one small chunk and drains again', async () => {
		const calls = [];
		const engine = {
			drain: async () => void calls.push('drain'),
			process: (chunk) => void calls.push(`process ${chunk.length}`),
		};
		await flushDecoders(engine, async (ms) => void calls.push(`wait ${ms}`));
		expect(calls).toEqual(['drain', 'wait 600', 'process 2048', 'drain']);
	});
});
