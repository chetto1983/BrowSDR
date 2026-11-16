import type { MeteorRows } from '@/worker/decoders/meteor/types';

const WIDTH = 1568;
const GREY = 128;
const GROW_ROWS = 512;

/**
 * A Meteor AVHRR picture assembled from the worker's row ranges: three composite channels (red, green,
 * blue as meteor_decode assigns them). Rows the worker skipped are grey.
 */
export class MeteorImage {
	rows = 0;
	readonly width = WIDTH;
	private channels: [Uint8Array, Uint8Array, Uint8Array] = [new Uint8Array(0), new Uint8Array(0), new Uint8Array(0)];

	append(rows: MeteorRows): void {
		if (rows.width !== WIDTH || rows.to <= this.rows) return;
		const from = Math.max(rows.from, this.rows);
		this.reserve(rows.to);
		for (let c = 0; c < 3; c++) {
			const channel = this.channels[c];
			channel.fill(GREY, this.rows * WIDTH, from * WIDTH);
			channel.set(rows.channels[c].subarray((from - rows.from) * WIDTH), from * WIDTH);
		}
		this.rows = rows.to;
	}

	/** RGBA pixels: the colour composite, or one channel (0-2) as grey levels. */
	rgba(view: 'rgb' | 0 | 1 | 2): Uint8ClampedArray<ArrayBuffer> {
		const pixels = this.rows * WIDTH;
		const out = new Uint8ClampedArray(pixels * 4);
		const [r, g, b] = view === 'rgb' ? this.channels : [this.channels[view], this.channels[view], this.channels[view]];
		for (let p = 0, o = 0; p < pixels; p++, o += 4) {
			out[o] = r[p];
			out[o + 1] = g[p];
			out[o + 2] = b[p];
			out[o + 3] = 255;
		}
		return out;
	}

	reset(): void {
		this.rows = 0;
		this.channels = [new Uint8Array(0), new Uint8Array(0), new Uint8Array(0)];
	}

	private reserve(rows: number): void {
		if (this.channels[0].length >= rows * WIDTH) return;
		const capacity = (Math.ceil(rows / GROW_ROWS) * GROW_ROWS + GROW_ROWS) * WIDTH;
		this.channels = this.channels.map((old) => {
			const grown = new Uint8Array(capacity);
			grown.set(old);
			return grown;
		}) as [Uint8Array, Uint8Array, Uint8Array];
	}
}
