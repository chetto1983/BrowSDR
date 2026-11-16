// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/marine/marine_dsc.cpp (dscCallKind, dscParseCall) and
// core/include/dect2/marine/marine_tel.h (DscCall), https://github.com/adswill/OnAir; see third_party/onair.

import {
	dscCategoryName,
	dscFormatName,
	dscFrequencyText,
	dscMmsiLenient,
	dscNatureName,
	dscPositionFromSymbols,
	dscTelecommand1Name,
	dscTelecommand2Name,
	dscTimeFromSymbols,
	mmsiKind,
} from './symbols';
import type { DscCall, DscKindInput } from './types';

export type { DscCall } from './types';

const WHO: Record<number, string> = { 116: 'All ships', 102: 'Area', 114: 'Group', 120: 'Individual', 123: 'Individual' };
const RELAY_KIND: Record<number, string> = { 116: 'Distress alert relay (all ships)', 102: 'Distress alert relay (area)' };

/** Distress alerts, their acknowledgements and relays; null for other calls. */
function distressKind(c: DscKindInput): string | null {
	if (c.format === 112) return 'Distress alert';
	if (c.category !== 112) return null;
	if (c.telecommand1 === 110) return c.format === 116 ? 'Distress alert acknowledgement' : 'Distress alert relay acknowledgement';
	if (c.telecommand1 === 112) return RELAY_KIND[c.format] ?? 'Distress alert relay';
	return null;
}

/** What the call is, from the format specifier, category, first telecommand and end of sequence (M.493 §4, §6, M.541). */
export function dscCallKind(c: DscKindInput): string {
	const distress = distressKind(c);
	if (distress) return distress;
	const who = WHO[c.format];
	if (!who) return c.formatName;
	const ack = c.eos === 122;
	if (c.telecommand1 === 118) return ack ? 'Test acknowledgement' : 'Test call';
	if (c.telecommand1 === 121) return 'Position update';
	if (c.telecommand1 === 103 || (ack && c.position)) return ack ? 'Position reply' : 'Position request (polling)';
	if (ack) return `${who} call acknowledgement`;
	if (c.category === 110) return `${who} urgency call`;
	if (c.category === 108) return `${who} safety call`;
	return `${who} call`;
}

/** Area address: quadrant, latitude (2), longitude (3), latitude span (2), longitude span (2); reference is the NW corner. */
function areaText(s: number[]): string {
	if (s.some((v) => v < 0 || v > 99)) return '';
	const d = s.map((v) => String(v).padStart(2, '0')).join('');
	const q = Number(d[0]);
	return `area ref ${q === 2 || q === 3 ? 'S' : 'N'}${d.slice(1, 3)} ${q === 1 || q === 3 ? 'W' : 'E'}${d.slice(3, 6)}, ${d.slice(6, 8)}° x ${d.slice(8, 10)}°`;
}

function telecommandText(c: DscCall): string {
	const parts: string[] = [];
	if (c.telecommand1 >= 0 && dscTelecommand1Name(c.telecommand1)) parts.push(dscTelecommand1Name(c.telecommand1));
	if (c.format === 112 || (c.distress && c.telecommand1 >= 0)) {
		// telecommand 2 holds the type of communication proposed
		const next = dscTelecommand1Name(c.telecommand2);
		if (next) parts.push(`then ${next}`);
	} else if (c.telecommand2 >= 0 && c.telecommand2 !== 126 && dscTelecommand2Name(c.telecommand2))
		parts.push(dscTelecommand2Name(c.telecommand2));
	return parts.join('; ');
}

/** Reads the information symbols in order; -1 past the end. */
class SymbolReader {
	private i = 0;
	constructor(private readonly b: readonly number[]) {}
	at(offset = 0): number {
		return this.i + offset < this.b.length ? this.b[this.i + offset] : -1;
	}
	next(): number {
		const value = this.at();
		this.i++;
		return value;
	}
	take(n: number): number[] {
		const out = Array.from({ length: n }, (_, k) => this.at(k));
		this.i += n;
		return out;
	}
	get left(): number {
		return Math.max(0, this.b.length - this.i);
	}
}

function emptyCall(format: number, eos: number, eccOk: boolean, erasures: number): DscCall {
	return {
		format,
		formatName: dscFormatName(format),
		category: -1,
		categoryName: '',
		from: '',
		to: '',
		distress: false,
		nature: -1,
		natureName: '',
		position: null,
		time: null,
		telecommand1: -1,
		telecommand2: -1,
		telecommandText: '',
		freqRx: '',
		freqTx: '',
		distressMmsi: '',
		eos,
		eccOk,
		erasures,
		repaired: 0,
		kind: '',
		text: '',
	};
}

