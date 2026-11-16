import { RtlTcpDevice } from '@/devices/rtltcp/device';
import { newRelayToken, withRelayClient } from '@/devices/rtltcp/relay-control';
import { DspEngine } from './engine';
import { DecodedEvents, formatEvent } from './events';
import { bandChange, planDecode, relayEndpoints } from './plan';
import { registerMeteorWasm, writeMeteorPng } from './meteor';
import type { CliIo, DecodePlan, DecodeRun, DecoderName, RelayStatus } from './types';

export async function fetchRelayStatus(relay: string): Promise<RelayStatus> {
	const response = await fetch(relayEndpoints(relay).status, { signal: AbortSignal.timeout(5000) });
	if (!response.ok) throw new Error(`Relay status returned HTTP ${response.status}.`);
	return (await response.json()) as RelayStatus;
}

async function openSource(relay: string, plan: DecodePlan, token: string): Promise<RtlTcpDevice> {
	const device = new RtlTcpDevice(withRelayClient(relayEndpoints(relay).ws, token, plan.take));
	await device.open();
	// A listener's commands are dropped by the relay; the call still sizes the device's IQ chunks.
	await device.setSampleRate(plan.sampleRate);
	if (plan.role === 'controller') {
		await device.setFrequency(Math.round(plan.centerMHz * 1e6));
		await device.setGains({ Tuner: plan.gainIndex });
	}
	return device;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A failed status read is not a reason to stop; a changed band is. */
async function watchBand(relay: string, plan: DecodePlan, token: string): Promise<string> {
	try {
		return bandChange(plan, await fetchRelayStatus(relay), token) ?? '';
	} catch {
		return '';
	}
}

/** Decodes for `seconds`, printing one record per line (NDJSON with --json) and a final summary. */
export async function runDecode(decoder: DecoderName, run: DecodeRun, io: CliIo): Promise<number> {
	const plan = planDecode(decoder, run, await fetchRelayStatus(run.relay));
	io.err(
		`${decoder}: ${plan.role} at ${plan.centerMHz.toFixed(3)} MHz, ${(plan.sampleRate / 1e6).toFixed(3)} MS/s, channel ${plan.freqMHz} MHz`,
	);
	if (decoder === 'meteor') await registerMeteorWasm();
	const events = new DecodedEvents();
	const startedAt = new Date();
	const engine = await DspEngine.start(plan.sampleRate, plan.centerMHz, plan.params, (message) => {
		if (message.type === 'error') io.err(`dsp error: ${message.error}`);
		for (const record of events.accept(message)) io.out(run.json ? JSON.stringify(record) : formatEvent(record));
	});
	const token = newRelayToken();
	const device = await openSource(run.relay, plan, token);
	let samples = 0;
	await device.startRx((view) => {
		samples += view.byteLength / 2;
		engine.process(new Int8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)));
	});
	const started = performance.now();
	let error = '';
	for (let second = 1; second <= run.seconds && !error; second++) {
		await wait(1000);
		error = device.getRxStreamStats().sourceError ?? engine.failure ?? '';
		if (!error && second % 5 === 0) error = await watchBand(run.relay, plan, token);
		if (second % 10 === 0)
			io.err(
				`t=${second}s  ${(samples / second / 1e6).toFixed(3)} MS/s  dsp ${((engine.busyMs / (performance.now() - started)) * 100).toFixed(0)}%  records ${events.count}`,
			);
	}
	await device.close();
	await engine.drain();
	const elapsed = (performance.now() - started) / 1000;
	const png = decoder === 'meteor' ? writeMeteorPng(events.meteorImage, run.out ?? '.', startedAt, run.pngPrefix) : null;
	const summary = {
		kind: 'summary',
		decoder,
		role: plan.role,
		freq_mhz: plan.freqMHz,
		center_mhz: plan.centerMHz,
		sample_rate: plan.sampleRate,
		gain_index: plan.gainIndex,
		seconds: Math.round(elapsed),
		input_msps: +(samples / elapsed / 1e6).toFixed(3),
		dsp_load: +(engine.busyMs / 1000 / elapsed).toFixed(3),
		records: events.count,
		aircraft: events.aircraft,
		...(decoder === 'meteor' ? { lines: events.meteorImage.rows, png } : {}),
		...(error ? { error } : {}),
	};
	io.out(
		run.json
			? JSON.stringify(summary)
			: `summary: ${events.count} records${decoder === 'adsb' ? `, ${events.aircraft} aircraft` : ''} in ${summary.seconds} s${error ? ` — stopped: ${error}` : ''}`,
	);
	return error ? 1 : 0;
}
