// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/include/dect2/dsp/fast_phase.h (fastAtan2),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: none (double precision).

/** atan2 from a 4-coefficient polynomial on min / max: at most about 1e-4 rad off, no library call. */
export function fastAtan2(y: number, x: number): number {
	const ax = Math.abs(x);
	const ay = Math.abs(y);
	const mx = ax > ay ? ax : ay;
	const mn = ax > ay ? ay : ax;
	const a = mx > 0 ? mn / mx : 0;
	const s = a * a;
	let r = ((-0.0464964749 * s + 0.15931422) * s - 0.327622764) * s * a + a;
	if (ay > ax) r = 1.57079632679 - r;
	if (x < 0) r = 3.14159265359 - r;
	return y < 0 ? -r : r;
}
