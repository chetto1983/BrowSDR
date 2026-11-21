// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/lorasat/lorasat_rx.cpp (onFrame: the row of a frame with its
// carrier offset at the first data symbol, drift, frequency, satellite, hex and text; loraSatSummary) and
// core/include/dect2/lorasat/lorasat_tel.h (LsFrame), https://github.com/adswill/OnAir; see third_party/onair. Changes:
// one Digital Modes record per frame with labelled fields (sync word, IQ, header, LDRO, the Doppler the orbit
// predicted and the difference); text shown only when the payload is mostly printable.

import { hexEncode } from '@/worker/decoders/digimode/lora/crypto';
import { printable } from '@/worker/decoders/digimode/lora/decoder';
import type { DigimodeRecord } from '@/worker/decoders/digimode/types';
import type { LoraSatFrame } from './types';

const signed = (v: number, digits: number): string => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(digits);
/** A Doppler shift, e.g. "+8.32 kHz", "−0.05 kHz". */
export const kHz = (hz: number): string => `${signed(hz / 1000, 2)} kHz`;
const bw = (hz: number): string => `${+(hz / 1000).toFixed(2)} kHz`;
const hex2 = (v: number): string => `0x${v.toString(16).padStart(2, '0').toUpperCase()}`;

/** The payload as text when at least 80 % of it is printable ASCII (tab, CR and LF count), else null. */
export function payloadText(p: Uint8Array): string | null {
	if (!p.length) return null;
	let ok = 0;
	for (const c of p) if ((c >= 0x20 && c < 0x7f) || c === 9 || c === 10 || c === 13) ok++;
	return ok >= 0.8 * p.length ? printable(p) : null;
}

/** "SF10 · 250 kHz · 4/5 · sync 0x12" and IQ / header when unusual. */
export function settingsText(f: Pick<LoraSatFrame, 'sf' | 'bwHz' | 'cr' | 'sync' | 'inverted' | 'implicit'>): string {
	const parts = [`SF${f.sf}`, bw(f.bwHz), `4/${f.cr}`, `sync ${hex2(f.sync)}`];
	if (f.inverted) parts.push('inverted IQ');
	if (f.implicit) parts.push('implicit header');
	return parts.join(' · ');
}

/** Doppler and its rate, e.g. "+8.32 kHz, −95 Hz/s". */
export const dopplerText = (hz: number, rateHzS: number): string => `${kHz(hz)}, ${signed(rateHzS, 0)} Hz/s`;

function crcText(f: LoraSatFrame): string {
	if (!f.hasCrc) return 'none (not checked)';
	return f.crcOk ? 'ok' : 'failed';
}

function fields(f: LoraSatFrame, text: string | null): Array<[string, string]> {
	const out: Array<[string, string]> = [];
	if (f.satellite) out.push(['Satellite', `${f.satellite.name} (NORAD ${f.satellite.norad}, from Tools → Satellites)`]);
	out.push(['Doppler', `${kHz(f.dopplerHz)} (carrier offset from the VFO at the first data symbol)`]);
	out.push(['Doppler rate', `${signed(f.rateHzS, 0)} Hz/s (through the frame)`]);
	if (f.hint) {
		out.push(['Expected Doppler (orbit)', dopplerText(f.hint.offsetHz, f.hint.rateHzS)]);
		out.push(['Measured − expected', kHz(f.dopplerHz - f.hint.offsetHz)]);
	}
	if (f.freqMHz) out.push(['Frequency', `${f.freqMHz.toFixed(6)} MHz`]);
	out.push(
		['Spreading factor', `SF${f.sf}`],
		['Bandwidth', bw(f.bwHz)],
		['Coding rate', `4/${f.cr}`],
		['Sync word', `${hex2(f.sync)} (${f.sync})`],
		['IQ', f.inverted ? 'inverted' : 'normal'],
		['Header', f.implicit ? `implicit (${f.payload.length} bytes)` : 'explicit'],
		['Low data rate optimisation', f.ldro ? 'on' : 'off'],
		['CRC', crcText(f)],
	);
	if (f.corrected) out.push(['Corrected codewords', String(f.corrected)]);
	out.push(
		['SNR', `${f.snrDb.toFixed(1)} dB`],
		['RSSI', `${f.levelDb.toFixed(1)} dBFS (not calibrated)`],
		['Length', `${f.payload.length} bytes`],
		['Payload', hexEncode(f.payload, true, ' ')],
	);
	if (text !== null) out.push(['Text', text]);
	return out;
}

/** The record of a frame: settings, Doppler, length and the payload's start as text or hex. */
export function frameRecord(f: LoraSatFrame): Omit<DigimodeRecord, 'id' | 'time' | 'mode'> {
	const text = payloadText(f.payload);
	const crcBad = f.hasCrc && !f.crcOk;
	const start =
		text !== null ? `"${text.slice(0, 80)}"` : hexEncode(f.payload.subarray(0, 16), true, ' ') + (f.payload.length > 16 ? ' …' : '');
	const line = [
		...(f.satellite ? [f.satellite.name] : []),
		settingsText(f),
		`Doppler ${dopplerText(f.dopplerHz, f.rateHzS)}`,
		`${f.payload.length} bytes: ${start}`,
	].join(' · ');
	return {
		text: (crcBad ? `CRC error · ${line}` : line).slice(0, 2000),
		fields: fields(f, text).map(([k, v]): [string, string] => [k, v.slice(0, 4000)]),
		damaged: crcBad,
	};
}
