// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir rust/onair_dmr/src/text.rs (dd_name, text_from_bytes, alias_pieces,
// TalkerAlias), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: text is a JavaScript string built from code points instead of UTF-8 bytes in a caller buffer, so an unpaired
// UTF-16 surrogate becomes '?' (OnAir writes its three UTF-8 bytes).
//
// DMR text: short data and talker alias text conversion (ETSI TS 102 361-1 table 9.50, TS 102 361-2 7.1.1.4 and
// 7.1.1.5): the defined data formats, clean-up of control characters, and the talker alias assembled from the embedded
// link control of a voice call.
import { bytesToBits, getBits } from './codes';
import { FLCO_TA_BLOCK3, FLCO_TA_HEADER } from './lc';
import type { FullLc } from './types';

export const DD_BINARY = 0;
export const DD_BCD = 1;
export const DD_7BIT = 2;
export const DD_ISO8859_1 = 3;
export const DD_ISO8859_16 = 17;
export const DD_UTF8 = 18;
export const DD_UTF16 = 19;
export const DD_UTF16_BE = 20;
export const DD_UTF16_LE = 21;
export const DD_UTF32 = 22;
export const DD_UTF32_BE = 23;
export const DD_UTF32_LE = 24;

const DD_NAMES: Readonly<Record<number, string>> = {
	[DD_BINARY]: 'binary',
	[DD_BCD]: 'BCD',
	[DD_7BIT]: '7 bit',
	[DD_ISO8859_1]: 'ISO 8859-1',
	[DD_UTF8]: 'UTF-8',
	[DD_UTF16]: 'UTF-16',
	[DD_UTF16_BE]: 'UTF-16BE',
	[DD_UTF16_LE]: 'UTF-16LE',
	[DD_UTF32]: 'UTF-32',
	[DD_UTF32_BE]: 'UTF-32BE',
	[DD_UTF32_LE]: 'UTF-32LE',
};
export const ddName = (dd: number) => DD_NAMES[dd] ?? (dd > DD_ISO8859_1 && dd <= DD_ISO8859_16 ? 'ISO 8859' : 'reserved');

/** A code point the way the clean-up does: CR, LF and TAB become a space, other control characters and DEL are dropped. */
function clean(cp: number): string {
	if (cp === 13 || cp === 10 || cp === 9) return ' ';
	if (cp < 0x20 || cp === 0x7f) return '';
	return cp > 0x10ffff ? '?' : String.fromCodePoint(cp);
}

const trimEnd = (s: string) => s.replace(/ +$/, '');
const UTF8 = new TextDecoder();

function binaryText(p: Uint8Array): string {
	if (p.length && p.every((c) => c >= 0x20 && c <= 0x7e)) return String.fromCharCode(...p);
	const hex = Array.from(p.subarray(0, 24), (c) => c.toString(16).toUpperCase().padStart(2, '0')).join(' ');
	return `[${hex}${p.length > 24 ? ' ...' : ''}]`;
}

/** 7 bit characters packed one after the other (the packing is not given in TS 102 361-1: the talker alias rule is used). */
function sevenBit(p: Uint8Array, count = Infinity): string {
	const bits = bytesToBits(p);
	let s = '';
	for (let i = 0, c = 0; i + 7 <= bits.length && c < count; i += 7, c++) s += clean(getBits(bits, i, 7));
	return trimEnd(s);
}

function utf8Text(p: Uint8Array): string {
	let s = '';
	for (let i = 0; i < p.length;) {
		const c = p[i];
		if (c < 0x80) {
			s += clean(c);
			i++;
			continue;
		}
		const len = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 0;
		let ok = len > 0 && i + len <= p.length;
		for (let k = 1; ok && k < len; k++) ok = (p[i + k] & 0xc0) === 0x80;
		if (ok) {
			s += UTF8.decode(p.subarray(i, i + len));
			i += len;
		} else {
			s += '?';
			i++;
		}
	}
	return trimEnd(s);
}

/** Byte order of UTF-16 text: [little-endian, first unit]; a byte order mark of DD_UTF16 decides, else the label. */
function utf16Order(p: Uint8Array, f: number): [boolean, number] {
	const bom = f === DD_UTF16 && p.length >= 2 && ((p[0] === 0xff && p[1] === 0xfe) || (p[0] === 0xfe && p[1] === 0xff));
	const first = bom ? 2 : 0;
	if (f === DD_UTF16_LE || (bom && p[0] === 0xff)) return [true, first];
	// Import radios (Baofeng, TYT, ...) label UTF-16 text big-endian but send it little-endian (OnAir #300). Latin text
	// shows it: every unit has a zero high byte, so the zeros sit at the odd offsets instead of the even ones.
	let beZ = 0;
	let leZ = 0;
	for (let k = first; k + 1 < p.length; k += 2) {
		if (p[k] === 0 && p[k + 1] !== 0) beZ++;
		else if (p[k + 1] === 0 && p[k] !== 0) leZ++;
	}
	return [leZ > beZ, first];
}

