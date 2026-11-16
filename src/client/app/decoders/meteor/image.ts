import type { MeteorRows } from '@/worker/decoders/meteor/types';

const WIDTH = 1568;
const GREY = 128;
const GROW_ROWS = 512;
/** Grey rows between the picture so far and the rows of a decoder that started over. */
const RESTART_GAP_ROWS = 8;

/**
 * A Meteor AVHRR picture assembled from the worker's row ranges: three composite channels (red, green,
 * blue as meteor_decode assigns them). Rows the worker skipped are grey.
 */
export class MeteorImage {
	rows = 0;
	readonly width = WIDTH;
	/** The downlink this picture was received on; the panel starts a new picture when it changes. */
	freq: number | undefined;
	private channels: [Uint8Array, Uint8Array, Uint8Array] = [new Uint8Array(0), new Uint8Array(0), new Uint8Array(0)];
	/** Where the current decoder's row 0 sits in the picture. */
	private offset = 0;

	/**
	 * Adds a decoder's row range. A range that starts before rows this decoder already sent means the
	 * decoder started over (the stream restarted mid-pass): its rows go below the picture, after a grey band.
	 */
	append(rows: MeteorRows): void {
		if (rows.width !== WIDTH || rows.to <= rows.from) return;
		if (rows.from < this.rows - this.offset) this.offset = this.rows + RESTART_GAP_ROWS;
		const from = this.offset + rows.from;
		const to = this.offset + rows.to;
		this.reserve(to);
		for (let c = 0; c < 3; c++) {
			const channel = this.channels[c];
			channel.fill(GREY, this.rows * WIDTH, from * WIDTH);
			channel.set(rows.channels[c], from * WIDTH);
		}
		this.rows = to;
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
		this.offset = 0;
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
