// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/hfdig/hfdig_sstv_modes.h, https://github.com/adswill/OnAir;
// see third_party/onair.
// Timings are the published ones: J. L. Barber (N7CXI), "Proposal for SSTV Mode Specifications", Dayton SSTV forum,
// 2000 (Martin, Scottie, Robot, PD, VIS codes), cross-checked against MMSSTV and slowrx. Wraase SC2-180 as in slowrx.
// Tones: sync 1200 Hz, black 1500 Hz, white 2300 Hz.

import type { SstvSpec } from './types';

const spec = (s: SstvSpec) => s;

function martin(vis: number, name: string, scan: number): SstvSpec {
	// sync 4.862, porch 0.572 (1500), then green, blue, red, each followed by 0.572 of 1500
	const a = 4.862 + 0.572;
	const step = scan + 0.572;
	return spec({
		vis,
		name,
		width: 320,
		height: 256,
		lineMs: a + 3 * step,
		syncMs: 4.862,
		kind: 'seq',
		syncOffMs: 0,
		totalLines: 256,
		scans: [
			{ startMs: a, lenMs: scan, px: 320, comp: 'g' },
			{ startMs: a + step, lenMs: scan, px: 320, comp: 'b' },
			{ startMs: a + 2 * step, lenMs: scan, px: 320, comp: 'r' },
		],
		fixed: [],
	});
}

function scottie(vis: number, name: string, scan: number): SstvSpec {
	// separator 1.5 (1500), green, separator 1.5, blue, SYNC 9, porch 1.5 (1500), red
	return spec({
		vis,
		name,
		width: 320,
		height: 256,
		lineMs: 3 * scan + 13.5,
		syncMs: 9,
		kind: 'seq',
		syncOffMs: 2 * scan + 3,
		totalLines: 256,
		scans: [
			{ startMs: 1.5, lenMs: scan, px: 320, comp: 'g' },
			{ startMs: scan + 3, lenMs: scan, px: 320, comp: 'b' },
			{ startMs: 2 * scan + 13.5, lenMs: scan, px: 320, comp: 'r' },
		],
		fixed: [],
	});
}

function pd(vis: number, name: string, width: number, height: number, scan: number): SstvSpec {
	// sync 20, porch 2.08 (1500), then Y of the odd row, R-Y, B-Y, Y of the even row; two picture rows per line
	const a = 20 + 2.08;
	return spec({
		vis,
		name,
		width,
		height,
		lineMs: a + 4 * scan,
		syncMs: 20,
		kind: 'pd',
		syncOffMs: 0,
		totalLines: height / 2,
		scans: [
			{ startMs: a, lenMs: scan, px: width, comp: 'y' },
			{ startMs: a + scan, lenMs: scan, px: width, comp: 'ry' },
			{ startMs: a + 2 * scan, lenMs: scan, px: width, comp: 'by' },
			{ startMs: a + 3 * scan, lenMs: scan, px: width, comp: 'y2' },
		],
		fixed: [],
	});
}

/** The modes the decoder knows. */
export const SSTV_MODES: readonly SstvSpec[] = [
	// Robot 36: sync 9, porch 3 (1500), Y 88 ms, separator 4.5 (1500 even / 2300 odd), porch 1.5 (1900), chroma 44 ms
	spec({
		vis: 8,
		name: 'Robot 36',
		width: 320,
		height: 240,
		lineMs: 150,
		syncMs: 9,
		kind: 'robot36',
		syncOffMs: 0,
		totalLines: 240,
		scans: [
			{ startMs: 12, lenMs: 88, px: 320, comp: 'y' },
			{ startMs: 106, lenMs: 44, px: 160, comp: 'ry' },
		],
		fixed: [
			{ startMs: 100, lenMs: 4.5, hz: -1 },
			{ startMs: 104.5, lenMs: 1.5, hz: 1900 },
		],
	}),
	// Robot 72: sync 9, porch 3, Y 138 ms, separator 4.5 (1500), porch 1.5 (1900), V 69 ms, separator 4.5 (2300), porch 1.5, U 69 ms
	spec({
		vis: 12,
		name: 'Robot 72',
		width: 320,
		height: 240,
		lineMs: 300,
		syncMs: 9,
		kind: 'robot72',
		syncOffMs: 0,
		totalLines: 240,
		scans: [
			{ startMs: 12, lenMs: 138, px: 320, comp: 'y' },
			{ startMs: 156, lenMs: 69, px: 160, comp: 'ry' },
			{ startMs: 231, lenMs: 69, px: 160, comp: 'by' },
		],
		fixed: [
			{ startMs: 150, lenMs: 4.5, hz: 1500 },
			{ startMs: 154.5, lenMs: 1.5, hz: 1900 },
			{ startMs: 225, lenMs: 4.5, hz: 2300 },
			{ startMs: 229.5, lenMs: 1.5, hz: 1900 },
		],
	}),
	martin(44, 'Martin M1', 146.432),
	martin(40, 'Martin M2', 73.216),
	scottie(60, 'Scottie S1', 138.24),
	scottie(56, 'Scottie S2', 88.064),
	scottie(76, 'Scottie DX', 345.6),
	pd(93, 'PD50', 320, 256, 91.52),
	pd(99, 'PD90', 320, 256, 170.24),
	pd(95, 'PD120', 640, 496, 121.6),
	pd(97, 'PD180', 640, 496, 183.04),
	// Wraase SC2-180: sync 5.5225, porch 0.5 (1500), red, green, blue 235 ms each
	spec({
		vis: 55,
		name: 'Wraase SC2-180',
		width: 320,
		height: 256,
		lineMs: 5.5225 + 0.5 + 3 * 235,
		syncMs: 5.5225,
		kind: 'seq',
		syncOffMs: 0,
		totalLines: 256,
		scans: [
			{ startMs: 6.0225, lenMs: 235, px: 320, comp: 'r' },
			{ startMs: 241.0225, lenMs: 235, px: 320, comp: 'g' },
			{ startMs: 476.0225, lenMs: 235, px: 320, comp: 'b' },
		],
		fixed: [],
	}),
];

export const clamp8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** Colour of a pixel from luma and the two colour differences (0 .. 255, 128 = none), as slowrx and the ITU SSTV modes do. */
export function yuvToRgb(y: number, ry: number, by: number, out: Uint8Array, at: number): void {
	out[at] = clamp8(y + 1.4 * (ry - 128));
	out[at + 1] = clamp8(y - 0.71 * (ry - 128) - 0.33 * (by - 128));
	out[at + 2] = clamp8(y + 1.78 * (by - 128));
}

export function rgbToYuv(r: number, g: number, b: number): [number, number, number] {
	const y = 0.299 * r + 0.587 * g + 0.114 * b;
	const ry = Math.max(0, Math.min(255, 128 + (r - y) / 1.4));
	const by = Math.max(0, Math.min(255, 128 + (b - y) / 1.78));
	return [y, ry, by];
}
