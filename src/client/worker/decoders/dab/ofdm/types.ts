// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/dab/dab_rx.cpp (the outcomes of searchSync and processFrame),
// https://github.com/adswill/OnAir; see third_party/onair.

/**
 * A sync search: 'wait' for more samples, 'none' when this stretch held no ensemble, 'restart' when a quick
 * re-acquisition gave up (the decoding state must start over), 'locked' when the phase reference was found.
 */
export type SearchResult = 'wait' | 'none' | 'restart' | 'locked';

/**
 * The timing of the next frame: 'wait' for more samples, 'lost' when the sync was lost (search again), 'frame' when the
 * frame at `OfdmSync.frameStart` is ready to demodulate.
 */
export type TrackResult = 'wait' | 'lost' | 'frame';

/** A (window position, carrier shift) pair of the sync search, ranked by the fast peak measure. */
export interface Candidate {
	fast: number;
	p: number;
	sh: number;
}
