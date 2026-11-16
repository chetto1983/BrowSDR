import { flushDecoders } from './flush';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { DspEngine } from './engine';
import { DecodedEvents, formatEvent } from './events';
import { registerMeteorWasm, writeMeteorPng } from './meteor';
import { planDecode } from './plan';
import type { CliIo, DecoderName, FileDecodeRun, RelayStatus } from './types';

const CHUNK_BYTES = 262144;
const IDLE: RelayStatus = { connected: false, state: { frequency_hz: 0, sample_rate: 0, gain_index: 0 }, clients: [] };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Decodes an rtl_tcp recording (unsigned 8-bit I/Q, as the relay sends it) at full speed through the
 * same DSP worker and decoders as a live run. --center and --rate must describe the recording.
 */
export async function runFileDecode(decoder: DecoderName, run: FileDecodeRun, io: CliIo): Promise<number> {
	const plan = planDecode(decoder, { ...run, take: true }, IDLE);
	if (decoder === 'meteor') await registerMeteorWasm();
	const bytes = statSync(run.iqFile).size;
	io.err(
		`${decoder}: file ${run.iqFile}, ${(bytes / 2 / plan.sampleRate).toFixed(0)} s at ${(plan.sampleRate / 1e6).toFixed(3)} MS/s, centre ${plan.centerMHz} MHz, channel ${plan.freqMHz} MHz`,
	);
	const events = new DecodedEvents();
	const engine = await DspEngine.start(plan.sampleRate, plan.centerMHz, plan.params, (message) => {
		if (message.type === 'error') io.err(`dsp error: ${message.error}`);
		for (const record of events.accept(message)) io.out(run.json ? JSON.stringify(record) : formatEvent(record));
	});
	const fd = openSync(run.iqFile, 'r');
	const raw = Buffer.alloc(CHUNK_BYTES);
	let offset = 0;
	let chunks = 0;
	try {
		for (let read = readSync(fd, raw, 0, CHUNK_BYTES, 0); read > 0; read = readSync(fd, raw, 0, CHUNK_BYTES, offset)) {
			offset += read;
			engine.process(Int8Array.from(raw.subarray(0, read & ~1), (byte) => byte - 128));
			if (++chunks % 16 === 0) await engine.drain();
			// Let the image decoder finish loading before symbols pile up.
			if (chunks === 1) await wait(300);
		}
	} finally {
		closeSync(fd);
	}
	await flushDecoders(engine);
	const png = decoder === 'meteor' ? writeMeteorPng(events.meteorImage, run.out ?? '.', new Date()) : null;
	const summary = {
		kind: 'summary',
		decoder,
		file: run.iqFile,
		seconds: Math.round(bytes / 2 / plan.sampleRate),
		records: events.count,
		lines: events.meteorImage.rows,
		png,
	};
	io.out(
		run.json
			? JSON.stringify(summary)
			: `summary: ${events.count} records, ${events.meteorImage.rows} image lines${png ? ` → ${png}` : ''}`,
	);
	return engine.failure ? 1 : 0;
}
