// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/hfdig/hfdig_sstv_modes.h and hfdig_sstv.cpp (data shapes),
// https://github.com/adswill/OnAir; see third_party/onair.

export type SstvKind = 'seq' | 'robot36' | 'robot72' | 'pd';

/** What a scan carries (y2: the second luma of a PD line). */
export type SstvComponent = 'r' | 'g' | 'b' | 'y' | 'ry' | 'by' | 'y2';

export interface SstvScan {
	startMs: number;
	lenMs: number;
	px: number;
	comp: SstvComponent;
}

/** A stretch of constant tone other than the sync (hz < 0: Robot 36 separator, 1500 on even lines, 2300 on odd). */
export interface SstvFixed {
	startMs: number;
	lenMs: number;
	hz: number;
}

export interface SstvSpec {
	vis: number;
	name: string;
	width: number;
	height: number;
	/** Time of one transmitted line (PD: two picture rows). */
	lineMs: number;
	/** Length of the 1200 Hz line sync pulse. */
	syncMs: number;
	kind: SstvKind;
	/** From the start of the line to the start of the sync pulse; Scottie sends its sync in the middle. */
	syncOffMs: number;
	totalLines: number;
	scans: SstvScan[];
	fixed: SstvFixed[];
}

export interface SstvRows {
	picture: number;
	spec: SstvSpec;
	from: number;
	to: number;
	rgb: Uint8Array;
	/** All lines were received. */
	complete: boolean;
	/** The picture is over (complete or cut off): no more rows will come. */
	final: boolean;
}

export interface LineFit {
	n: number;
	sk: number;
	sc: number;
	skk: number;
	skc: number;
	a: number;
	b: number;
}

export type VisState = 'idle' | 'lead1' | 'break' | 'lead2' | 'bits';

/** Starts a picture: the mode, whether a VIS header named it, where line 0 starts (samples) and the tuning error. */
export type SstvStart = (spec: SstvSpec, vis: boolean, c0: number, offsetHz: number) => void;
