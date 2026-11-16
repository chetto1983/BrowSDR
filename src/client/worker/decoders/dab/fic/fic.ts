// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/dab/dab_rx.cpp (decodeFic: four code words per frame, depuncture,
// Viterbi, energy dispersal, three FIBs each with their CRC), https://github.com/adswill/OnAir; see third_party/onair.

import { crc16, descramble } from '@/worker/decoders/dab/fec/crc';
import { FIC_MOTHER, FIC_PUNCTURED, ficDepuncture } from '@/worker/decoders/dab/fec/puncture';
import { Viterbi } from '@/worker/decoders/dab/fec/viterbi';

/** FIBs of a mode I frame (3 per CIF). */
export const FIBS = 12;
export const FIB_BYTES = 32;

/** The fast information channel of one frame: 12 FIBs and which of them passed their CRC. */
export class FicDecoder {
	readonly fibs = new Uint8Array(FIBS * FIB_BYTES);
	readonly ok = new Uint8Array(FIBS);
	private readonly mother = new Int8Array(FIC_MOTHER);
	private readonly bits = new Uint8Array(768);
	private readonly viterbi = new Viterbi();

	/** Decodes the 9216 soft bits of the FIC symbols; returns the number of good FIBs. */
	decode(soft: Int8Array): number {
		let good = 0;
		for (let cw = 0; cw < 4; cw++) {
			ficDepuncture(soft, cw * FIC_PUNCTURED, this.mother);
			this.viterbi.decode(this.mother, 768, this.bits);
			descramble(this.bits, 768);
			const base = cw * 96;
			for (let i = 0; i < 96; i++) {
				let v = 0;
				for (let b = 0; b < 8; b++) v = (v << 1) | this.bits[i * 8 + b];
				this.fibs[base + i] = v;
			}
			for (let f = 0; f < 3; f++) {
				const at = base + f * FIB_BYTES;
				const fine = crc16(this.fibs, 30, at) === ((this.fibs[at + 30] << 8) | this.fibs[at + 31]);
				this.ok[cw * 3 + f] = fine ? 1 : 0;
				if (fine) good++;
			}
		}
		return good;
	}
}
