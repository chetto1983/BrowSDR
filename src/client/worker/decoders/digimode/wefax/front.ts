// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/marine/marine_fax.cpp (FaxDecoder front end: DC blocker, mixer,
// low passes, FM discriminator, running sums of the measured frequency), https://github.com/adswill/OnAir; see
// third_party/onair. Changes: complex values as separate re/im numbers; the running sums live in typed arrays that grow
// and are trimmed in place.

export const FAX_BLACK_HZ = 1500;
export const FAX_WHITE_HZ = 2300;
export const FAX_CENTRE_HZ = 1900;

function bessel0(x: number): number {
	let s = 1;
	let t = 1;
	for (let k = 1; k < 40; k++) {
		t *= (x / (2 * k)) * (x / (2 * k));
		s += t;
		if (t < 1e-12 * s) break;
	}
	return s;
}

/** Kaiser-windowed low pass (beta 5.65, about 60 dB), `n` taps, unity gain. */
function design(n: number, cutHz: number, fs: number): Float64Array<ArrayBuffer> {
	const fc = cutHz / fs;
	const h = new Float64Array(n);
	const beta = 5.65;
	let sum = 0;
	for (let i = 0; i < n; i++) {
		const m = i - (n - 1) / 2;
		const sinc = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
		const r = (2 * i) / (n - 1) - 1;
		h[i] = (sinc * bessel0(beta * Math.sqrt(Math.max(0, 1 - r * r)))) / bessel0(beta);
		sum += h[i];
	}
	for (let i = 0; i < n; i++) h[i] /= sum;
	return h;
}

/** A discriminator path: last sample, mean power, last frequency. */
class Discriminator {
	zr = 0;
	zi = 0;
	avgPow = 0;
	prevF = FAX_CENTRE_HZ;

	reset(): void {
		this.zr = this.zi = this.avgPow = 0;
		this.prevF = FAX_CENTRE_HZ;
	}

	/** FM discriminator; holds the last value in a fade or gap instead of passing noise on. */
	step(yr: number, yi: number, alphaPow: number, fs: number): number {
		const pw = yr * yr + yi * yi;
		this.avgPow += (pw - this.avgPow) * alphaPow;
		const dr = yr * this.zr + yi * this.zi;
		const di = yi * this.zr - yr * this.zi;
		let f: number;
		if (Math.sqrt(dr * dr + di * di) <= 0.002 * this.avgPow || pw < 1e-14) f = this.prevF;
		else f = FAX_CENTRE_HZ + (Math.atan2(di, dr) * fs) / (2 * Math.PI);
		this.zr = yr;
		this.zi = yi;
		f = Math.min(2550, Math.max(1250, f));
		this.prevF = f;
		return f;
	}
}

/**
 * Audio -> complex baseband around 1900 Hz -> low pass -> instantaneous frequency f in Hz, kept as running sums so that
 * the mean over any fractional interval costs two look-ups. cum[i] = sum of f over samples [0, base + i); sample n
 * covers [n - 0.5, n + 0.5).
 */
export class FaxFront {
	fs = 12000;
	/** Samples seen so far (= number of f values). */
	nAud = 0;
	base = 0;
	/** f smoothed over smD samples (fAt). */
	readonly smD = 8;
	private taps = new Float64Array(1);
	private tapsW = new Float64Array(1);
	private dlR = new Float64Array(1);
	private dlI = new Float64Array(1);
	private dlPos = 0;
	private rotR = 1;
	private rotI = 0;
	private oscR = 1;
	private oscI = 0;
	private oscCount = 0;
	private dcX = 0;
	private dcY = 0;
	private dcR = 0.99;
	private alphaPow = 0;
	private readonly narrow = new Discriminator();
	private readonly wide = new Discriminator();
	private cum = new Float64Array(1024);
	private cum2 = new Float64Array(1024);
	private cumW = new Float64Array(1024);
	private len = 1;

	configure(fs: number): void {
		this.fs = fs;
		// Low passes around the 1900 Hz carrier, both of the narrow one's length so they have the same delay. Narrow:
		// passband to about 1000 Hz, stopband from 1600 Hz (less noise into the discriminator near its threshold). Wide:
		// passband to about 1400 Hz (the sharper picture of a strong signal).
		const n = Math.ceil((3.62 * fs) / 600) | 1;
		this.taps = design(n, 1300, fs);
		this.tapsW = design(n, 2000, fs);
		this.dlR = new Float64Array(n);
		this.dlI = new Float64Array(n);
		this.rotR = Math.cos((-2 * Math.PI * FAX_CENTRE_HZ) / fs);
		this.rotI = Math.sin((-2 * Math.PI * FAX_CENTRE_HZ) / fs);
		this.alphaPow = 1 / (0.05 * fs);
		this.dcR = 1 - (2 * Math.PI * 20) / fs;
	}

