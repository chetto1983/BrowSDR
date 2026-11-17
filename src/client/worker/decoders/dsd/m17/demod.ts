// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// M17 4FSK level fit from OnAir core/src/m17/m17_rx.cpp.
import { M17_SYNC, m17SoftBits, m17SyncSymbols } from './protocol';
import type { M17FrameType } from './types';

export const M17_SYNC_SYMBOLS = Object.fromEntries(Object.entries(M17_SYNC).map(([key, value]) => [key, m17SyncSymbols(value)])) as Record<
	M17FrameType,
	Int8Array
>;

export function m17Correlation(values: ArrayLike<number>, expected: ArrayLike<number>): number {
	let sv = 0,
		se = 0;
	for (let i = 0; i < 8; i++) {
		sv += values[i];
		se += expected[i];
	}
	sv /= 8;
	se /= 8;
	let numerator = 0,
		aa = 0,
		bb = 0;
	for (let i = 0; i < 8; i++) {
		const a = values[i] - sv,
			b = expected[i] - se;
		numerator += a * b;
		aa += a * a;
		bb += b * b;
	}
	return aa > 0 && bb > 0 ? numerator / Math.sqrt(aa * bb) : 0;
}

export function m17FitFrame(
	values: Float32Array,
	sync: Int8Array,
	polarity: number,
	locked: boolean,
): { soft: Float32Array; snrDb: number } | null {
	if (m17Correlation(values, sync) * polarity < (locked ? 0.72 : 0.9)) return null;
	let meanValue = 0,
		meanSync = 0;
	for (let i = 0; i < 8; i++) {
		meanValue += values[i];
		meanSync += sync[i];
	}
	meanValue /= 8;
	meanSync /= 8;
	let numerator = 0,
		denominator = 0;
	for (let i = 0; i < 8; i++) {
		numerator += (values[i] - meanValue) * (sync[i] - meanSync);
		denominator += (sync[i] - meanSync) ** 2;
	}
	let gain = numerator / denominator,
		offset = meanValue - gain * meanSync;
	for (let iteration = 0; iteration < 2; iteration++) {
		if (Math.abs(gain) < 1) return null;
		let sx = 0,
			sy = 0,
			sxy = 0,
			sxx = 0;
		for (let i = 0; i < 192; i++) {
			const ideal = i < 8 ? sync[i] : Math.max(-3, Math.min(3, 2 * Math.round(((values[i] - offset) / gain - 1) / 2) + 1));
			sx += ideal;
			sy += values[i];
			sxy += ideal * values[i];
			sxx += ideal * ideal;
		}
		gain = (192 * sxy - sx * sy) / (192 * sxx - sx * sx);
		offset = (sy - gain * sx) / 192;
	}
	if (Math.abs(gain) * 3 < 1000 || Math.abs(gain) * 3 > 5000) return null;
	const normalized = new Float32Array(184);
	let noise = 0;
	for (let i = 0; i < 192; i++) {
		const value = (values[i] - offset) / gain;
		const ideal = i < 8 ? sync[i] : value >= 2 ? 3 : value >= 0 ? 1 : value >= -2 ? -1 : -3;
		noise += (value - ideal) ** 2;
		if (i >= 8) normalized[i - 8] = value;
	}
	const snrDb = 10 * Math.log10(5 / Math.max(noise / 192, 1e-9));
	if (!locked && snrDb < 4) return null;
	return { soft: m17SoftBits(normalized), snrDb };
}
