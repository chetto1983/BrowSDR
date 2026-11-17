/*
 * DSD sync word labels, modes and matching, ported from SDR++ Brown / DSD.
 * Original DSD source: https://github.com/szechyjs/dsd
 * Copyright (C) 2010 DSD Author (ISC License)
 *
 * The Yaesu System Fusion sync word comes from ysf/proto.ts (OnAir, GPL-3.0-or-later, see third_party/onair).
 */
import { SyncType } from './types';
import type { DSDMode, SyncPattern } from './types';
import { SYNC_WORDS } from './constants';
import { syncPolarity } from './ysf/proto';

/** Invert a dibit (0 ↔ 2, 1 ↔ 3). */
export function invertDibit(d: number): number {
	return d ^ 2;
}

const syncLabels: Readonly<Partial<Record<SyncType, string>>> = {
	[SyncType.P25P1]: 'P25P1',
	[SyncType.INV_P25P1]: '-P25P1',
	[SyncType.P25P2]: 'P25P2',
	[SyncType.DMR_BS_DATA]: 'DMR_BS_DATA',
	[SyncType.DMR_BS_VOICE]: 'DMR_BS_VOICE',
	[SyncType.DMR_MS_DATA]: 'DMR_MS_DATA',
	[SyncType.DMR_MS_VOICE]: 'DMR_MS_VOICE',
	[SyncType.DMR_DM_TS1_DATA]: 'DMR_DM1_DATA',
	[SyncType.DMR_DM_TS1_VOICE]: 'DMR_DM1_VOICE',
	[SyncType.DMR_DM_TS2_DATA]: 'DMR_DM2_DATA',
	[SyncType.DMR_DM_TS2_VOICE]: 'DMR_DM2_VOICE',
	[SyncType.DSTAR]: 'DSTAR',
	[SyncType.INV_DSTAR]: '-DSTAR',
	[SyncType.DSTAR_HD]: 'DSTAR_HD',
	[SyncType.INV_DSTAR_HD]: '-DSTAR_HD',
	[SyncType.NXDN_MS_DATA]: 'NXDN_MS_DATA',
	[SyncType.INV_NXDN_MS_DATA]: '-NXDN_MS_DATA',
	[SyncType.NXDN_MS_VOICE]: 'NXDN_MS_VOICE',
	[SyncType.INV_NXDN_MS_VOICE]: '-NXDN_MS_VOICE',
	[SyncType.NXDN_BS_DATA]: 'NXDN_BS_DATA',
	[SyncType.INV_NXDN_BS_DATA]: '-NXDN_BS_DATA',
	[SyncType.NXDN_BS_VOICE]: 'NXDN_BS_VOICE',
	[SyncType.INV_NXDN_BS_VOICE]: '-NXDN_BS_VOICE',
	[SyncType.YSF]: 'YSF',
	[SyncType.INV_YSF]: '-YSF',
	[SyncType.DPMR_FS1]: 'DPMR_FS1',
	[SyncType.DPMR_FS2]: 'DPMR_FS2',
	[SyncType.DPMR_FS3]: 'DPMR_FS3',
	[SyncType.DPMR_FS4]: 'DPMR_FS4',
};

/** Human-readable label for a SyncType value. */
export function syncTypeLabel(st: SyncType): string {
	return syncLabels[st] ?? 'UNKNOWN';
}

const syncModes: Readonly<Partial<Record<SyncType, DSDMode>>> = {
	[SyncType.P25P1]: 'p25',
	[SyncType.INV_P25P1]: 'p25',
	[SyncType.P25P2]: 'p25p2',
	[SyncType.DMR_BS_DATA]: 'dmr',
	[SyncType.DMR_BS_VOICE]: 'dmr',
	[SyncType.DMR_MS_DATA]: 'dmr',
	[SyncType.DMR_MS_VOICE]: 'dmr',
	[SyncType.DMR_DM_TS1_DATA]: 'dmr',
	[SyncType.DMR_DM_TS1_VOICE]: 'dmr',
	[SyncType.DMR_DM_TS2_DATA]: 'dmr',
	[SyncType.DMR_DM_TS2_VOICE]: 'dmr',
	[SyncType.DSTAR]: 'dstar',
	[SyncType.INV_DSTAR]: 'dstar',
	[SyncType.DSTAR_HD]: 'dstar',
	[SyncType.INV_DSTAR_HD]: 'dstar',
	[SyncType.NXDN_MS_DATA]: 'nxdn',
	[SyncType.INV_NXDN_MS_DATA]: 'nxdn',
	[SyncType.NXDN_MS_VOICE]: 'nxdn',
	[SyncType.INV_NXDN_MS_VOICE]: 'nxdn',
	[SyncType.NXDN_BS_DATA]: 'nxdn',
	[SyncType.INV_NXDN_BS_DATA]: 'nxdn',
	[SyncType.NXDN_BS_VOICE]: 'nxdn',
	[SyncType.INV_NXDN_BS_VOICE]: 'nxdn',
	[SyncType.YSF]: 'ysf',
	[SyncType.INV_YSF]: 'ysf',
	[SyncType.DPMR_FS1]: 'dpmr',
	[SyncType.DPMR_FS2]: 'dpmr',
	[SyncType.DPMR_FS3]: 'dpmr',
	[SyncType.DPMR_FS4]: 'dpmr',
};

