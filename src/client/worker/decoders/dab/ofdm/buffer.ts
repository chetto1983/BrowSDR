// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/dab/dab_rx.cpp (the sample buffer of DabReceiver::Impl: buf, base,
// trim, and the input conditioning of DabReceiver::feed: non-finite samples zeroed, the mirror conjugation, the impulse
// blanker), https://github.com/adswill/OnAir; see third_party/onair. Changes: one growing interleaved Float32Array with a
// start offset, so a trim moves an index instead of erasing the front of a vector.

/** Complex samples addressed by their absolute index since the start (or the last clear). */
export class SampleBuffer {
	/** Interleaved I/Q; sample `abs` sits at 2 * (abs - base + start). */
	data = new Float32Array(2 * 524_288);
	/** Absolute index of the first sample kept. */
	base = 0;
	/** Samples kept. */
	length = 0;
	/** Array index (in samples) of the sample `base`. */
	start = 0;
	/** The impulse blanker's running mean power. */
	private impPow = 0;
	/** Samples zeroed (impulses and samples that were not numbers). */
	impulses = 0;

	get end(): number {
		return this.base + this.length;
	}

	/** Index into `data` of the real part of sample `abs`. */
	offset(abs: number): number {
		return 2 * (abs - this.base + this.start);
	}

	clear(): void {
		this.base = 0;
		this.length = 0;
		this.start = 0;
		this.impPow = 0;
	}

	/** Appends interleaved samples (conjugated when `mirror`) and blanks the impulses among them. */
	append(iq: Float32Array, mirror: boolean): void {
		const n = iq.length >> 1;
		if (n === 0) return;
		this.reserve(n);
		const d = this.data;
		const from = 2 * (this.start + this.length);
		const sign = mirror ? -1 : 1;
		const cap = this.impPow > 0 ? 16 * this.impPow : 1e30;
		let s = 0,
			bad = 0;
		for (let i = 0; i < n; i++) {
			const re = iq[2 * i],
				im = iq[2 * i + 1];
			d[from + 2 * i] = re;
			d[from + 2 * i + 1] = sign * im;
			s += Math.min(re * re + im * im, cap);
			bad += re - re + (im - im); // NaN once a sample is not a number
		}
		this.length += n;
		if (bad !== 0) s = this.zeroBroken(from, n, cap);
		// Impulse blanker: a sample 12 dB over the mean power (ignition, switching, a spark) is zeroed. OFDM itself goes that
		// high about once in ten million samples; a zeroed sample costs the symbol far less than the impulse would.
		const m = s / n;
		if (Number.isFinite(m)) this.impPow = this.impPow > 0 ? 0.95 * this.impPow + 0.05 * m : m;
		if (this.impPow <= 0) return;
		const lim = 16 * this.impPow;
		for (let i = from, e = from + 2 * n; i < e; i += 2) {
			if (d[i] * d[i] + d[i + 1] * d[i + 1] <= lim) continue;
			d[i] = 0;
			d[i + 1] = 0;
			this.impulses++;
		}
	}

	/** Samples that are not numbers (a broken driver) are zeroed; returns the capped power sum again. */
	private zeroBroken(from: number, n: number, cap: number): number {
		const d = this.data;
		let s = 0;
		for (let i = from, e = from + 2 * n; i < e; i += 2) {
			if (!Number.isFinite(d[i]) || !Number.isFinite(d[i + 1])) {
				d[i] = 0;
				d[i + 1] = 0;
				this.impulses++;
			}
			s += Math.min(d[i] * d[i] + d[i + 1] * d[i + 1], cap);
		}
		return s;
	}

	/** Drops the samples before `keepFrom` (absolute). */
	trim(keepFrom: number): void {
		if (keepFrom <= this.base) return;
		const drop = Math.min(keepFrom - this.base, this.length);
		this.base += drop;
		this.start += drop;
		this.length -= drop;
	}

	/** Conjugates everything kept (the search tries the mirrored spectrum). */
	conjugate(): void {
		const d = this.data;
		for (let i = 2 * this.start + 1, e = 2 * (this.start + this.length); i < e; i += 2) d[i] = -d[i];
	}

	/** Mean power of every 7th sample in [a, b) (absolute), 0 when that is not buffered. */
	power(a: number, b: number): number {
		if (a < this.base || b > this.end) return 0;
		const d = this.data;
		let s = 0,
			n = 0;
		for (let i = this.offset(a), e = this.offset(b); i < e; i += 14) {
			s += d[i] * d[i] + d[i + 1] * d[i + 1];
			n++;
		}
		return n ? s / n : 0;
	}

	private reserve(n: number): void {
		if (2 * (this.start + this.length + n) <= this.data.length) return;
		if (this.start > 0) {
			this.data.copyWithin(0, 2 * this.start, 2 * (this.start + this.length));
			this.start = 0;
		}
		if (2 * (this.length + n) <= this.data.length) return;
		let size = this.data.length;
		while (size < 2 * (this.length + n)) size *= 2;
		const grown = new Float32Array(size);
		grown.set(this.data.subarray(0, 2 * this.length));
		this.data = grown;
	}
}
