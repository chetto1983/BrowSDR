// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/dab/dab_rx.cpp (the out(bytes, n, erased) callback of SubDec::cif),
// https://github.com/adswill/OnAir; see third_party/onair.

/** A decoded logical frame of a sub-channel (the bytes are reused: copy what is kept); erased when most of it was lost. */
export type FrameSink = (bytes: Uint8Array, erased: boolean) => void;
