import { describe, expect, it } from 'vitest';
import { SSTV_MODES } from '@/worker/decoders/digimode/sstv/modes';
import { SstvReceiver } from '@/worker/decoders/digimode/sstv/receiver';
import { SstvFmDecoder, SstvUsbDecoder, SSTV_FM_RATE, SSTV_USB_OFFSET_HZ } from '@/worker/decoders/digimode/sstv';
import { barAt } from './sstv-fixtures';
import { sstvPhase } from './sstv-fixtures';
import { noise } from './fixtures';

const mode = (name) => SSTV_MODES.find((spec) => spec.name === name);

/** The last picture's rows assembled from the reported ranges. */
function collect() {
	const state = { picture: null, rgb: null, width: 0, rows: 0, completes: 0 };
	const onRows = (rows) => {
		if (state.picture !== rows.picture) {
			state.picture = rows.picture;
			state.width = rows.spec.width;
			state.rgb = new Uint8Array(rows.spec.width * rows.spec.height * 3);
		}
		state.rgb.set(rows.rgb, rows.from * state.width * 3);
		state.rows = Math.max(state.rows, rows.to);
		if (rows.complete) state.completes++;
	};
	return { state, onRows };
}

/** Each bar's centre on `row` within `tolerance` levels. */
function expectBars(state, row, tolerance) {
	for (let bar = 0; bar < 8; bar++) {
		const x = Math.floor(((bar + 0.5) * state.width) / 8);
		const at = (row * state.width + x) * 3;
		const got = [...state.rgb.subarray(at, at + 3)];
		const want = barAt(x, state.width);
		got.forEach((value, c) =>
			expect(Math.abs(value - want[c]), `bar ${bar} colour ${c}: ${got} vs ${want}`).toBeLessThanOrEqual(tolerance),
		);
	}
}

describe('SSTV decoder', () => {
	it('decodes a Robot 36 picture from its VIS header', () => {
		const { state, onRows } = collect();
		const receiver = new SstvReceiver(onRows);
		const phase = sstvPhase(mode('Robot 36'));
		receiver.process(Float32Array.from(phase, Math.cos));
		expect(receiver.lastMode).toBe('Robot 36');
		expect(state.completes).toBe(1);
		expect(state.rows).toBe(240);
		expectBars(state, 120, 12);
	});
	it('starts a Martin M2 picture from the line sync alone', () => {
		const { state, onRows } = collect();
		const receiver = new SstvReceiver(onRows);
		receiver.process(Float32Array.from(sstvPhase(mode('Martin M2'), { vis: false, lines: 60 }), Math.cos));
		expect(receiver.lastMode).toBe('Martin M2');
		expect(state.rows).toBeGreaterThan(40);
		expectBars(state, 30, 12);
	});
	it('decodes ISS-style FM with a 600 Hz carrier error and noise', () => {
		const records = [];
		const { state, onRows } = collect();
		const decoder = new SstvFmDecoder({
			record: (r) => records.push(r),
			status: () => {},
			image: (rows) => onRows({ ...rows, spec: { width: rows.width, height: 256 }, complete: false, final: false }),
		});
		const audio = sstvPhase(mode('Martin M2'), { rate: SSTV_FM_RATE, lines: 80 });
		const random = noise(3);
		const iq = new Float32Array(audio.length * 2);
		let carrier = 0;
		for (let n = 0; n < audio.length; n++) {
			carrier += (2 * Math.PI * (600 + 3000 * Math.cos(audio[n]))) / SSTV_FM_RATE;
			iq[2 * n] = Math.cos(carrier) + 0.3 * random();
			iq[2 * n + 1] = Math.sin(carrier) + 0.3 * random();
		}
		for (let i = 0; i < iq.length; i += 4800) decoder.process(iq.subarray(i, Math.min(iq.length, i + 4800)));
		expect(state.rows).toBeGreaterThan(60);
		expectBars(state, 40, 20);
	});
	it('decodes the upper sideband 80 Hz off tune', () => {
		const records = [];
		const { state, onRows } = collect();
		const decoder = new SstvUsbDecoder({
			record: (r) => records.push(r),
			status: () => {},
			image: (rows) => onRows({ ...rows, spec: { width: rows.width, height: 240 }, complete: false, final: false }),
		});
		const phase = sstvPhase(mode('Robot 36'), { toneOffsetHz: 80 });
		const iq = new Float32Array(phase.length * 2);
		for (let n = 0; n < phase.length; n++) {
			const p = phase[n] - (2 * Math.PI * SSTV_USB_OFFSET_HZ * n) / 8000;
			iq[2 * n] = Math.cos(p);
			iq[2 * n + 1] = Math.sin(p);
		}
		for (let i = 0; i < iq.length; i += 1600) decoder.process(iq.subarray(i, Math.min(iq.length, i + 1600)));
		expect(records.map((r) => r.text)).toEqual(['SSTV Robot 36 picture received']);
		expectBars(state, 100, 12);
	});
});
