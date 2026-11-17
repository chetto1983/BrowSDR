// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/hfdl/hfdl_rx.cpp (HfdlReceiver::Impl::burst, after the preamble:
// the three equaliser modes tried in turn, the soft bits weighted by the probes, the decoding, the "why bad" reason,
// level, SNR and start time), https://github.com/adswill/OnAir; see third_party/onair. Changes: a generator that
// stops after each equaliser run and each decoding, so the receiver can spread a burst over several input blocks.
//
// A burst the equaliser cannot decode (a weak signal: 25 taps adapt to the noise) is tried again with the gain and
// phase tracker alone, then with the known symbols only. Each block's soft bits are weighted by the error on the probes
// beside it (a fade makes its bits less sure); then descrambling (done by the equaliser), deinterleaving, Viterbi and the
// PDU with its check sequences.

import type { HfdlSamples } from './front';
import { HFDL_RATE } from './front';
import { burstSamples, equalise } from './equalizer';
import { parsePdu } from './parse';
import { DATA_LEN, HFDL_BAUD, PREKEY, codedBits, decodeSoft, hfdlRate, scramblerSigns, pskSoftBits } from './phy';
import { pilotsOnly } from './pilots';
import type { HfdlBurst, HfdlEqualised, HfdlMessage, HfdlPreamble } from './types';

/** The soft bits of the data symbols (channel order), each block weighted by the error on the probes beside it. */
export function softBits(eq: HfdlEqualised, m1: number): Float32Array {
	const bps = hfdlRate(m1).bitsPerSym;
	const soft = new Float32Array(codedBits(m1));
	for (let s = 0; s < eq.re.length; s++) {
		const blk = Math.trunc(s / DATA_LEN);
		const e = Math.max(1e-4, 0.5 * (eq.probeErr[blk] + eq.probeErr[blk + 1]));
		pskSoftBits(bps, eq.re[s], eq.im[s], 1 / e, soft, s * bps);
	}
	return soft;
}

/** Why a burst gave no PDU: 1 too few octets, 2 the squitter's check, 3 the MPDU header's check. */
const whyOf = (pdu: Uint8Array): number => (pdu.length < 4 ? 1 : (pdu[0] & 1) === 0 ? 2 : 3);

/** Decodes the burst of a found preamble: an equaliser run or a decoding per step. */
export function* decodeBurst(x: HfdlSamples, pre: HfdlPreamble): Generator<void, HfdlBurst, void> {
	const rate = hfdlRate(pre.m1);
	const u = burstSamples(x, pre);
	const scr = scramblerSigns(rate.blocks * DATA_LEN);
	let messages: HfdlMessage[] | undefined;
	let pdu: Uint8Array = new Uint8Array(0);
	let sig2 = 1;
	let mode = 0;
	for (; mode < 3; mode++) {
		if (mode > 0) yield;
		const eq = mode === 2 ? pilotsOnly(x, pre, u, scr) : equalise(u, pre, mode === 0, scr);
		sig2 = eq.sig2;
		yield;
		pdu = decodeSoft(pre.m1, softBits(eq, pre.m1));
		messages = parsePdu(pdu);
		if (messages) break;
	}
	return {
		ok: !!messages,
		messages: messages ?? [],
		timeSec: pre.t0 / HFDL_RATE - PREKEY / HFDL_BAUD,
		levelDb: 10 * Math.log10(u.pw + 1e-20),
		snrDb: -10 * Math.log10(sig2),
		cfoHz: pre.cfoHz,
		rate,
		mode: Math.min(mode, 2),
		why: messages ? 0 : whyOf(pdu),
	};
}
