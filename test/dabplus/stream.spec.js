import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import FaadModule from '../../wasm/faad2/pkg/faad.js';
import { provideFaadFactory, createAacDecoder } from '@/worker/decoders/dabplus/faad';
import { DAB_RATE, DabStream, provideDabReceiver } from '@/worker/decoders/dabplus/stream';

const binary = readFileSync(new URL('../../wasm/dsp/pkg/browsdr_dsp_bg.wasm', import.meta.url));
const dsp = await import('../../wasm/dsp/pkg/browsdr_dsp.js');
const wasm = dsp.initSync({ module: binary });
const pkg = (file) => fileURLToPath(new URL(`../../wasm/faad2/pkg/${file}`, import.meta.url));

/** AudioSpecificConfig as OnAir builds it for DAB+ (AAC-LC 960, optional SBR / PS). */
function asc(dac, sbr, stereo, ps) {
	const coreRate = sbr ? (dac ? 24000 : 16000) : dac ? 48000 : 32000;
	const index = (hz) => (hz === 48000 ? 3 : hz === 32000 ? 5 : hz === 24000 ? 6 : 8);
	const bits = [];
	const put = (value, n) => {
		for (let i = n - 1; i >= 0; i--) bits.push((value >> i) & 1);
	};
	if (!sbr) [put(2, 5), put(index(coreRate), 4), put(stereo && !ps ? 2 : 1, 4)];
	else [put(ps ? 29 : 5, 5), put(index(coreRate), 4), put(stereo && !ps ? 2 : 1, 4), put(index(coreRate * 2), 4), put(2, 5)];
	put(4, 3); // frameLengthFlag 1 (960), dependsOnCoreCoder 0, extensionFlag 0
	while (bits.length % 8) bits.push(0);
	return Uint8Array.from({ length: bits.length / 8 }, (_, i) => bits.slice(i * 8, i * 8 + 8).reduce((a, b) => a * 2 + b, 0));
}

const ENSEMBLE = {
	eid: 0x5001,
	label: 'DAB Italia',
	services: [
		{ sid: 0x5201, label: 'Radio Uno', components: [{ subchannel: 3, dabPlus: true, bitrate: 96, protection: 'EEP 3-A', primary: true }] },
		{
			sid: 0x5202,
			label: 'Classic MP2',
			components: [{ subchannel: 4, dabPlus: false, bitrate: 128, protection: 'UEP 3', primary: true }],
		},
		{ sid: 0x5203, label: 'Radio Due', components: [{ subchannel: 5, dabPlus: true, bitrate: 64, protection: 'EEP 3-A', primary: true }] },
	],
};

/** A receiver core that reports what the test tells it to. */
function fakeCore() {
	const core = { events: null, selected: [], processed: 0 };
	provideDabReceiver((events) => {
		core.events = events;
		return {
			process: (iq) => (core.processed += iq.length / 2),
			select: (sub) => core.selected.push(sub),
			reset: () => {},
		};
	});
	return core;
}

function stream() {
	const messages = [];
	return { messages, dab: new DabStream(dsp.DspProcessor, wasm.memory, (message) => messages.push(message)) };
}

const params = (extra = {}) => ({ freq: 223.936, mode: 'dab', bandwidth: 1536000, enabled: true, dabService: 0, ...extra });
const feed = (dab, sequence, samples = 24000) => {
	const pointer = wasm.alloc_iq_buffer(samples * 2);
	return dab.process(pointer, samples * 2, false, sequence);
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeAll(() => provideFaadFactory((options) => FaadModule({ ...options, locateFile: pkg })));
beforeEach(() => {
	let clock = 0;
	vi.spyOn(performance, 'now').mockImplementation(() => (clock += 600));
});
afterEach(() => vi.restoreAllMocks());

describe('faad2 for DAB+', () => {
	it.each([
		['AAC-LC 48 kHz stereo', [1, 0, 1, 0], 48000],
		['AAC-LC 32 kHz stereo', [0, 0, 1, 0], 32000],
		['HE-AAC 48 kHz', [1, 1, 1, 0], 48000],
		['HE-AAC v2 48 kHz', [1, 1, 0, 1], 48000],
	])('opens %s', async (_, flags, rate) => {
		const decoder = await createAacDecoder(asc(...flags));
		expect(decoder.rate).toBe(rate);
		expect(decoder.decode(new Uint8Array([0x12, 0x34, 0x56]))).toBeNull(); // not an access unit
		decoder.close();
	});
	it('refuses a configuration that is not AAC', async () => {
		await expect(createAacDecoder(new Uint8Array([0xf8, 0x00]))).rejects.toThrow('faad2 refused');
	});
});

describe('DAB+ stream', () => {
	it('picks the first DAB+ service, then the one asked for', async () => {
		const core = fakeCore();
		const { dab, messages } = stream();
		dab.configure(params(), 2_400_000, 223.9);
		core.events.ensemble(ENSEMBLE);
		expect(core.selected.at(-1)).toBe(3);
		dab.configure(params({ dabService: 0x5203 }), 2_400_000, 223.9);
		expect(core.selected.at(-1)).toBe(5);
		core.events.status({ state: 'synced', snrDb: 14.2, freqOffsetHz: 120, ficOkRatio: 0.98, frames: 40 });
		core.events.label('Now playing: test');
		feed(dab, 1);
		const status = messages.at(-1).status;
		expect(status).toMatchObject({ state: 'synced', ensemble: 'DAB Italia', service: 0x5203, serviceLabel: 'Radio Due', bitrate: 64 });
		expect(status.message).toBe('Ensemble locked · SNR 14.2 dB · FIC 98 %');
		expect(status.label).toBe('Now playing: test');
		expect(core.processed).toBeGreaterThan(19000); // 24000 samples at 2.4 MS/s become ~20480 at 2.048 MS/s
	});
	it('conceals lost access units with silence of their length', async () => {
		const core = fakeCore();
		const { dab, messages } = stream();
		dab.configure(params(), 2_048_000, 223.9);
		core.events.ensemble(ENSEMBLE);
		const audio = { sampleRate: 32000, sbr: true, ps: false, stereo: true, asc: asc(0, 1, 1, 0) };
		core.events.audioUnit(new Uint8Array(10), audio, false);
		await vi.waitFor(async () => {
			await flush();
			core.events.audioUnit(new Uint8Array(10), audio, false);
			feed(dab, 1, 1);
			expect(messages.at(-1)?.status.codec ?? '').toBe('HE-AAC stereo 32 kHz');
		});
		const before = messages.at(-1).status.audioErrors;
		for (let i = 0; i < 10; i++) core.events.audioUnit(new Uint8Array(10), audio, false);
		// 1920 frames at 32 kHz, 2880 at 48 kHz per unit: 100 ms of IQ plays 4800 frames once the 100 ms buffer is full.
		let played = 0;
		for (let sequence = 2; sequence < 12; sequence++) played += (feed(dab, sequence, DAB_RATE / 10)?.length ?? 0) / 2;
		feed(dab, 12, 1);
		expect(messages.at(-1).status.audioErrors).toBe(before + 10);
		expect(played).toBeGreaterThan(20000);
	});
	it('asks for a wider band below 2.048 MS/s', () => {
		fakeCore();
		const { dab, messages } = stream();
		dab.configure(params(), 1_024_000, 223.936);
		expect(messages.at(-1).status.state).toBe('error');
		expect(messages.at(-1).status.message).toContain('2.048 MSPS');
	});
});