/** Map SyncType to DSDMode. */
export function syncTypeToMode(st: SyncType): DSDMode {
	return syncModes[st] ?? 'unknown';
}

/** Is this a voice sync (as opposed to data)? */
export function isVoiceSync(st: SyncType): boolean {
	switch (st) {
		case SyncType.DMR_BS_VOICE:
		case SyncType.DMR_MS_VOICE:
		case SyncType.DMR_DM_TS1_VOICE:
		case SyncType.DMR_DM_TS2_VOICE:
		case SyncType.NXDN_MS_VOICE:
		case SyncType.INV_NXDN_MS_VOICE:
		case SyncType.NXDN_BS_VOICE:
		case SyncType.INV_NXDN_BS_VOICE:
		case SyncType.P25P1:
		case SyncType.INV_P25P1:
		case SyncType.DSTAR:
		case SyncType.INV_DSTAR:
			return true;
		default:
			return false;
	}
}

// ── Sync word matching (moved here from dsd-decoder.ts) ─────────────

const SYNC_PATTERNS: SyncPattern[] = [
	// P25 (24 dibits)
	{ pattern: SYNC_WORDS.P25P1, type: SyncType.P25P1, len: 24 },
	{ pattern: SYNC_WORDS.INV_P25P1, type: SyncType.INV_P25P1, len: 24 },
	// DMR (24 dibits)
	{ pattern: SYNC_WORDS.DMR_BS_DATA, type: SyncType.DMR_BS_DATA, len: 24 },
	{ pattern: SYNC_WORDS.DMR_BS_VOICE, type: SyncType.DMR_BS_VOICE, len: 24 },
	{ pattern: SYNC_WORDS.DMR_MS_DATA, type: SyncType.DMR_MS_DATA, len: 24 },
	{ pattern: SYNC_WORDS.DMR_MS_VOICE, type: SyncType.DMR_MS_VOICE, len: 24 },
	{ pattern: SYNC_WORDS.DMR_DM_TS1_DATA, type: SyncType.DMR_DM_TS1_DATA, len: 24 },
	{ pattern: SYNC_WORDS.DMR_DM_TS1_VOICE, type: SyncType.DMR_DM_TS1_VOICE, len: 24 },
	{ pattern: SYNC_WORDS.DMR_DM_TS2_DATA, type: SyncType.DMR_DM_TS2_DATA, len: 24 },
	{ pattern: SYNC_WORDS.DMR_DM_TS2_VOICE, type: SyncType.DMR_DM_TS2_VOICE, len: 24 },
	// D-STAR (24 dibits)
	{ pattern: SYNC_WORDS.DSTAR, type: SyncType.DSTAR, len: 24 },
	{ pattern: SYNC_WORDS.INV_DSTAR, type: SyncType.INV_DSTAR, len: 24 },
	{ pattern: SYNC_WORDS.DSTAR_HD, type: SyncType.DSTAR_HD, len: 24 },
	{ pattern: SYNC_WORDS.INV_DSTAR_HD, type: SyncType.INV_DSTAR_HD, len: 24 },
	// Yaesu System Fusion (20 dibits, D471C9634D); its FICH confirms a match (ysf/frame.ts)
	{ pattern: syncPolarity(), type: SyncType.YSF, len: 20 },
	{ pattern: syncPolarity(true), type: SyncType.INV_YSF, len: 20 },
	// NXDN (18 dibits)
	{ pattern: SYNC_WORDS.NXDN_MS_DATA, type: SyncType.NXDN_MS_DATA, len: 18 },
	{ pattern: SYNC_WORDS.INV_NXDN_MS_DATA, type: SyncType.INV_NXDN_MS_DATA, len: 18 },
	{ pattern: SYNC_WORDS.NXDN_MS_VOICE, type: SyncType.NXDN_MS_VOICE, len: 18 },
	{ pattern: SYNC_WORDS.INV_NXDN_MS_VOICE, type: SyncType.INV_NXDN_MS_VOICE, len: 18 },
	{ pattern: SYNC_WORDS.NXDN_BS_DATA, type: SyncType.NXDN_BS_DATA, len: 18 },
	{ pattern: SYNC_WORDS.INV_NXDN_BS_DATA, type: SyncType.INV_NXDN_BS_DATA, len: 18 },
	{ pattern: SYNC_WORDS.NXDN_BS_VOICE, type: SyncType.NXDN_BS_VOICE, len: 18 },
	{ pattern: SYNC_WORDS.INV_NXDN_BS_VOICE, type: SyncType.INV_NXDN_BS_VOICE, len: 18 },
];