	reset(): void {
		this.dlR.fill(0);
		this.dlI.fill(0);
		this.dlPos = 0;
		this.oscR = 1;
		this.oscI = 0;
		this.oscCount = 0;
		this.narrow.reset();
		this.wide.reset();
		this.dcX = this.dcY = 0;
		this.cum[0] = this.cum2[0] = this.cumW[0] = 0;
		this.len = 1;
		this.base = 0;
		this.nAud = 0;
	}

	/** DC blocker (about 20 Hz): radios and sound cards leave an offset that would sit on the carrier after mixing. */
	dcBlock(xin: number): number {
		const xd = xin - this.dcX + this.dcR * this.dcY;
		this.dcX = xin;
		this.dcY = xd;
		return Math.fround(xd);
	}

	/** One DC-blocked sample: mix, low pass, discriminate, append to the history. Returns f (narrow filter). */
	step(x: number): number {
		const or = this.oscR * this.rotR - this.oscI * this.rotI;
		this.oscI = this.oscR * this.rotI + this.oscI * this.rotR;
		this.oscR = or;
		if (++this.oscCount >= 4096) {
			this.oscCount = 0;
			const g = 1 / Math.hypot(this.oscR, this.oscI);
			this.oscR *= g;
			this.oscI *= g;
		}
		const n = this.taps.length;
		this.dlR[this.dlPos] = this.oscR * x;
		this.dlI[this.dlPos] = this.oscI * x;
		let yr = 0;
		let yi = 0;
		let wr = 0;
		let wi = 0;
		let idx = this.dlPos;
		for (let i = 0; i < n; i++) {
			const [t, tw, vr, vi] = [this.taps[i], this.tapsW[i], this.dlR[idx], this.dlI[idx]];
			yr += t * vr;
			yi += t * vi;
			wr += tw * vr;
			wi += tw * vi;
			idx = idx === 0 ? n - 1 : idx - 1;
		}
		if (++this.dlPos === n) this.dlPos = 0;
		const f = this.narrow.step(yr, yi, this.alphaPow, this.fs);
		const fw = this.wide.step(wr, wi, this.alphaPow, this.fs);
		this.append(f, fw);
		this.nAud++;
		return f;
	}

	/** Drops history older than 12 s (the free-running line search looks back 7 lines, 7 s at 60 lpm) once twice that is kept. */
	trim(): void {
		const keep = Math.trunc(12 * this.fs) + 16;
		if (this.len <= 2 * keep) return;
		const drop = this.len - keep;
		const [o1, o2, o3] = [this.cum[drop], this.cum2[drop], this.cumW[drop]]; // keep the sums small
		for (const [c, o] of [
			[this.cum, o1],
			[this.cum2, o2],
			[this.cumW, o3],
		] as const) {
			c.copyWithin(0, drop, this.len);
			for (let i = 0; i < keep; i++) c[i] -= o;
		}
		this.len = keep;
		this.base += drop;
	}

	/** Sum of f (the wide filter's with `wide`) from the start of the history up to time x (fractional samples). */
	integ(x: number, wide = false): number {
		const c = wide ? this.cumW : this.cum;
		return this.integIn(c, x);
	}

	meanF(a: number, b: number): number {
		return (this.integIn(this.cum, b) - this.integIn(this.cum, a)) / (b - a);
	}

	meanF2(a: number, b: number): number {
		return (this.integIn(this.cum2, b) - this.integIn(this.cum2, a)) / (b - a);
	}

	/** f smoothed over smD samples (the discriminator noise is mostly at the top of its band); n .. n + smD - 1 must be kept. */
	fAt(n: number): number {
		return (this.cum[n + this.smD - this.base] - this.cum[n - this.base]) / this.smD;
	}

	private integIn(c: Float64Array, x: number): number {
		const y = x + 0.5;
		let m = Math.floor(y);
		let fr = y - m;
		if (m < this.base) {
			m = this.base;
			fr = 0;
		}
		if (m >= this.nAud) return c[this.len - 1];
		const a = c[m - this.base];
		return a + fr * (c[m + 1 - this.base] - a);
	}

	private append(f: number, fw: number): void {
		if (this.len >= this.cum.length) {
			// Trimmed at twice the 12 s kept, so a second more than that is enough room unless the blocks are huge.
			const enough = 2 * (Math.trunc(12 * this.fs) + 16) + Math.ceil(this.fs);
			const size = this.cum.length < enough ? Math.min(2 * this.cum.length, enough) : 2 * this.cum.length;
			for (const key of ['cum', 'cum2', 'cumW'] as const) {
				const grown = new Float64Array(size);
				grown.set(this[key]);
				this[key] = grown;
			}
		}
		const i = this.len++;
		this.cum[i] = this.cum[i - 1] + f;
		this.cum2[i] = this.cum2[i - 1] + f * f;
		this.cumW[i] = this.cumW[i - 1] + fw;
	}
}
