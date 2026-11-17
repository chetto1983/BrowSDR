// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir rust/onair_nxdn/src/msg.rs (ambe_frame) as used by
// core/src/nxdn/nxdn_ambe.cpp (NxdnAmbe::decode) for Yaesu System Fusion V/D mode 1 and dPMR voice,
// https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the NW/NX/NY/NZ tables are DSD's DMR_W/X/Y/Z (constants.ts, the same values); a P25 / Fusion voice FR frame
// uses DSD's P25 schedule (dsd-p25.ts).
import { DMR_W, DMR_X, DMR_Y, DMR_Z } from './constants';
import { extractP25IMBE } from './dsd-p25';

/** Spread 72 channel bits of an AMBE+2 (3600x2450) voice frame into mbelib's ambe_fr[4][24] (96 bytes, row major). */
export function ambeFrame(bits: ArrayLike<number>, start = 0): Int8Array {
	const fr = new Int8Array(96);
	for (let j = 0; j < 36; j++) {
		fr[DMR_W[j] * 24 + DMR_X[j]] = bits[start + 2 * j] & 1;
		fr[DMR_Y[j] * 24 + DMR_Z[j]] = bits[start + 2 * j + 1] & 1;
	}
	return fr;
}

/** Spread 144 channel bits of an IMBE (7200x4400) voice frame, in P25 order, into mbelib's imbe_fr[8][23]. */
export function imbeFrame(bits: ArrayLike<number>, start = 0): Int8Array {
	const dibits = Uint8Array.from({ length: 72 }, (_, i) => ((bits[start + 2 * i] & 1) << 1) | (bits[start + 2 * i + 1] & 1));
	return extractP25IMBE(dibits, 0);
}

/** One bit per element from MSB-first bytes. */
export function unpackBits(bytes: ArrayLike<number>, nbits: number): Uint8Array {
	return Uint8Array.from({ length: nbits }, (_, i) => (bytes[i >> 3] >> (7 - (i & 7))) & 1);
}
