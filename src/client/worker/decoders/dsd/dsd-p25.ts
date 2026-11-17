/*
 * P25 Phase 1 frame processor for DSD.
 * Ported from SDR++ Brown dsd_p25.cpp.
 *
 * P25 uses IMBE 7200x4400 codec. Most complex DSD mode.
 * Frame types: HDU, LDU1, LDU2, TDULC, TDU, TSDU, PDU.
 * The frames themselves are read in p25/ (ported from OnAir, GPL-3.0-or-later, see third_party/onair); the IMBE frame
 * interleave stays here.
 */

import { P25_IW, P25_IX, P25_IY, P25_IZ } from './constants';

// ── P25 DUID (Data Unit ID) types ────────────────────────────────────
export const DUID_HDU = 0x0; // Header Data Unit
export const DUID_TDU = 0x3; // Terminator without LC
export const DUID_LDU1 = 0x5; // Logical Link Data Unit 1
export const DUID_TSDU = 0x7; // Trunking Signaling Data Unit
export const DUID_LDU2 = 0xa; // Logical Link Data Unit 2
export const DUID_PDU = 0xc; // Packet Data Unit
export const DUID_TDULC = 0xf; // Terminator with LC

// ── P25 IMBE voice frame extraction ──────────────────────────────────

/**
 * Extract one P25 IMBE voice frame from the dibit stream.
 * Uses the P25 interleave schedule (iW, iX, iY, iZ) to deinterleave
 * 72 dibits into an 8x23 IMBE bit matrix.
 *
 * @param dibitBuf Dibit buffer
 * @param dibitPos Start of the 72 voice dibits
 * @returns IMBE frame as Int8Array (8*23 = 184 bytes, flat row-major)
 */
export function extractP25IMBE(dibitBuf: Uint8Array, dibitPos: number): Int8Array {
	const imbe_fr = new Int8Array(184); // 8x23 flat

	for (let i = 0; i < 72; i++) {
		const pos = dibitPos + i;
		const dibit = dibitBuf[pos] & 3;
		const bit1 = (dibit >> 1) & 1;
		const bit0 = dibit & 1;

		const w = P25_IW[i];
		const x = P25_IX[i];
		const y = P25_IY[i];
		const z = P25_IZ[i];

		imbe_fr[w * 23 + x] = bit1;
		imbe_fr[y * 23 + z] = bit0;
	}

	return imbe_fr;
}
