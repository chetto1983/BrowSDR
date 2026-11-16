// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// CubeSat AX.25 telemetry for BrowSDR, after OnAir core/src/cubesat/cubesat_rx.cpp (one FM channel, every framing
// at once: 1200 bd AFSK and 9600 / 4800 bd G3RUH), https://github.com/adswill/OnAir; see third_party/onair.
// The AFSK path is BrowSDR's APRS demodulator.

import type { DigimodeDecoder, DigimodeSink } from '@/worker/decoders/digimode/types';
import { AprsDemodulator } from '@/worker/decoders/aprs/demodulator';
import { decodeAx25, latin1, printable } from '@/worker/decoders/aprs/ax25';
import { G3ruhSlicer } from './g3ruh';

export const CUBESAT_RATE = 96000;
/** OnAir's packet front end: channel pass 9 kHz, stop 17 kHz, before the discriminator. */
const CHANNEL_TAPS = lowPass(41, (9000 + 17000) / 2 / CUBESAT_RATE);

/** Hamming-windowed sinc, unity gain at DC; cutoff in cycles per sample. */
function lowPass(taps: number, cutoff: number): Float64Array {
	const h = new Float64Array(taps);
	const middle = (taps - 1) / 2;
	let sum = 0;
	for (let i = 0; i < taps; i++) {
		const t = i - middle;
		const sinc = t === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * t) / (Math.PI * t);
		h[i] = sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1)));
		sum += h[i];
	}
	return h.map((value) => value / sum);
}
/** A frame heard by two demodulators within this time is reported once. */
const DUPLICATE_MS = 2000;
const KNOWN_CALLS: Record<string, string> = { RS0ISS: 'ISS', NA1SS: 'ISS' };

const hex = (bytes: Uint8Array, max = 64) =>
	[...bytes.subarray(0, max)].map((byte) => byte.toString(16).padStart(2, '0')).join(' ') + (bytes.length > max ? ' …' : '');

export class CubesatDecoder implements DigimodeDecoder {
	private prevR = 1;
	private prevI = 0;
	/** Channel filter history, doubled so the newest taps are contiguous. */
	private history = new Float64Array(CHANNEL_TAPS.length * 4);
	private head = 0;
	private afcHz = 0;
	private disc = new Float32Array(0);
	private half = new Float32Array(0);
	private readonly slicers = [9600, 4800].map(
		(baud) => new G3ruhSlicer(CUBESAT_RATE, baud, (frame) => this.report(frame, `G3RUH ${baud} bd`)),
	);
	private readonly afsk = new AprsDemodulator((frame) => this.report(frame, 'AFSK 1200 bd'));
	private recent = new Map<string, number>();
	private frames = 0;

	constructor(private readonly sink: DigimodeSink) {}

	process(iq: Float32Array): void {
		const count = iq.length >> 1;
		if (this.disc.length < count) this.disc = new Float32Array(count);
		if (this.half.length < count) this.half = new Float32Array(count);
		for (let n = 0; n < count; n++) {
			const [xr, xi] = this.filter(iq[2 * n], iq[2 * n + 1]);
			iq[2 * n] = xr;
			iq[2 * n + 1] = xi;
			const hz = Math.atan2(xi * this.prevR - xr * this.prevI, xr * this.prevR + xi * this.prevI) * (CUBESAT_RATE / (2 * Math.PI));
			this.prevR = xr;
			this.prevI = xi;
			// Slow AFC on the discriminator mean: the Doppler left after tuning moves a few hundred Hz per second.
			this.afcHz += 0.0002 * (hz - this.afcHz);
			this.disc[n] = Math.max(-8000, Math.min(8000, hz - this.afcHz));
		}
		const disc = this.disc.subarray(0, count);
		for (const slicer of this.slicers) slicer.process(disc);
		// The 1200 bd demodulator runs at 48 kHz: every other sample of the channel (already filtered to ±15 kHz).
		let m = 0;
		for (let n = 0; n + 1 < count; n += 2) {
			this.half[m++] = iq[2 * n];
			this.half[m++] = iq[2 * n + 1];
		}
		this.afsk.process(this.half.subarray(0, m));
	}

	/** One complex sample through the channel filter. */
	private filter(re: number, im: number): [number, number] {
		const taps = CHANNEL_TAPS.length;
		const h = this.history;
		h[2 * this.head] = h[2 * (this.head + taps)] = re;
		h[2 * this.head + 1] = h[2 * (this.head + taps) + 1] = im;
		let yr = 0;
		let yi = 0;
		for (let k = 0; k < taps; k++) {
			const j = 2 * (this.head + 1 + k);
			yr += CHANNEL_TAPS[k] * h[j];
			yi += CHANNEL_TAPS[k] * h[j + 1];
		}
		this.head = (this.head + 1) % taps;
		return [yr, yi];
	}

	reset(): void {
		this.history.fill(0);
		this.head = 0;
		this.prevR = 1;
		this.prevI = 0;
		this.afcHz = 0;
		for (const slicer of this.slicers) slicer.reset();
		this.afsk.reset();
		this.recent.clear();
	}

	private report(payload: Uint8Array, framing: string): void {
		const key = hex(payload, payload.length);
		const now = Date.now();
		for (const [old, at] of this.recent) if (now - at > DUPLICATE_MS) this.recent.delete(old);
		if (this.recent.has(key)) return;
		this.recent.set(key, now);
		const frame = decodeAx25(payload);
		if (!frame) return;
		const raw = latin1(frame.info);
		const readableShare = raw.length ? raw.replace(/[^\x20-\x7e\r\n]/g, '').length / raw.length : 1;
		const text = readableShare >= 0.8 ? printable(raw.replace(/[\r\n]+/g, ' ').trim()) : '';
		const call = frame.source.replace(/-\d+$/, '');
		const satellite = KNOWN_CALLS[call];
		const path = frame.path.length ? `,${frame.path.join(',')}` : '';
		this.frames++;
		this.sink.status(`${this.frames} frame(s), last ${framing}`, false);
		this.sink.record({
			text: `${satellite ? `${satellite} · ` : ''}${frame.source} → ${frame.destination}${path}: ${text || `${frame.info.length} bytes of binary telemetry`}`,
			fields: [
				['Source', frame.source],
				['Destination', frame.destination],
				...(frame.path.length ? ([['Path', frame.path.join(', ')]] as Array<[string, string]>) : []),
				['Framing', framing],
				['Control / PID', `0x${frame.control.toString(16)} / ${frame.pid === undefined ? '—' : `0x${frame.pid.toString(16)}`}`],
				['Information', `${frame.info.length} bytes`],
				['Hex', hex(frame.info)],
			],
		});
	}
}
