// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir core/src/dab/dab_gen_pad.cpp (slideDse: the dynamic label part,
// written there from TS 102 563 clause 5.2 and EN 300 401 clause 7.4 without the receiver's dab_pad.cpp),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: no slide show; a label of any number of 16-character
// segments (OnAir's test label has exactly two); every segment goes in the smallest subfield that holds it (OnAir puts a
// segment of 9 to 12 characters, 13 to 16 bytes with its prefix and CRC, in a 12-byte subfield and cuts it).

import { crc16 } from './gen-coding.js';

const SUBFIELD_LEN = [4, 6, 8, 12, 16, 24, 32, 48];

/**
 * The data stream element (PAD) that goes in front of access unit j, j < nAu: the segments of `label` (EBU Latin, ASCII
 * only) sent over and over, each in one X-PAD with a dynamic label content indicator.
 */
export function dlsDse(nAu, label) {
	const bytes = Array.from(label, (ch) => ch.charCodeAt(0) & 0x7f);
	const segments = Math.max(1, Math.ceil(bytes.length / 16));
	const out = [];
	for (let j = 0; j < nAu; j++) {
		const seg = j % segments,
			from = seg * 16,
			n = Math.min(16, bytes.length - from);
		const flags = (seg === 0 ? 0x40 : 0) | (seg === segments - 1 ? 0x20 : 0);
		// first / last, length - 1; charset 0 (EBU Latin) in the first segment, else the segment number
		const s = [flags | (n - 1), seg === 0 ? 0x00 : seg << 4, ...bytes.slice(from, from + n)];
		const c = crc16(s);
		s.push(c >> 8, c & 0xff);
		const idx = SUBFIELD_LEN.findIndex((len) => len >= s.length); // EN 300 401 table 30
		while (s.length < SUBFIELD_LEN[idx]) s.push(0);
		const xp = [(idx << 5) | 2, 0x00, ...s]; // content indicator (type 2), end marker
		const d = xp.reverse(); // the X-PAD sits backwards in front of the F-PAD
		d.push(0x20, 0x02); // F-PAD: type 0, variable size X-PAD; content indicator flag
		out.push(Uint8Array.from([0x80, d.length, ...d])); // data stream element, instance 0, count
	}
	return out;
}
