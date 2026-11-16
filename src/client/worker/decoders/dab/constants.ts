// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/include/dect2/dab/dab.h (mode I geometry), https://github.com/adswill/OnAir;
// see third_party/onair.

/** Samples per second of transmission mode I. */
export const DAB_RATE = 2_048_000;

// ---- mode I geometry (samples at 2.048 Msps)
/** Useful part of an OFDM symbol (the FFT size). */
export const TU = 2048;
/** Guard interval. */
export const TG = 504;
/** Whole symbol. */
export const TS = 2552;
/** Symbols of a frame after the null symbol: phase reference, 3 FIC, 72 MSC. */
export const SYMBOLS = 76;
/** Null symbol. */
export const TNULL = 2656;
/** Active carriers. */
export const CARRIERS = 1536;
/** Transmission frame (96 ms). */
export const FRAME = 196608;

export const FIC_SYMBOLS = 3;
export const CIF_PER_FRAME = 4;
/** Bits of a capacity unit. */
export const CU_BITS = 64;
/** Capacity units of a common interleaved frame. */
export const CIF_CU = 864;
export const CIF_BITS = CIF_CU * CU_BITS;
/** Soft bits of one OFDM symbol (two per carrier). */
export const SYMBOL_BITS = 2 * CARRIERS;
