import type { DigimodeImageRows } from '@/worker/decoders/digimode/types';

const GROW_ROWS = 256;

/** The picture a decoder is building (SSTV, fax), kept outside Vue reactivity. */
export class DigimodePicture {
	picture = -1;
	title = '';
	width = 0;
	rows = 0;
	private rgb = new Uint8Array(0);

	append(rows: DigimodeImageRows): void {
		if (rows.picture !== this.picture || rows.width !== this.width) {
			this.picture = rows.picture;
			this.width = rows.width;
			this.rows = 0;
			this.rgb = new Uint8Array(0);
		}
		this.title = rows.title;
		const need = rows.to * this.width * 3;
		if (need > this.rgb.length) {
			const grown = new Uint8Array((Math.ceil(rows.to / GROW_ROWS) + 1) * GROW_ROWS * this.width * 3);
			grown.set(this.rgb);
			this.rgb = grown;
		}
		this.rgb.set(rows.rgb, rows.from * this.width * 3);
		this.rows = Math.max(this.rows, rows.to);
	}

	/** RGBA pixels of the rows received so far. */
	rgba(): Uint8ClampedArray<ArrayBuffer> {
		const pixels = this.rows * this.width;
		const out = new Uint8ClampedArray(pixels * 4);
		for (let p = 0; p < pixels; p++) {
			out[p * 4] = this.rgb[p * 3];
			out[p * 4 + 1] = this.rgb[p * 3 + 1];
			out[p * 4 + 2] = this.rgb[p * 3 + 2];
			out[p * 4 + 3] = 255;
		}
		return out;
	}
}
