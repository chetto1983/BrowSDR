// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/hfdig/hfdig_sstv.cpp (picture filter: rawAt, noiseSigma,
// filterRows), https://github.com/adswill/OnAir; see third_party/onair.
//
// Each raw row, once the rows around it are final, goes to the shown picture through a noise-adaptive filter. The
// noise of each colour is measured on the picture itself (the median absolute 3x3 Laplacian of the raw rows), so a
// clean picture is left as it was. A 3x3 local Wiener (Lee) filter keeps edges and smooths flat areas; on a very
// noisy picture (sigma 30 levels and more) the FM clicks are first replaced by the median of the eight around them.

import { clamp8 } from './modes';

const LAP_BINS = 1024;

export class SstvPicture {
	/** The picture shown (filtered rows, then raw rows not filtered yet). */
	readonly rgb: Uint8Array;
	/** The pixels as measured. */
	readonly raw: Uint8Array;
	rows = 0;
	private lapRows = 0;
	private filtRows = 0;
	private readonly lapHist = [new Uint32Array(LAP_BINS), new Uint32Array(LAP_BINS), new Uint32Array(LAP_BINS)];

	constructor(
		readonly width: number,
		readonly height: number,
		private readonly noiseFilter = true,
	) {
		this.rgb = new Uint8Array(width * height * 3);
		this.raw = new Uint8Array(width * height * 3);
	}

	rawAt(x: number, y: number, c: number): number {
		const xx = Math.max(0, Math.min(this.width - 1, x));
		const yy = Math.max(0, Math.min(this.rows - 1, y));
		return this.raw[(yy * this.width + xx) * 3 + c];
	}

	/** Noise of colour c in levels: 1.4826 x median |L| / 6 (L the 3x3 Laplacian, 6 its noise gain). */
	private noiseSigma(c: number): number {
		const hist = this.lapHist[c];
		let total = 0;
		for (const v of hist) total += v;
		if (total < 2000) return 0;
		let acc = 0;
		for (let b = 0; b < LAP_BINS; b++) {
			acc += hist[b];
			if (2 * acc >= total) return (1.4826 * (b + 0.5)) / 6;
		}
		return (1.4826 * LAP_BINS) / 6;
	}

	private countLaplacian(y: number): void {
		for (let x = 1; x + 1 < this.width; x += 2)
			for (let c = 0; c < 3; c++) {
				const r = (dx: number, dy: number) => this.rawAt(x + dx, y + dy, c);
				const l = r(-1, -1) - 2 * r(0, -1) + r(1, -1) - 2 * r(-1, 0) + 4 * r(0, 0) - 2 * r(1, 0) + r(-1, 1) - 2 * r(0, 1) + r(1, 1);
				this.lapHist[c][Math.min(LAP_BINS - 1, Math.abs(l))]++;
			}
	}

	/** A raw pixel; a click (far from its eight neighbours) is replaced by their median. */
	private value(x: number, y: number, c: number, sigma: number, clicks: boolean): number {
		const v0 = this.rawAt(x, y, c);
		if (!clicks) return v0;
		const nb: number[] = [];
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) nb.push(this.rawAt(x + dx, y + dy, c));
		nb.sort((a, b) => a - b);
		const med = 0.5 * (nb[3] + nb[4]);
		return Math.abs(v0 - med) > 2.5 * sigma ? med : v0;
	}

	private filterRow(y: number, sigmas: number[]): void {
		const w = this.width;
		const out = y * w * 3;
		for (let c = 0; c < 3; c++) {
			const s = sigmas[c];
			if (s < 1.5) {
				for (let x = 0; x < w; x++) this.rgb[out + x * 3 + c] = this.rawAt(x, y, c);
				continue;
			}
			const clicks = s >= 30;
			const nv = 2 * s * s; // twice the measured noise: the FM noise is not white
			const win = new Float64Array(3 * w);
			for (let x = 0; x < w; x++) for (let dy = -1; dy <= 1; dy++) win[x * 3 + dy + 1] = this.value(x, y + dy, c, s, clicks);
			for (let x = 0; x < w; x++) {
				let sum = 0;
				let sum2 = 0;
				for (let dx = -1; dx <= 1; dx++) {
					const xx = Math.max(0, Math.min(w - 1, x + dx));
					for (let dy = 0; dy < 3; dy++) {
						const v = win[xx * 3 + dy];
						sum += v;
						sum2 += v * v;
					}
				}
				const mu = sum / 9;
				const variance = Math.max(0, sum2 / 9 - mu * mu);
				const g = variance > 1e-9 ? Math.max(0, variance - nv) / variance : 0;
				this.rgb[out + x * 3 + c] = clamp8(mu + g * (win[x * 3 + 1] - mu));
			}
		}
	}

	/** Raw rows below `final` will not change: count them into the noise measure, then filter what has its rows around it. */
	filterRows(final: number, all: boolean): void {
		for (; this.lapRows + 1 < final; this.lapRows++) if (this.lapRows >= 1) this.countLaplacian(this.lapRows);
		const upTo = all ? this.rows : this.lapRows < 8 ? 0 : Math.min(final - 1, this.rows);
		const sigmas = [0, 1, 2].map((c) => (this.noiseFilter ? this.noiseSigma(c) : 0));
		for (; this.filtRows < upTo; this.filtRows++) this.filterRow(this.filtRows, sigmas);
		// Rows not filtered yet are shown raw.
		const w3 = this.width * 3;
		this.rgb.set(this.raw.subarray(this.filtRows * w3, this.rows * w3), this.filtRows * w3);
	}

	/** First row that may have changed since rows were last reported. */
	get filteredRows(): number {
		return this.filtRows;
	}
}
