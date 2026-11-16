import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import FaadModule from '../../wasm/faad2/pkg/faad.js';
import { createAacDecoder, provideFaadFactory } from '@/worker/decoders/dabplus/faad';
import { DabReceiver } from '@/worker/decoders/dab/receiver';
import { DabSignal, Transmitter } from './transmitter.js';
import { DLS, ENSEMBLE, dominantFrequency, feed, recorder, rms } from './fixtures.js';

const pkg = (file) => fileURLToPath(new URL(`../../wasm/faad2/pkg/${file}`, import.meta.url));
readFileSync(pkg('faad.wasm'));

beforeAll(() => provideFaadFactory((options) => FaadModule({ ...options, locateFile: pkg })));

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Where the receiver's access units start in the transmitter's loop: -1 when they are not all there in order. */
function loopOffset(aus, sent) {
	return sent.findIndex((_, start) => aus.every((au, i) => same(au, sent[(start + i) % sent.length])));
}

describe('DAB receiver', () => {
	const tx = new Transmitter(ENSEMBLE);
	const sent = tx.subs[0].aus;
	let run;

	beforeAll(() => {
		const signal = new DabSignal(ENSEMBLE, { snrDb: 12, cfoHz: 2700, seed: 9 });
		const r = recorder();
		const receiver = new DabReceiver(r.events);
		receiver.select(3);
		const acquire = feed(receiver, signal, 1);
		const ms = feed(receiver, signal, 2) / 2;
		run = { r, ms };
		console.log(`DAB receiver: ${ms.toFixed(0)} ms per second of input once locked, ${acquire.toFixed(0)} ms for the first second`);
	});

	it('locks and reports the ensemble', () => {
		const { r } = run;
		const synced = r.status.filter((s) => s.state === 'synced');
		expect(synced.length).toBeGreaterThan(3);
		const last = synced.at(-1);
		expect(Math.abs(last.freqOffsetHz - 2700)).toBeLessThan(100);
		expect(last.ficOkRatio).toBeGreaterThan(0.95);
		expect(r.ensembles.at(-1)).toEqual({
			eid: 0xc0de,
			label: 'BrowSDR DAB Test',
			services: [
				{
					sid: 0xc221,
					label: 'BrowSDR Plus',
					shortLabel: 'BrowSDR',
					components: [{ subchannel: 3, dabPlus: true, bitrate: 48, protection: 'EEP 3-A', primary: true }],
				},
				{
					sid: 0xc222,
					label: 'BrowSDR MP2',
					shortLabel: 'BrowSDR',
					components: [{ subchannel: 4, dabPlus: false, bitrate: 96, protection: 'UEP 3', primary: true }],
				},
			],
		});
	});

	it('delivers the access units as sent, and the dynamic label', () => {
		const { r } = run;
		expect(r.aus.length).toBeGreaterThan(60);
		expect(r.aus.every((a) => a.ok)).toBe(true);
		expect(
			loopOffset(
				r.aus.map((a) => a.au),
				sent,
			),
		).toBeGreaterThanOrEqual(0);
		expect(r.aus[0].params).toMatchObject({ sampleRate: 48000, sbr: false, ps: false, stereo: true });
		expect(Array.from(r.aus[0].params.asc)).toEqual([0x11, 0x94]);
		expect(r.labels.at(-1)).toBe(DLS);
	});

	it('plays the tones through faad2', async () => {
		const { r } = run;
		const decoder = await createAacDecoder(r.aus[0].params.asc);
		const left = [],
			right = [];
		for (const { au } of r.aus) {
			const pcm = decoder.decode(au);
			expect(pcm).not.toBeNull();
			for (let i = 0; i < pcm.length; i += 2) {
				left.push(pcm[i]);
				right.push(pcm[i + 1]);
			}
		}
		decoder.close();
		const l = left.slice(4800),
			rr = right.slice(4800);
		expect(rms(l)).toBeGreaterThan(0.1);
		expect(Math.abs(dominantFrequency(l, 48000) - 440)).toBeLessThan(10);
		expect(Math.abs(dominantFrequency(rr, 48000) - 1000)).toBeLessThan(10);
	});

	it('runs well under real time', () => {
		expect(run.ms).toBeLessThan(250);
	});
});
