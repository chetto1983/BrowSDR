import { describe, expect, it } from 'vitest';
import { selectRows } from '@/worker/decoders/meteor/rows';

const WIDTH = 1568;

/** A stand-in decoder: channel c has `rows[c]` finished rows of value 10 + c, and APID `apids[c]`. */
function fakeDecoder(rows, apids, garbage = 99) {
	const max = Math.max(...rows);
	const buffers = rows.map((count, c) => {
		const buffer = new Uint8Array(max * WIDTH).fill(garbage); // past its own rows: whatever memory holds
		buffer.fill(10 + c, 0, count * WIDTH);
		return buffer;
	});
	return {
		width: () => WIDTH,
		rows: () => max,
		channelRows: (c) => rows[c],
		channel: (c) => buffers[c],
		apid: (c) => apids[c],
	};
}
const rowValue = (rows, c, row) => rows.channels[c][(row - rows.from) * WIDTH];

describe('choosing the image rows to send', () => {
	it('sends rows every active channel has finished', () => {
		const rows = selectRows(fakeDecoder([24, 16, 24], [66, 65, 64]), 0);
		expect([rows.from, rows.to]).toEqual([0, 16]);
		expect([0, 1, 2].map((c) => rowValue(rows, c, 15))).toEqual([10, 11, 12]);
	});
	it('sends zeros for a channel without an APID instead of reading its memory', () => {
		const rows = selectRows(fakeDecoder([24, 0, 24], [66, -1, 64]), 0);
		expect([rows.from, rows.to]).toEqual([0, 24]);
		expect(rows.channels[1].every((value) => value === 0)).toBe(true);
	});
	it('keeps the image moving when one channel stalls, with zeros past its last row', () => {
		const rows = selectRows(fakeDecoder([16, 400, 400], [66, 65, 64]), 0);
		expect(rows.to).toBe(400);
		expect(rowValue(rows, 0, 15)).toBe(10);
		expect(rowValue(rows, 0, 16)).toBe(0);
		expect(rowValue(rows, 1, 399)).toBe(11);
	});
	it('sends nothing new when nothing advanced', () => {
		expect(selectRows(fakeDecoder([16, 16, 16], [66, 65, 64]), 16)).toBeUndefined();
		expect(selectRows(fakeDecoder([0, 0, 0], [-1, -1, -1]), 0)).toBeUndefined();
	});
});
