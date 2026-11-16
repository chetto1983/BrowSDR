// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/mesh/mesh_lora_demod.cpp (ChanBuf: the channel history with
// absolute indices; ChipStream: the channel resampled once at the chip rate with a cubic interpolator, shared by every
// spreading factor of the channel), https://github.com/adswill/OnAir; see third_party/onair. Changes: split real and
// imaginary Float32Arrays that grow by doubling and move their live part down instead of erasing from vectors.

/** A growable pair of float arrays with absolute indices: element i lives at re[i - base]. */
class SplitHistory {
	re = new Float32Array(1 << 15);
	im = new Float32Array(1 << 15);
	base = 0;
	length = 0;

	get end(): number {
		return this.base + this.length;
	}

	/** Room for `more` elements after the current end. */
	protected reserve(more: number): void {
		const need = this.length + more;
		if (need <= this.re.length) return;
		let size = this.re.length;
		while (size < need) size *= 2;
		const re = new Float32Array(size);
		const im = new Float32Array(size);
		re.set(this.re.subarray(0, this.length));
		im.set(this.im.subarray(0, this.length));
		this.re = re;
		this.im = im;
	}

	/** Forgets the elements before keep (rarely: only when the dead part is large). */
	protected drop(keep: number, minimum: number): void {
		if (keep <= this.base) return;
		const drop = Math.min(keep - this.base, this.length);
		if (drop < minimum && drop * 4 < this.length) return;
		this.re.copyWithin(0, drop, this.length);
		this.im.copyWithin(0, drop, this.length);
		this.length -= drop;
		this.base += drop;
	}

	clear(base = 0): void {
		this.base = base;
		this.length = 0;
	}
}

/** History of a channel's samples with absolute indices. */
export class ChanBuf extends SplitHistory {
	get begin(): number {
		return this.base;
	}

	/** Appends `count` complex samples of interleaved I/Q from `iq[offset]`. */
	append(iq: Float32Array, offset: number, count: number): void {
		this.reserve(count);
		const re = this.re,
			im = this.im;
		let o = this.length;
		for (let k = 0, j = offset; k < count; k++, j += 2, o++) {
			const r = iq[j],
				i = iq[j + 1];
			// NaN or infinity from a broken source: a zero sample
			const ok = r - r === 0 && i - i === 0;
			re[o] = ok ? r : 0;
			im[o] = ok ? i : 0;
		}
		this.length = o;
	}

	trim(keepFrom: number): void {
		this.drop(keepFrom, 1 << 15);
	}
}

/** Cubic (Lagrange) interpolator weights for 257 fractional positions. */
const CUBIC = (() => {
	const v = new Float32Array(257 * 4);
	for (let r = 0; r <= 256; r++) {
		const f = r / 256;
		v[r * 4] = (-f * (f - 1) * (f - 2)) / 6;
		v[r * 4 + 1] = ((f + 1) * (f - 1) * (f - 2)) / 2;
		v[r * 4 + 2] = (-(f + 1) * f * (f - 2)) / 2;
		v[r * 4 + 3] = ((f + 1) * f * (f - 1)) / 6;
	}
	return v;
})();

/** The channel resampled at the chip rate (chip m sits at channel sample m x rho): every spreading factor searches on it. */
export class ChipStream extends SplitHistory {
	constructor(readonly rho: number) {
		super();
	}

	get begin(): number {
		return this.base;
	}

	/** Appends the chips the buffer holds enough samples for (chip m needs samples floor(m rho) - 1 .. floor(m rho) + 2). */
	extend(b: ChanBuf): void {
		const rho = this.rho;
		let m = this.end;
		if (this.length === 0) {
			const first = Math.ceil((b.begin + 2) / rho);
			if (first > m) this.base = m = first;
		} else if (m * rho - 2 < b.begin) {
			// the buffer dropped what the next chip needs: restart there
			this.length = 0;
			this.base = m = Math.ceil((b.begin + 2) / rho);
		}
		const lastPos = b.end - 4;
		if (m * rho > lastPos) return;
		const mEnd = Math.floor(lastPos / rho);
		if (mEnd < m) return;
		const n = mEnd - m + 1;
		this.reserve(n);
		const re = this.re,
			im = this.im,
			xr = b.re,
			xi = b.im,
			bb = b.base;
		const r0 = this.length;
		for (let i = 0; i < n; i++) {
			const p = (m + i) * rho;
			const n0 = Math.floor(p);
			const w = Math.floor((p - n0) * 256 + 0.5) * 4;
			const x = n0 - 1 - bb;
			re[r0 + i] = CUBIC[w] * xr[x] + CUBIC[w + 1] * xr[x + 1] + CUBIC[w + 2] * xr[x + 2] + CUBIC[w + 3] * xr[x + 3];
			im[r0 + i] = CUBIC[w] * xi[x] + CUBIC[w + 1] * xi[x + 1] + CUBIC[w + 2] * xi[x + 2] + CUBIC[w + 3] * xi[x + 3];
		}
		this.length = r0 + n;
	}

	/** Forgets the chips before this channel sample. */
	trimToSample(keepSample: number): void {
		this.drop(Math.floor(keepSample / this.rho), 1 << 14);
	}
}