/** The called station (or area) and the category, which a distress alert does not carry. */
function readAddress(r: SymbolReader, c: DscCall): string {
	if (c.format === 112) {
		c.category = 112;
		return 'all stations';
	}
	let to = '';
	if (c.format === 116) to = 'all ships';
	else if (c.format === 120 || c.format === 114 || c.format === 123) to = dscMmsiLenient(r.take(5));
	else if (c.format === 102) to = areaText(r.take(5));
	c.category = r.next();
	return to;
}

/** Nature, position, time and the type of communication wanted afterwards. */
function readDistressBlock(r: SymbolReader, c: DscCall): void {
	c.nature = r.next();
	c.natureName = dscNatureName(c.nature);
	c.position = dscPositionFromSymbols(r.take(5));
	c.time = dscTimeFromSymbols(r.at(), r.at(1));
	r.take(2);
	c.telecommand2 = r.next();
}

/** Second telecommand, then a position (introduced by 55) or the proposed frequencies. */
function readWorkingInfo(r: SymbolReader, c: DscCall): void {
	c.telecommand2 = r.next();
	const f = Array.from({ length: 6 }, (_, k) => r.at(k));
	const left = r.left;
	if (left >= 6 && f[0] === 55) {
		c.position = dscPositionFromSymbols(f.slice(1));
		if (left >= 8) c.time = dscTimeFromSymbols(r.at(6), r.at(7));
	} else if (left >= 3) {
		c.freqRx = dscFrequencyText(f);
		if (left >= 6) c.freqTx = dscFrequencyText(f.slice(3));
	}
}

/** Parse the merged information symbols of a call (-1 = unreadable), from the format specifier to the last message symbol. */
export function dscParseCall(b: readonly number[], eos: number, eccOk: boolean, erasures: number): DscCall {
	const r = new SymbolReader(b);
	const c = emptyCall(r.next(), eos, eccOk, erasures);
	c.to = readAddress(r, c);
	c.categoryName = dscCategoryName(c.category);
	c.from = dscMmsiLenient(r.take(5));
	if (c.format === 112) readDistressBlock(r, c);
	else {
		c.telecommand1 = r.next();
		if (c.category === 112 && (c.telecommand1 === 110 || c.telecommand1 === 112)) {
			c.distressMmsi = dscMmsiLenient(r.take(5));
			readDistressBlock(r, c);
		} else readWorkingInfo(r, c);
	}
	c.distress = c.format === 112 || c.category === 112;
	c.telecommandText = telecommandText(c);
	c.kind = dscCallKind(c);
	const nature = c.nature >= 0 ? ` - ${c.natureName}` : '';
	const position = c.position ? ` at ${c.position.text}` : '';
	const time = c.time ? ` ${c.time}` : '';
	c.text = `${c.formatName} from ${c.from || '?'} to ${c.to || '?'}${nature}${position}${time}${eccOk ? '' : ' (check failed)'}`;
	return c;
}

/** Labelled details of a call for the log. */
export function dscCallFields(c: DscCall): Array<[string, string]> {
	const station = (mmsi: string) => (mmsiKind(mmsi) ? `${mmsi} (${mmsiKind(mmsi)})` : mmsi);
	const fields: Array<[string, string]> = [
		['Call', c.kind],
		['From', station(c.from) || '?'],
		['To', /^[\d~]{9}$/.test(c.to) ? station(c.to) : c.to || '?'],
		['Category', c.categoryName],
	];
	if (c.distressMmsi) fields.push(['Station in distress', station(c.distressMmsi)]);
	if (c.nature >= 0) fields.push(['Nature', c.natureName]);
	if (c.position) fields.push(['Position', c.position.text]);
	if (c.time) fields.push(['Time', c.time]);
	if (c.telecommandText) fields.push(['Telecommands', c.telecommandText]);
	if (c.freqRx) fields.push(['Frequency (rx)', c.freqRx]);
	if (c.freqTx) fields.push(['Frequency (tx)', c.freqTx]);
	fields.push(['End', c.eos === 117 ? 'Acknowledgement requested' : c.eos === 122 ? 'Acknowledgement' : c.eos === 127 ? 'Other' : '?']);
	fields.push(['Check', c.eccOk ? (c.repaired ? `OK, ${c.repaired} symbol(s) repaired` : 'OK') : `Failed, ${c.erasures} unreadable`]);
	return fields;
}