function utf16Text(p: Uint8Array, f: number): string {
	const [le, first] = utf16Order(p, f);
	const unit = (k: number) => (le ? p[k] | (p[k + 1] << 8) : (p[k] << 8) | p[k + 1]);
	let s = '';
	for (let i = first; i + 1 < p.length; i += 2) {
		let cp = unit(i);
		const lo = cp >= 0xd800 && cp < 0xdc00 && i + 3 < p.length ? unit(i + 2) : 0;
		if (lo >= 0xdc00 && lo < 0xe000) {
			cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
			i += 2;
		}
		s += cp >= 0xd800 && cp < 0xe000 ? '?' : clean(cp);
	}
	return trimEnd(s);
}

function utf32Text(p: Uint8Array, f: number): string {
	const view = new DataView(p.buffer, p.byteOffset, p.byteLength);
	let s = '';
	for (let i = 0; i + 3 < p.length; i += 4) s += clean(view.getUint32(i, f === DD_UTF32_LE));
	return trimEnd(s);
}

/** Talker alias two bit format code (0 7 bit, 1 ISO 8859-1, 2 UTF-8, 3 UTF-16BE) as a data format. */
const ALIAS_FORMATS = [DD_7BIT, DD_ISO8859_1, DD_UTF8, DD_UTF16_BE];

/**
 * Message text of short data or a talker alias. `format` is the data format of table 9.50, or with `ta` the talker
 * alias two bit code. Control characters are removed; binary data that is not printable ASCII gives "[hex dump]".
 */
export function textFromBytes(p: Uint8Array, format: number, ta = false): string {
	const f = ta ? ALIAS_FORMATS[format & 3] : format;
	if (f === DD_BINARY) return binaryText(p);
	if (f === DD_BCD) return Array.from(p, (c) => `${((c >> 4) & 15) % 10}${(c & 15) % 10}`).join('');
	if (f === DD_7BIT) return sevenBit(p);
	if (f >= DD_ISO8859_1 && f <= DD_ISO8859_16)
		return trimEnd(Array.from(p, (c) => (c < 0x80 || f === DD_ISO8859_1 ? clean(c) : '?')).join(''));
	if (f === DD_UTF8) return utf8Text(p);
	if (f >= DD_UTF16 && f <= DD_UTF16_LE) return utf16Text(p, f);
	if (f >= DD_UTF32 && f <= DD_UTF32_LE) return utf32Text(p, f);
	return '';
}

/** Number of PDUs a talker alias of `length` characters in `format` needs (header + blocks). */
export function aliasPieces(format: number, length: number): number {
	// 16 bit characters: the header holds 3 characters, the blocks 3.5; the counts of the specification (3, 6, 10, 13) are used
	if (format === 3) return length <= 3 ? 1 : length <= 6 ? 2 : length <= 10 ? 3 : 4;
	const perHeader = format === 0 ? 7 : 6;
	const perBlock = format === 0 ? 8 : 7;
	if (length <= perHeader) return 1;
	return 1 + Math.min(3, Math.floor((length - perHeader + perBlock - 1) / perBlock));
}

/** A talker alias being assembled from the embedded LC of a voice call. */
export class TalkerAlias {
	/** Format code (0 7 bit, 1 ISO 8859-1, 2 UTF-8, 3 UTF-16BE). */
	format = 0;
	/** Number of characters. */
	length = 0;
	/** Bit 0 header, bits 1..3 blocks received. */
	have = 0;
	/** The seven octets (2..8) of the header and of each block. */
	data = new Uint8Array(28);

	clear(): void {
		this.format = 0;
		this.length = 0;
		this.have = 0;
		this.data.fill(0);
	}

	/** Takes in a talker alias header or block LC; other opcodes are ignored. A header starts a new alias. */
	add(lc: FullLc): void {
		if (lc.flco === FLCO_TA_HEADER) {
			this.clear();
			this.format = lc.raw[2] >> 6;
			this.length = (lc.raw[2] >> 1) & 31;
			this.data.set(lc.raw.subarray(2, 9), 0);
			this.have = 1;
		} else if (lc.flco > FLCO_TA_HEADER && lc.flco <= FLCO_TA_BLOCK3) {
			const i = lc.flco - FLCO_TA_HEADER;
			this.data.set(lc.raw.subarray(2, 9), 7 * i);
			this.have |= 1 << i;
		}
	}

	/** True when the header and all blocks the length needs have arrived. */
	complete(): boolean {
		if (!(this.have & 1) || this.length <= 0) return false;
		const n = aliasPieces(this.format, this.length);
		for (let i = 0; i < n; i++) if (!(this.have & (1 << i))) return false;
		return true;
	}

	/** The alias text ('' until complete). */
	text(): string {
		if (!this.complete()) return '';
		if (this.format === 0) {
			// 7 bit: 49 bits in the header (its last bit, then six octets), then 56 per block
			const bits = [this.data[0] & 1, ...bytesToBits(this.data.subarray(1, 7)), ...bytesToBits(this.data.subarray(7, 28))];
			let s = '';
			for (let c = 0; c < this.length && c * 7 + 7 <= bits.length; c++) s += clean(getBits(bits, c * 7, 7));
			return trimEnd(s);
		}
		const bytes = Uint8Array.from([...this.data.subarray(1, 7), ...this.data.subarray(7, 28)]);
		const len = this.format === 3 ? this.length * 2 : this.length;
		return textFromBytes(bytes.subarray(0, Math.min(len, bytes.length)), this.format, true);
	}
}
