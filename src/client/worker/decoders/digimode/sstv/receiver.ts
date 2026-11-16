// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/hfdig/hfdig_sstv.cpp (HfdigSstv receiving: startRx,
// advanceRx, detectSync, measureNoise, scan, extractLine, finish), https://github.com/adswill/OnAir;
// see third_party/onair. Changes: rows are reported through a callback instead of telemetry snapshots.
//
// Each line's sync pulse is searched near where the previous ones predict it; a straight line fitted through the
// line start times gives the line period of the sender against this clock (the slant) and the position of each line.
// A line is cut into pixels when its time has passed; a 7-pixel local Wiener filter along the line uses the tone
// noise measured on the sync pulses.

import { clamp8, yuvToRgb } from './modes';
import type { LineFit, SstvComponent, SstvRows, SstvScan, SstvSpec } from './types';

export type { SstvRows } from './types';
import { BOX, CENTER_HZ, MS, PhaseFront } from './phase';
import { SstvPicture } from './picture';
import { VisHunter } from './vis';

/** Picture state of one reception. */
class Reception {
	readonly periodS: number;
	readonly picture: SstvPicture;
	detect = 0;
	extract = 0;
	fit: LineFit = { n: 0, sk: 0, sc: 0, skk: 0, skc: 0, a: 0, b: 0 };
	missed = 0;
	slantPpm = 0;
	/** Variance (Hz²) of the mean tone over noiseL samples inside the sync pulses. */
	noiseHz2 = -1;
	noiseL = 0;
	/** Robot 36: luma and R-Y of the even line waiting for its B-Y. */
	pendingY: number[] = [];
	pendingRy: number[] = [];
	pendingLine = -1;
	/** Rows sent so far, and how many of them had been through the picture filter then. */
	reported = 0;
	lastFiltered = 0;

	constructor(
		readonly spec: SstvSpec,
		readonly vis: boolean,
		readonly c0: number,
		public off: number,
		readonly id: number,
		noiseFilter: boolean,
	) {
		this.periodS = spec.lineMs * MS;
		this.picture = new SstvPicture(spec.width, spec.height, noiseFilter);
	}

	ratio(): number {
		return this.fit.n >= 8 && this.fit.b > 0 ? this.fit.b / this.periodS : 1;
	}

	/** Where line k starts (samples). */
	lineStart(k: number): number {
		if (this.fit.n === 0) return this.c0 + k * this.periodS;
		if (this.fit.n >= 8 && this.fit.b > 0) return this.c0 + this.fit.a + this.fit.b * k;
		return this.c0 + this.fit.a + k * this.periodS; // too few lines for the slope: offset only
	}

	/** Adds a measured line start and refits the line period (bounded to ±2 %). */
	addStart(k: number, start: number): void {
		const f = this.fit;
		const cc = start - this.c0;
		f.n++;
		f.sk += k;
		f.sc += cc;
		f.skk += k * k;
		f.skc += k * cc;
		const den = f.n * f.skk - f.sk * f.sk;
		if (f.n >= 8 && den > 1e-9) {
			f.b = Math.max(0.98 * this.periodS, Math.min(1.02 * this.periodS, (f.n * f.skc - f.sk * f.sc) / den));
			f.a = (f.sc - f.b * f.sk) / f.n;
			this.slantPpm = (f.b / this.periodS - 1) * 1e6;
		} else f.a = (f.sc - this.periodS * f.sk) / f.n;
	}
}

let nextPicture = 1;

export class SstvReceiver {
	readonly front = new PhaseFront();
	private readonly hunter = new VisHunter(this.front, (spec, vis, c0, off) => this.startRx(spec, vis, c0, off));
	private rx: Reception | null = null;
	/** The last picture's mode, for the status line. */
	lastMode = '';

	constructor(
		private readonly onRows: (rows: SstvRows) => void,
		private readonly noiseFilter = true,
	) {}

	get receiving(): Reception | null {
		return this.rx;
	}

	reset(): void {
		this.front.reset();
		this.hunter.reset();
		this.rx = null;
	}

	process(audio: Float32Array): void {
		for (const x of audio) {
			this.front.push(x);
			if (this.front.n < BOX + 2) continue;
			if (this.rx) this.advance(this.rx);
			else this.hunter.step();
		}
	}

	private startRx(spec: SstvSpec, vis: boolean, c0: number, off: number): void {
		this.rx = new Reception(spec, vis, c0, off, nextPicture++, this.noiseFilter);
		this.lastMode = spec.name;
	}

