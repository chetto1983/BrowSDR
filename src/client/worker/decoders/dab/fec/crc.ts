// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/dab/dab_fec.cpp (crc16, fireCode, descramble) and
// rust/onair_dab/src/crc.rs (the table-driven CRC-16), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the energy dispersal sequence (period 511) is precomputed.

const CRC_TABLE = (() => {
	const t = new Uint16Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i << 8;
		for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
		t[i] = c;
	}
	return t;
})();

/** CRC-CCITT x^16 + x^12 + x^5 + 1, register all ones, result inverted (FIB, access units, PAD, EN 300 401 clause 5.2.1). */
export function crc16(d: Uint8Array, n: number, from = 0): number {
	let c = 0xffff;
	for (let i = from; i < from + n; i++) c = ((c << 8) & 0xffff) ^ CRC_TABLE[((c >> 8) ^ d[i]) & 0xff];
	return ~c & 0xffff;
}

/** The DAB+ superframe Fire code, x^16 + x^14 + x^13 + x^12 + x^11 + x^5 + x^3 + x^2 + x + 1 (TS 102 563 clause 5.2). */
export function fireCode(d: Uint8Array, n: number, from = 0): number {
	let crc = 0;
	for (let i = from; i < from + n; i++) {
		crc ^= d[i] << 8;
		for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x782f) & 0xffff : (crc << 1) & 0xffff;
	}
	return crc;
}

/** The energy dispersal sequence x^9 + x^5 + 1 from all ones, one period. */
const PRBS = (() => {
	const s = new Uint8Array(511);
	let r = 0x1ff;
	for (let i = 0; i < 511; i++) {
		const p = ((r >> 8) ^ (r >> 4)) & 1;
		s[i] = p;
		r = ((r << 1) | p) & 0x1ff;
	}
	return s;
})();

/** Energy dispersal (EN 300 401 clause 10.1), in place on one bit per byte. */
export function descramble(bits: Uint8Array, n: number): void {
	for (let i = 0, k = 0; i < n; i++) {
		bits[i] ^= PRBS[k];
		if (++k === 511) k = 0;
	}
}
