import { Fft } from '@/worker/decoders/dab/ofdm/fft';

/** A seeded uniform generator in [0, 1) (mulberry32). */
export function random(seed) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** The test ensemble: a DAB+ service (AAC tones and a dynamic label) and a DAB service on a UEP sub-channel. */
export const DLS = 'BrowSDR test tones: 440 Hz left, 1 kHz right';
export const ENSEMBLE = {
	ensembleLabel: 'BrowSDR DAB Test',
	eid: 0xc0de,
	services: [
		{ sid: 0xc221, label: 'BrowSDR Plus', subId: 3, bitrate: 48, sampleRate: 48000, leftHz: 440, rightHz: 1000, dls: DLS },
		{ sid: 0xc222, label: 'BrowSDR MP2', subId: 4, bitrate: 96, dabPlus: false, uepIndex: 26 },
	],
};

/** What a DabReceiver reported. */
export function recorder() {
	const r = { status: [], ensembles: [], aus: [], labels: [] };
	r.events = {
		status: (s) => r.status.push(s),
		ensemble: (info) => r.ensembles.push(structuredClone(info)),
		audioUnit: (au, params, ok) => r.aus.push({ au: au.slice(), params, ok }),
		label: (text) => r.labels.push(text),
	};
	return r;
}

/** Feeds `seconds` of the signal to `receiver` in chunks; returns the processing time in ms. */
export function feed(receiver, signal, seconds, chunk = 40960) {
	let total = Math.round(seconds * 2048000),
		ms = 0;
	while (total > 0) {
		const n = Math.min(chunk, total);
		const iq = signal.generate(n);
		const t0 = performance.now();
		receiver.process(iq);
		ms += performance.now() - t0;
		total -= n;
	}
	return ms;
}

/** Drops `seconds` of the signal (samples lost on the way). */
export function skip(signal, seconds) {
	for (let total = Math.round(seconds * 2048000); total > 0; total -= 40960) signal.generate(Math.min(40960, total));
}

/** The strongest frequency (Hz) of `x` at `rate`, from a Hann-windowed FFT of 8192 points. */
export function dominantFrequency(x, rate) {
	const n = 8192;
	const fft = new Fft(n);
	const re = new Float64Array(n),
		im = new Float64Array(n);
	for (let i = 0; i < n && i < x.length; i++) re[i] = x[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
	fft.forward(re, im);
	let best = 1;
	for (let k = 1; k < n / 2; k++) if (re[k] ** 2 + im[k] ** 2 > re[best] ** 2 + im[best] ** 2) best = k;
	return (best * rate) / n;
}

/** Root mean square of a block of samples. */
export const rms = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / Math.max(1, x.length));
