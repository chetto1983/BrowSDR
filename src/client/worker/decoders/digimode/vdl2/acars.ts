// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir rust/onair_acars/src/block.rs (block fields), crc.rs (check sequence),
// label.rs (label names, Q label and media advisory readings) and core/src/vdl2/vdl2_proto.cpp (readAcars),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: the detail lines are labelled; the ADS-C, CPDLC
// and position-text readers of readAcars (OnAir's aero code) and the free-text interpreter are not ported.
//
// An ACARS block (ARINC 618) carried in an AVLC information field: after the 0xFF 0xFF prefix, SOH, mode (1), address
// (7), technical ack (1), label (2), block id (1), STX and the text, the suffix ETX or ETB, two check bytes, DEL.
// A downlink (block id is a digit) starts its text with the message number (3), the block sequence letter (1) and the
// flight id (6).

import type { DigimodeAcarsApplication } from '@/worker/decoders/digimode/types';
import { hexNum } from './proto';
import type { Vdl2Acars, Vdl2Line, Vdl2Message } from './types';

const STX = 0x02;
/** Longest text kept (characters). */
const TEXT_CAP = 220;
/** Longest block text sent to the app (ARINC 618 allows 220 characters; the ACARS library's frames are 240 octets at most). */
const BLOCK_TEXT_MAX = 240;

const CRC_TABLE = Uint16Array.from({ length: 256 }, (_, i) => {
	let c = i;
	for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x8408 : c >>> 1;
	return c;
});

/**
 * The block check sequence (ARINC 618 3.2.3.4): CRC-16 of the "KERMIT" kind (reflected 0x8408, start 0, no final xor)
 * over every byte from the mode character to the suffix, then the two check bytes (low first): 0 for a good block.
 */
export function acarsCrc(data: Uint8Array, crc = 0): number {
	let c = crc;
	for (const b of data) c = (c >>> 8) ^ CRC_TABLE[(c ^ b) & 0xff];
	return c;
}

const LABELS: Record<string, string> = {
	_d: 'Command or response',
	Q0: 'Link test',
	SQ: 'Ground station squitter',
	SA: 'Media advisory',
	H1: 'Terminal message',
	'5Z': 'Airline defined downlink',
	Q1: 'OOOI report (out, off, on, in)',
	Q2: 'ETA report',
	QA: 'Gate out',
	QB: 'Wheels off',
	QC: 'Wheels on',
	QD: 'Gate in',
	QE: 'Gate out, destination',
	QF: 'Wheels off, destination',
	QG: 'Gate out and in',
	QH: 'Gate out',
	QK: 'Wheels on, destination',
	QL: 'Gate in, origin and destination',
	QM: 'Origin and destination',
	QN: 'Destination and ETA',
	QP: 'Gate out, origin and destination',
	QQ: 'Wheels off, origin and destination',
	QR: 'Wheels on, origin and destination',
	QS: 'Gate in, origin and destination',
	QT: 'Gate out and in, origin and destination',
	'10': 'Arrival report',
	'15': 'Flight status report',
	'17': 'ETA report',
	'2N': 'Takeoff report',
	'44': 'Position or ETA report',
};

/** Meaning of a label (the DEL of "_<DEL>" written as 'd'); "" when the label is not in the list. */
export const acarsLabelText = (label: string): string => LABELS[label] ?? '';

/** Field layout of the Q labels: which 4 characters of the text hold what. o origin, d destination, O out, F off, N on, I in, E ETA. */
const Q_LAYOUT: Record<string, Array<[string, number]>> = {
	'1': [
		['o', 0],
		['O', 4],
		['F', 8],
		['N', 12],
		['I', 16],
		['d', 24],
	],
	'2': [
		['o', 0],
		['E', 4],
	],
	A: [
		['o', 0],
		['O', 4],
	],
	B: [
		['o', 0],
		['F', 4],
	],
	C: [
		['o', 0],
		['N', 4],
	],
	D: [
		['o', 0],
		['I', 4],
	],
	E: [
		['o', 0],
		['O', 4],
		['d', 8],
	],
	F: [
		['o', 0],
		['F', 4],
		['d', 8],
	],
	G: [
		['o', 0],
		['O', 4],
		['I', 8],
	],
	H: [
		['o', 0],
		['O', 4],
	],
	K: [
		['o', 0],
		['N', 4],
		['d', 8],
	],
	L: [
		['d', 0],
		['I', 8],
		['o', 13],
	],
	M: [
		['d', 0],
		['o', 8],
	],
	N: [
		['d', 4],
		['E', 8],
	],
	P: [
		['o', 0],
		['d', 4],
		['O', 8],
	],
	Q: [
		['o', 0],
		['d', 4],
		['F', 8],
	],
	R: [
		['o', 0],
		['d', 4],
		['N', 8],
	],
	S: [
		['o', 0],
		['d', 4],
		['I', 8],
	],
	T: [
		['o', 0],
		['d', 4],
		['O', 8],
		['I', 12],
	],
};
const Q_NAMES: Record<string, string> = { o: 'from', d: 'to', O: 'out', F: 'off', N: 'on', I: 'in', E: 'eta' };