/** Maximum bit errors allowed when matching sync words. */
const SYNC_TOLERANCE_24 = 0; // Acquire only exact syncs; noise otherwise looks like digital traffic.
const SYNC_TOLERANCE_24_VOICE = 0;
const SYNC_TOLERANCE_20 = 0;
const SYNC_TOLERANCE_18 = 0;

/**
 * Collapse a dibit character to its polarity, matching SDR++ Brown's
 * `(dibit | 1) + 48` convention: positive dibits (0,1) → '1', negative (2,3) → '3'.
 * This is critical for sync detection robustness: sync words only use the
 * outermost ±3 levels, but after pulse shaping and noise, some may be received
 * as the inner ±1 levels. Collapsing polarity avoids counting these as mismatches.
 */
function collapsePolarity(ch: string): string {
	return ch === '0' || ch === '1' ? '1' : '3';
}

/** Error count from the last successful matchSync call (for diagnostics). */
let lastErrors = 0;

export function lastMatchErrors(): number {
	return lastErrors;
}

function matchLength(dibitHistory: string, len: number, tolerance: (type: SyncType) => number): SyncType {
	if (dibitHistory.length < len) return SyncType.NONE;
	const start = dibitHistory.length - len;
	for (const sp of SYNC_PATTERNS) {
		if (sp.len !== len) continue;
		const limit = tolerance(sp.type);
		let mismatches = 0;
		for (let i = 0; i < len && mismatches <= limit; i++) {
			// Collapse polarity: 0,1 → '1' (positive); 2,3 → '3' (negative)
			if (collapsePolarity(dibitHistory[start + i]) !== sp.pattern[i]) mismatches++;
		}
		if (mismatches <= limit) {
			lastErrors = mismatches;
			return sp.type;
		}
	}
	return SyncType.NONE;
}

/**
 * Try to match the sync word in the dibit history buffer.
 * Prioritizes longer (24-dibit) syncs over Fusion (20) and shorter (18-dibit) NXDN.
 *
 * Comparison uses collapsed polarity (positive/negative only, not exact level)
 * to match SDR++ Brown's approach and avoid missing syncs when outer symbols
 * are received as inner symbols.
 */
export function matchSync(dibitHistory: string, lastMode: DSDMode): SyncType {
	// First pass: 24-dibit syncs (DMR, P25, D-STAR) — highest confidence.
	// Voice syncs use stricter tolerance: false voice matches trigger expensive
	// superframe reads (1494 dibits for DMR) that produce garbled audio.
	const long = matchLength(dibitHistory, 24, (type) => (isVoiceSync(type) ? SYNC_TOLERANCE_24_VOICE : SYNC_TOLERANCE_24));
	if (long !== SyncType.NONE) return long;
	const ysf = matchLength(dibitHistory, 20, () => SYNC_TOLERANCE_20);
	if (ysf !== SyncType.NONE) return ysf;
	// Last pass: 18-dibit syncs (NXDN) — only if we're not already locked to DMR/P25/D-STAR/Fusion.
	// When the decoder is idle or already in NXDN mode, allow NXDN detection.
	// This prevents false NXDN matches on DMR idle channels.
	if (lastMode === 'unknown' || lastMode === 'nxdn') return matchLength(dibitHistory, 18, () => SYNC_TOLERANCE_18);
	return SyncType.NONE;
}
