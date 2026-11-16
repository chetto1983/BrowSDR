// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// WSPR for BrowSDR, after OnAir core/src/hfdig/hfdig_ftx.cpp (the WSPR mode of the slot decoder: two-minute slots from
// the even minutes, the sync vector search, Fano decoding, the decode record with the power sent) and
// core/src/hfdig/hfdig_rx.cpp (the 8 kHz sideband audio), https://github.com/adswill/OnAir; see third_party/onair.
//
// The same channel and slot clock as FT8 (ftx/index.ts): the dial at 0 Hz of the audio, the beacons 1400 .. 1600 Hz.

import { FtxDecoder, signed, utcTime } from '@/worker/decoders/digimode/ftx';
import type { FtxDecode, FtxOptions } from '@/worker/decoders/digimode/ftx/types';
import { WSPR } from '@/worker/decoders/digimode/ftx/wave';
import type { DigimodeSink } from '@/worker/decoders/digimode/types';

/** dBm as power: 37 -> 5 W, 23 -> 200 mW. */
export function watts(dbm: number): string {
	const mw = 10 ** (dbm / 10);
	if (mw >= 1000) return `${Number((mw / 1000).toPrecision(2))} W`;
	return mw >= 1 ? `${Number(mw.toPrecision(2))} mW` : `${Number((mw * 1000).toPrecision(2))} µW`;
}

export class WsprDecoder extends FtxDecoder {
	constructor(sink: DigimodeSink, options: FtxOptions = {}) {
		super(sink, WSPR, options);
	}

	/** One record of a beacon: "<call> <grid> <dBm>". */
	protected override recordOf(d: FtxDecode): { text: string; fields: Array<[string, string]> } {
		const fields: Array<[string, string]> = [
			['Mode', 'WSPR'],
			['UTC slot', utcTime(d.slotUtc)],
			['SNR', `${d.snrDb} dB (in 2500 Hz)`],
			['DT', `${signed(d.dt, 1)} s`],
			['Audio frequency', `${d.hz.toFixed(1)} Hz`],
		];
		if (d.call) fields.push(['Call', d.call]);
		if (d.grid) fields.push(['Grid', d.grid]);
		fields.push(['Power', `${d.dbm} dBm (${watts(d.dbm)})`]);
		if (d.mirrored) fields.push(['Sideband', 'Lower (heard upside down)']);
		return { text: d.msg, fields };
	}
}
