// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/marine/marine_fax.cpp (the decoder's picture, FaxImage, and the
// row moves of applyManual and alignLines), https://github.com/adswill/OnAir; see third_party/onair. Changes: rows
// changed after they were written are marked, so that they can be sent again; a new picture gets a new number.

/** The weather fax picture being received: grey rows, 0 black .. 255 white. */
export class FaxPicture {
	/** Changes when a picture starts or is cleared. */
	id = 0;
	width = 0;
	rows = 0;
	/** Lowest row changed after it was written (slant, roll); Infinity when none. */
	dirtyFrom = Infinity;
	private data = new Uint8Array(0);
	private tmp = new Uint8Array(0);

	start(width: number): void {
		this.id++;
		this.width = width;
		this.rows = 0;
		this.dirtyFrom = Infinity;
	}

	clear(): void {
		this.start(0);
	}

	append(row: Uint8Array): void {
		const need = (this.rows + 1) * this.width;
		if (need > this.data.length) {
			const grown = new Uint8Array(Math.max(need, 2 * this.data.length, 64 * this.width));
			grown.set(this.data.subarray(0, this.rows * this.width));
			this.data = grown;
		}
		this.data.set(row.subarray(0, this.width), this.rows * this.width);
		this.rows++;
	}

	truncate(rows: number): void {
		this.rows = Math.min(this.rows, Math.max(0, rows));
	}

	row(r: number): Uint8Array {
		return this.data.subarray(r * this.width, (r + 1) * this.width);
	}

	/** The line period changed: row r of the first `count` moves by r * `perRow` pixels (cyclic, interpolated). */
	shiftRows(count: number, perRow: number): void {
		const w = this.width;
		const tmp = this.scratch();
		for (let r = 1; r < count; r++) {
			const row = this.row(r);
			const sh = r * perRow;
			for (let j = 0; j < w; j++) {
				let x = (j + sh) % w;
				if (x < 0) x += w;
				let i0 = Math.trunc(x);
				const fr = x - i0;
				if (i0 >= w) i0 -= w;
				const i1 = i0 + 1 === w ? 0 : i0 + 1;
				tmp[j] = Math.round(row[i0] * (1 - fr) + row[i1] * fr);
			}
			row.set(tmp);
		}
		this.touched(1);
	}

	/** Every row of the first `count` rolls left by `by` pixels. */
	roll(count: number, by: number): void {
		const w = this.width;
		const tmp = this.scratch();
		for (let r = 0; r < count; r++) {
			const row = this.row(r);
			for (let x = 0; x < w; x++) tmp[x] = row[(x + by) % w];
			row.set(tmp);
		}
		this.touched(0);
	}

	/** Rows from `from` on were changed in place. */
	touched(from: number): void {
		this.dirtyFrom = Math.min(this.dirtyFrom, from);
	}

	private scratch(): Uint8Array {
		if (this.tmp.length !== this.width) this.tmp = new Uint8Array(this.width);
		return this.tmp;
	}
}