/** hhmm: hours below 24, tens of minutes below 6. */
const isTime = (s: string, o: number): boolean =>
	/^\d{4}$/.test(s.slice(o, o + 4)) && Number(s.slice(o, o + 2)) < 24 && Number(s[o + 2]) < 6;
const isAirport = (s: string, o: number): boolean => /^[A-Z]{4}$/.test(s.slice(o, o + 4));

/** Media advisory link names (libacars media-adv.c). */
const LINKS: Record<string, string> = {
	V: 'VHF ACARS',
	S: 'default SATCOM',
	H: 'HF',
	G: 'Globalstar',
	C: 'ICO SATCOM',
	'2': 'VDL2',
	X: 'Inmarsat Aero',
	I: 'Iridium',
};

/** Media advisory (label SA): version 0, state E or L, current link, hhmmss, available links, optional "/text". */
function mediaAdvisory(t: string): string {
	if (t.length < 10 || t[0] !== '0' || (t[1] !== 'E' && t[1] !== 'L') || !LINKS[t[2]] || !/^\d{6}$/.test(t.slice(3, 9))) return '';
	const [h, m, s] = [t.slice(3, 5), t.slice(5, 7), t.slice(7, 9)];
	if (Number(h) > 23 || Number(m) > 59 || Number(s) > 59) return '';
	const slash = t.indexOf('/', 9);
	const available = [...t.slice(9, slash < 0 ? t.length : slash)];
	if (available.some((c) => !LINKS[c])) return '';
	const state = t[1] === 'E' ? 'link established' : 'link lost';
	return `${state}: ${LINKS[t[2]]} at ${h}:${m}:${s}, available: ${available.map((c) => LINKS[c]).join(', ')}`;
}

/** Short reading of fixed-format text: the OOOI times and airports of the Q labels and the media advisory (SA); "" when the text does not fit. */
export function acarsDecodeText(label: string, text: string): string {
	if (label === 'SA') return mediaAdvisory(text);
	const fields = label.length === 2 && label[0] === 'Q' ? Q_LAYOUT[label[1]] : undefined;
	if (!fields) return '';
	// check every field first: a text that does not fit gives nothing, not half a reading
	if (!fields.every(([kind, off]) => (kind === 'o' || kind === 'd' ? isAirport(text, off) : isTime(text, off)))) return '';
	return fields.map(([kind, off]) => `${Q_NAMES[kind]} ${text.slice(off, off + 4)}`).join(' ');
}

/** Characters below 0x20 shown as dots. */
const dots = (p: Uint8Array): string => String.fromCharCode(...p.map((c) => (c < 0x20 ? 0x2e : c)));

/** Printable reading of the text: line breaks stay (CR LF counts once), control characters and DEL become '.'. */
function printable(p: Uint8Array): string {
	let s = '';
	for (let i = 0; i < p.length && s.length < TEXT_CAP; i++) {
		const c = p[i];
		if (c === 0x0d && i + 1 < p.length && p[i + 1] === 0x0a) continue;
		s += c === 0x0a || c === 0x0d ? '\n' : c < 0x20 || c === 0x7f ? '.' : String.fromCharCode(c);
	}
	return s;
}

/** H1 sublabel and MFI (libacars acars.c la_acars_extract_sublabel_and_mfi). */
function sublabelAndMfi(a: Vdl2Acars): void {
	const text = a.text;
	let off = 0;
	if (a.downlink && text.length >= 4 && text[0] === '#' && text[3] === 'B') {
		a.sublabel = text.slice(1, 3);
		off = 4;
	} else if (!a.downlink && text.startsWith('- #') && text.length >= 5) {
		a.sublabel = text.slice(3, 5);
		off = 5;
	}
	if (off && text.length - off >= 4 && text[off] === '/' && text[off + 3] === ' ') a.mfi = text.slice(off + 1, off + 3);
}

