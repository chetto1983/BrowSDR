// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/include/dect2/dab/dab_proto.h (PadSub, DlsStep, DlSegment),
// https://github.com/adswill/OnAir; see third_party/onair.

import type { DabAudioParams } from '@/worker/decoders/dabplus/types';

/** An access unit of the selected sub-channel (CRC removed); ok false when its CRC or its superframe failed. */
export type AccessUnitSink = (au: Uint8Array, params: DabAudioParams, ok: boolean) => void;

/** One application subfield of an X-PAD: application type and the byte range in the X-PAD. */
export interface PadSub {
	type: number;
	off: number;
	len: number;
}

/** What a dynamic label collector does next: 0 keep collecting, 1 stop, 2 stop with a segment of segLen bytes (no CRC). */
export interface DlsStep {
	action: 0 | 1 | 2;
	segLen: number;
}

/** The 2-byte prefix of a dynamic label segment. */
export interface DlSegment {
	toggle: number;
	first: boolean;
	last: boolean;
	cmd: boolean;
	code: number;
	segNo: number;
	charset: number;
}