	private advance(rx: Reception): void {
		const sp = rx.spec;
		const now = this.front.n - 2;
		for (;;) {
			const r = rx.ratio();
			if (rx.detect < sp.totalLines) {
				const hw = (rx.detect === 0 && rx.vis ? 40 : 10) * MS;
				const s = rx.lineStart(rx.detect) + sp.syncOffMs * MS * r;
				if (now >= s + hw + sp.syncMs * MS + 4) {
					this.detectSync(rx, rx.detect, s, hw);
					rx.detect++;
					if (this.rx !== rx) return;
					continue;
				}
			}
			if (rx.extract < rx.detect && rx.extract < sp.totalLines && now >= rx.lineStart(rx.extract) + rx.periodS * r + 8) {
				this.extractLine(rx, rx.extract);
				rx.extract++;
				if (rx.extract >= sp.totalLines) return this.finish(rx, true);
				continue;
			}
			break;
		}
	}

	/** The lowest mean tone over a window as wide as the pulse, within ±hw of the prediction. */
	private findPulse(rx: Reception, k: number, sPred: number, hw: number): { tb: number; mv: number } {
		const w = rx.spec.syncMs * MS;
		const afterVis = k === 0 && rx.vis;
		const lo = afterVis ? sPred - 4 * MS : sPred - hw; // after a VIS header the data bits must stay out (1100 Hz)
		const steps = Math.trunc(sPred + hw - lo);
		const m = new Float64Array(steps + 1);
		let best = 0;
		for (let j = 0; j <= steps; j++) {
			m[j] = this.front.meanF(lo + j, lo + j + w);
			if (m[j] < m[best]) best = j;
		}
		// After a VIS header the stop bit (1200 Hz) runs into the sync pulse: the pulse is the box at the plateau's far end.
		if (afterVis)
			for (let j = steps; j > best; j--)
				if (m[j] <= m[best] + 8) {
					best = j;
					break;
				}
		let tb = lo + best;
		const mv = m[best];
		if (best > 0 && best < steps && !afterVis) {
			const [a, c] = [m[best - 1], m[best + 1]];
			const d = a - 2 * mv + c;
			if (d > 1e-9) tb += Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d));
		}
		return { tb, mv };
	}

	private detectSync(rx: Reception, k: number, sPred: number, hw: number): void {
		const sp = rx.spec;
		const { tb, mv } = this.findPulse(rx, k, sPred, hw);
		const cm = tb - sp.syncOffMs * MS * rx.ratio(); // measured line start
		const found = mv < 1200 + rx.off + 110 && mv > 1000;
		const gated = rx.fit.n >= 3 && Math.abs(cm - rx.lineStart(k)) > 3 * MS;
		if (!found || gated) {
			if (++rx.missed >= 12) this.finish(rx, false);
			return;
		}
		rx.missed = 0;
		this.measureNoise(rx, tb, sp.syncMs * MS);
		// No leader to measure: the sync pulse (its mean sits about 12 Hz high, the filter blurs its edges).
		if (!rx.vis) rx.off = rx.fit.n === 0 ? mv - 1200 - 12 : 0.9 * rx.off + 0.1 * (mv - 1200 - 12);
		rx.addStart(k, cm);
	}

	/** The tone noise of one pixel: windows of the shortest pixel inside the steady middle of the sync pulse. */
	private measureNoise(rx: Reception, tb: number, w: number): void {
		if (rx.noiseL <= 0) rx.noiseL = Math.min(...rx.spec.scans.map((s) => (s.lenMs / s.px) * MS));
		const len = rx.noiseL;
		let [s1, s2, k] = [0, 0, 0];
		for (let t = tb + 0.2 * w; t + len <= tb + 0.8 * w; t += len) {
			const f = this.front.meanF(t, t + len);
			s1 += f;
			s2 += f * f;
			k++;
		}
		if (k < 3) return;
		const v = Math.max(0, (s2 - (s1 * s1) / k) / (k - 1));
		rx.noiseHz2 = rx.noiseHz2 < 0 ? v : rx.noiseHz2 + 0.1 * (v - rx.noiseHz2);
	}

	private meanOver(c: number, r: number, startMs: number, lenMs: number): number {
		return this.front.meanF(c + startMs * MS * r, c + (startMs + lenMs) * MS * r);
	}

	private scan(rx: Reception, c: number, r: number, s: SstvScan): number[] {
		const valueOf = (f: number) => clamp8(((f - rx.off - 1500) * 255) / 800);
		const px = s.lenMs / s.px;
		const f = Array.from({ length: s.px }, (_, i) => this.meanOver(c, r, s.startMs + i * px, px));
		if (!this.noiseFilter || rx.noiseHz2 <= 0) return f.map(valueOf);
		// Along the line: a 7-pixel local Wiener filter with the noise of a pixel this long.
		const scale = rx.noiseL / (px * MS);
		const nv = rx.noiseHz2 * scale * scale;
		const n = s.px;
		return f.map((value, i) => {
			let [s1, s2] = [0, 0];
			for (let d = -3; d <= 3; d++) {
				const v = f[Math.max(0, Math.min(n - 1, i + d))];
				s1 += v;
				s2 += v * v;
			}
			const mu = s1 / 7;
			const variance = Math.max(0, s2 / 7 - mu * mu);
			const g = variance > 1e-9 ? Math.max(0, variance - nv) / variance : 0;
			return valueOf(mu + g * (value - mu));
		});
	}

	private extractLine(rx: Reception, k: number): void {
		const sp = rx.spec;
		const [c, r] = [rx.lineStart(k), rx.ratio()];
		const comp: Partial<Record<SstvComponent, number[]>> = {};
		for (const s of sp.scans) comp[s.comp] = this.scan(rx, c, r, s);
		const pic = rx.picture;
		const w = sp.width;
		const row = (y: number) => y * w * 3;
		if (sp.kind === 'seq') {
			for (let x = 0; x < w; x++) pic.raw.set([comp.r![x], comp.g![x], comp.b![x]], row(k) + x * 3);
			pic.rows = k + 1;
		} else if (sp.kind === 'robot72') {
			for (let x = 0; x < w; x++) yuvToRgb(comp.y![x], comp.ry![x >> 1], comp.by![x >> 1], pic.raw, row(k) + x * 3);
			pic.rows = k + 1;
		} else if (sp.kind === 'robot36') this.robot36(rx, k, c, r, comp.y!, comp.ry!);
		else {
			for (let x = 0; x < w; x++) {
				yuvToRgb(comp.y![x], comp.ry![x], comp.by![x], pic.raw, row(2 * k) + x * 3);
				yuvToRgb(comp.y2![x], comp.ry![x], comp.by![x], pic.raw, row(2 * k + 1) + x * 3);
			}
			pic.rows = 2 * (k + 1);
		}
		pic.filterRows(pic.rows - 2, false); // Robot 36 rewrites the row before; PD writes two
		this.report(rx, false);
	}

	/** Robot 36 sends R-Y on even lines and B-Y on odd ones; the separator tone says which. */
	private robot36(rx: Reception, k: number, c: number, r: number, y: number[], chroma: number[]): void {
		const sep = rx.spec.fixed[0];
		const odd = this.meanOver(c, r, sep.startMs + 0.5, sep.lenMs - 1) - rx.off > CENTER_HZ;
		const pic = rx.picture;
		const w = rx.spec.width;
		if (!odd) {
			[rx.pendingY, rx.pendingRy, rx.pendingLine] = [y, chroma, k];
			for (let x = 0; x < w; x++) yuvToRgb(y[x], chroma[x >> 1], 128, pic.raw, (k * w + x) * 3);
		} else {
			// The first line of a weak picture can read as odd: nothing is waiting then.
			const pending = rx.pendingLine >= 0 && rx.pendingLine === k - 1;
			for (let x = 0; x < w; x++) {
				const ry = pending ? rx.pendingRy[x >> 1] : 128;
				if (pending) yuvToRgb(rx.pendingY[x], ry, chroma[x >> 1], pic.raw, ((k - 1) * w + x) * 3);
				yuvToRgb(y[x], ry, chroma[x >> 1], pic.raw, (k * w + x) * 3);
			}
			rx.pendingLine = -1;
		}
		pic.rows = k + 1;
	}

	/** Sends the rows that changed since the last report. */
	private report(rx: Reception, complete: boolean, final = false): void {
		const pic = rx.picture;
		// Rows the filter rewrote since, and the rows Robot 36 and PD write in pairs.
		const from = Math.min(rx.reported, rx.lastFiltered, Math.max(0, pic.rows - 2));
		const to = pic.rows;
		rx.reported = to;
		rx.lastFiltered = pic.filteredRows;
		if (to <= from) return;
		const w3 = pic.width * 3;
		this.onRows({ picture: rx.id, spec: rx.spec, from, to, rgb: pic.rgb.slice(from * w3, to * w3), complete, final });
	}

	private finish(rx: Reception, complete: boolean): void {
		rx.picture.filterRows(rx.picture.rows, true);
		if (rx.picture.rows > 0) {
			rx.reported = rx.lastFiltered = 0; // the whole picture again, filtered
			this.report(rx, complete, true);
		}
		this.rx = null;
		this.hunter.reset();
	}
}