/** The fields of a good block. `t`: the bytes after SOH up to and including the suffix, parity bits removed. Undefined when the layout is not ACARS. */
export function acarsParseBlock(t: Uint8Array, crcOk = true): Vdl2Acars | undefined {
	const len = t.length;
	if (len < 13 || (t[len - 1] !== 0x03 && t[len - 1] !== 0x17)) return undefined;
	const n = len - 1;
	const reg = t.subarray(1, 8);
	let lead = 0;
	while (lead < 7 && reg[lead] === 0x2e) lead++;
	const label = String.fromCharCode(t[9], t[10] === 0x7f ? 0x64 : t[10]).replace(/[^\x20-\x7e]/g, '.');
	const blockId = t[11] === 0 ? ' ' : String.fromCharCode(t[11]);
	const a: Vdl2Acars = {
		crcOk,
		finalBlock: t[len - 1] === 0x03,
		mode: String.fromCharCode(t[0]),
		reg: dots(reg.subarray(lead)),
		ack: t[8] === 0x15 ? '!' : t[8] === 0x06 ? '^' : String.fromCharCode(t[8]),
		label,
		labelText: acarsLabelText(label),
		blockId,
		downlink: /[0-9]/.test(blockId),
		msgNum: '',
		msgSeq: '',
		flight: '',
		sublabel: '',
		mfi: '',
		text: '',
		raw: '',
		decoded: '',
	};
	if (12 >= n) return a; // an acknowledgement without text
	if (t[12] !== STX) return undefined;
	let p = t.subarray(13, n);
	if (a.downlink && p.length >= 10) {
		a.msgNum = dots(p.subarray(0, 3));
		a.msgSeq = String.fromCharCode(p[3]);
		a.flight = dots(p.subarray(4, 10));
		p = p.subarray(10);
	}
	a.text = printable(p);
	a.raw = String.fromCharCode(...p);
	if (label === 'H1') sublabelAndMfi(a);
	a.decoded = acarsDecodeText(label, a.text);
	return a;
}

/**
 * A good block as the app's ACARS reassembly takes it (the ACARS library's record envelope), with the 24-bit address of
 * the aircraft when the link names it (VDL2). Undefined for a block whose check failed or whose text is too long.
 */
export function acarsApplication(a: Vdl2Acars, aircraft?: number): DigimodeAcarsApplication | undefined {
	if (!a.crcOk || a.raw.length > BLOCK_TEXT_MAX) return undefined;
	const flight = a.flight.trim();
	return {
		kind: 'acars',
		...(aircraft === undefined ? {} : { aircraft: hexNum(aircraft & 0xffffff, 6) }),
		block: {
			label: a.label,
			text: a.raw,
			direction: a.downlink ? 'downlink' : 'uplink',
			registration: a.reg.replace(/[. ]+$/, ''),
			mode: a.mode,
			acknowledgement: a.ack === '!' ? 'NAK' : a.ack,
			blockId: a.blockId,
			...(a.msgNum ? { messageNumber: a.msgNum + a.msgSeq } : {}),
			...(flight ? { flight } : {}),
			continuation: !a.finalBlock,
		},
	};
}

/** The ACARS summary line: label, its meaning, flight and the start of the text. */
export function acarsSummary(a: Vdl2Acars): string {
	const one = a.text.replace(/[\r\n]/g, ' ');
	const text = one ? `: ${one.length > 80 ? `${one.slice(0, 80)}...` : one}` : '';
	return `ACARS ${a.label}${a.labelText ? ` (${a.labelText})` : ''}${a.flight ? ` ${a.flight}` : ''}${text}`;
}

/** Decodes the ACARS block of a frame; `p` starts at the SOH (mode .. suffix, check bytes, an optional DEL). */
export function readAcars(p: Uint8Array, m: Vdl2Message): void {
	m.proto = 'ACARS';
	let end = p.length;
	if (end && p[end - 1] === 0x7f) end--;
	if (end < 1 + 13 + 2) {
		m.summary = 'ACARS: cut short';
		m.detail.push(['ACARS', `${p.length} octets, too short`]);
		return;
	}
	const blk = p.subarray(1, end);
	const bl = end - 1 - 2; // mode .. suffix
	const a = acarsParseBlock(
		blk.subarray(0, bl).map((c) => c & 0x7f),
		acarsCrc(blk.subarray(0, bl + 2)) === 0,
	);
	if (!a) {
		m.summary = 'ACARS: not a valid block';
		m.detail.push(['ACARS', 'the block layout is not valid']);
		return;
	}
	m.acars = a;
	m.summary = acarsSummary(a);
	m.detail.push(...acarsLines(a));
}

/** The detail lines of a decoded block (also those of the ACARS blocks HFDL carries). */
export function acarsLines(a: Vdl2Acars): Vdl2Line[] {
	const state = (a.crcOk ? '' : ', check sequence FAILED') + (a.finalBlock ? '' : ', more blocks follow');
	const lines: Vdl2Line[] = [['ACARS', `mode ${a.mode}, ${a.downlink ? 'downlink' : 'uplink'}${state}`]];
	lines.push(['Registration', a.reg || '-']);
	if (a.flight) lines.push(['Flight', a.flight]);
	lines.push(['Label', a.label + (a.labelText ? ` (${a.labelText})` : '')]);
	lines.push(['Block id', a.blockId]);
	if (a.msgNum) lines.push(['Message number', a.msgNum + a.msgSeq]);
	if (a.sublabel || a.mfi) lines.push(['Sublabel / MFI', `${a.sublabel || '-'} / ${a.mfi || '-'}`]);
	lines.push(['Acknowledgement', a.ack === '!' ? 'NAK (nothing acknowledged)' : a.ack === '^' ? 'ACK' : `block ${a.ack}`]);
	if (a.text) lines.push(['Text', a.text]);
	if (a.decoded) lines.push(['Reading', a.decoded]);
	return lines;
}
