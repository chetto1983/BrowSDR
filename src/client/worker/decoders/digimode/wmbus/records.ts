// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/wmbus/wmbus_proto.cpp (parseRecords, VIF and VIF-extension tables,
// data lengths, number formatting), https://github.com/adswill/OnAir; see third_party/onair. Changes: the VIF ranges are a
// table; 64-bit integers are read as BigInt; the record reader is split into DIF, VIF and value steps.

import type { WmbusRecord, WmbusRecords, WmbusVif } from './types';

const TIME_UNITS = ['s', 'min', 'h', 'd'];

/**
 * Primary VIFs (EN 13757-3): [last VIF of the range, quantity, unit (null: s / min / h / d from the two low bits),
 * mask of the exponent bits, exponent of the first code]; a null quantity is a reserved code.
 */
const VIF_RANGES: ReadonlyArray<readonly [number, string | null, string | null, number, number]> = [
	[0x07, 'Energy', 'Wh', 7, -3],
	[0x0f, 'Energy', 'J', 7, 0],
	[0x17, 'Volume', 'm3', 7, -6],
	[0x1f, 'Mass', 'kg', 7, -3],
	[0x23, 'On time', null, 0, 0],
	[0x27, 'Operating time', null, 0, 0],
	[0x2f, 'Power', 'W', 7, -3],
	[0x37, 'Power', 'J/h', 7, 0],
	[0x3f, 'Volume flow', 'm3/h', 7, -6],
	[0x47, 'Volume flow', 'm3/min', 7, -7],
	[0x4f, 'Volume flow', 'm3/s', 7, -9],
	[0x57, 'Mass flow', 'kg/h', 7, -3],
	[0x5b, 'Flow temperature', 'C', 3, -3],
	[0x5f, 'Return temperature', 'C', 3, -3],
	[0x63, 'Temperature difference', 'K', 3, -3],
	[0x67, 'External temperature', 'C', 3, -3],
	[0x6b, 'Pressure', 'bar', 3, -3],
	[0x6c, 'Date', '', 0, 0],
	[0x6d, 'Date and time', '', 0, 0],
	[0x6e, 'Units for heat cost allocators', '', 0, 0],
	[0x6f, null, '', 0, 0],
	[0x73, 'Averaging duration', null, 0, 0],
	[0x77, 'Actuality duration', null, 0, 0],
	[0x78, 'Fabrication number', '', 0, 0],
	[0x79, 'Enhanced identification', '', 0, 0],
	[0x7a, 'Bus address', '', 0, 0],
];

function vifLookup(vif: number): WmbusVif | null {
	const v = vif & 0x7f;
	const range = VIF_RANGES.find(([last]) => v <= last);
	if (!range || range[1] === null) return null;
	const [, name, unit, mask, first] = range;
	return { name, unit: unit ?? TIME_UNITS[v & 3], exp: unit === null ? 0 : (v & mask) + first };
}

/** First extension table of VIF 0xFD. */
const FD_NAMES = new Map<number, string>([
	[0x08, 'Access number'],
	[0x09, 'Medium'],
	[0x0a, 'Manufacturer'],
	[0x0b, 'Parameter set identification'],
	[0x0c, 'Model / version'],
	[0x0d, 'Hardware version'],
	[0x0e, 'Firmware version'],
	[0x0f, 'Software version'],
	[0x10, 'Customer location'],
	[0x11, 'Customer'],
	[0x17, 'Error flags'],
	[0x74, 'Remaining battery life (days)'],
]);

/** Data length of each DIF data field code; -1 is the variable length of code 13. */
const DATA_LENGTHS = [0, 1, 2, 3, 4, 4, 6, 8, 0, 1, 2, 3, 4, -1, 6, 0];

const hex2 = (value: number) => value.toString(16).toUpperCase().padStart(2, '0');

function fmtNum(v: number, exp: number): string {
	return exp < 0 ? (v / 10 ** -exp).toFixed(Math.min(-exp, 9)) : (v * 10 ** exp).toFixed(0);
}

const FUNCTIONS = ['', 'max', 'min', 'error'];

/** Reads DIF, VIF and value of one record after the other; every step returns null when the payload ends too soon. */
class RecordReader {
	i = 0;
	manufacturerData = false;

	constructor(private readonly d: Uint8Array) {}

	get more(): boolean {
		return this.i < this.d.length;
	}

	/** DIF and DIFE into a new record; null for filler (record: false) or the start of manufacturer data. */
	dif(): WmbusRecord | false | null {
		const d = this.d;
		const dif = d[this.i++];
		if (dif === 0x2f) return false; // idle filler
		if (dif === 0x0f || dif === 0x1f || dif === 0x7f) {
			this.manufacturerData = true;
			return null;
		}
		const r: WmbusRecord = {
			storage: (dif >> 6) & 1,
			dif,
			tariff: 0,
			subunit: 0,
			func: (dif >> 4) & 3,
			quantity: '',
			value: '',
			note: '',
			number: 0,
			numeric: false,
		};
		let shift = 1;
		let ext = dif & 0x80;
		for (let k = 0; ext && k < 10; k++) {
			if (!this.more) return null;
			const e = d[this.i++];
			r.storage += (e & 15) * 2 ** shift; // at most 10 DIFE: 41 bits, exact in a double
			shift += 4;
			r.tariff |= ((e >> 4) & 3) << (2 * k);
			r.subunit |= ((e >> 6) & 1) << k;
			ext = e & 0x80;
		}
		return r;
	}

	/** VIF and VIFE: the quantity, its unit and exponent; null when the payload ends. */
	vif(r: WmbusRecord): { vif: number; vi: WmbusVif; known: boolean } | null {
		const d = this.d;
		if (!this.more) return null;
		const vif = d[this.i++];
		let vi: WmbusVif = { name: '', unit: '', exp: 0 };
		let known: boolean;
		let ext = 0;
		if (vif === 0xfd || vif === 0xfb) {
			if (!this.more) return null;
			const c = d[this.i++];
			const name = vif === 0xfd ? FD_NAMES.get(c & 0x7f) : undefined;
			r.quantity = name ?? `VIF ${hex2(vif)} ${hex2(c)}`;
			known = name !== undefined;
			ext = c & 0x80;
		} else if (vif === 0x7c) {
			if (!this.more) return null;
			const length = d[this.i++];
			if (this.i + length > d.length) return null;
			r.quantity = String.fromCharCode(...d.slice(this.i, this.i + length).reverse());
			this.i += length;
			known = true;
		} else {
			const found = vifLookup(vif);
			if (found) vi = found;
			known = found !== null;
			r.quantity = found ? found.name : `VIF ${hex2(vif & 0x7f)}`;
			ext = vif & 0x80;
			if ((vif & 0x7f) === 0x7f) {
				r.quantity = 'manufacturer specific';
				known = true;
			}
		}
		for (let k = 0; ext && k < 10; k++) {
			// VIFE: combinable extensions, skipped
			if (!this.more) return null;
			ext = d[this.i++] & 0x80;
		}
		return { vif, vi, known };
	}

	/** The value bytes; false when the payload ends, null for a variable length that starts manufacturer data. */
	value(r: WmbusRecord): { p: Uint8Array; code: number } | false | null {
		let length = DATA_LENGTHS[r.dif & 15];
		let code = r.dif & 15;
		if (length < 0) {
			if (!this.more) return false;
			const lvar = this.d[this.i++];
			if (lvar >= 0xc0) {
				this.manufacturerData = true; // binary variable length: shown raw
				return null;
			}
			length = lvar;
			code = 13;
		}
		if (this.i + length > this.d.length) return false;
		const p = this.d.subarray(this.i, this.i + length);
		this.i += length;
		return { p, code };
	}
}

/** Two's complement integer of 1 to 8 little-endian bytes, as a number and as exact text. */
function signedInteger(p: Uint8Array): [number, string] {
	if (p.length === 8) {
		let u = 0n;
		for (let k = 7; k >= 0; k--) u = (u << 8n) | BigInt(p[k]);
		const sv = BigInt.asIntN(64, u);
		return [Number(sv), sv.toString()];
	}
	let u = 0;
	for (let k = p.length - 1; k >= 0; k--) u = u * 256 + p[k];
	const sv = p.length && p[p.length - 1] & 0x80 ? u - 2 ** (8 * p.length) : u;
	return [sv, String(sv)];
}

function bcdValue(p: Uint8Array): number {
	let v = 0;
	let negative = false;
	for (let k = p.length - 1; k >= 0; k--) {
		let hi = p[k] >> 4;
		const lo = p[k] & 15;
		if (k === p.length - 1 && hi === 0xf) {
			negative = true;
			hi = 0;
		}
		v = v * 100 + hi * 10 + lo;
	}
	return negative ? -v : v;
}

const pad = (value: number, digits = 2) => String(value).padStart(digits, '0');

/** Formats the value of a record from its data field code (EN 13757-3 data types A, B, F, G, H and text). */
function setValue(r: WmbusRecord, p: Uint8Array, code: number, vif: number, vi: WmbusVif, known: boolean): void {
	const length = p.length;
	if (code === 0 || code === 8 || code === 15) r.value = '-';
	else if (code === 13)
		r.value = [...p]
			.reverse()
			.map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '.'))
			.join('');
	else if (code === 5) {
		r.number = new DataView(p.buffer, p.byteOffset, 4).getFloat32(0, true);
		r.numeric = true;
		r.value = fmtNum(r.number, vi.exp);
	} else if ((code >= 9 && code <= 12) || code === 14) {
		r.number = bcdValue(p);
		r.numeric = true;
		r.value = fmtNum(r.number, vi.exp);
	} else {
		const [sv, text] = signedInteger(p);
		const vc = vif & 0x7f;
		if (vif === 0x6c && length === 2) {
			const year = 2000 + (((p[0] & 0xe0) >> 5) | ((p[1] & 0xf0) >> 1));
			r.value = `${pad(year, 4)}-${pad(p[1] & 15)}-${pad(p[0] & 31)}`;
		} else if (vif === 0x6d && length === 4) {
			const year = 2000 + (((p[2] & 0xe0) >> 5) | ((p[3] & 0xf0) >> 1));
			r.value = `${pad(year, 4)}-${pad(p[3] & 15)}-${pad(p[2] & 31)} ${pad(p[1] & 31)}:${pad(p[0] & 63)}`;
		} else {
			r.number = sv;
			r.numeric = true;
			r.value = known && vc !== 0x7f && vc !== 0x7c ? fmtNum(sv, vi.exp) : text;
		}
	}
	if (vi.unit && r.value !== '-') r.value += ` ${vi.unit}`;
}

function setNote(r: WmbusRecord): void {
	const parts: string[] = [];
	if (r.storage) parts.push(`storage ${r.storage}`);
	if (r.tariff) parts.push(`tariff ${r.tariff}`);
	if (r.subunit) parts.push(`subunit ${r.subunit}`);
	if (r.func) parts.push(FUNCTIONS[r.func]);
	r.note = parts.join(', ');
}

/** The data records of an application payload (DIF / VIF); `complete` is false when it ends in the middle of a record. */
export function parseRecords(d: Uint8Array): WmbusRecords {
	const reader = new RecordReader(d);
	const records: WmbusRecord[] = [];
	const result = (complete: boolean): WmbusRecords => ({ complete, records, manufacturerData: reader.manufacturerData });
	while (reader.more) {
		const r = reader.dif();
		if (r === false) continue;
		// null: manufacturer data follows (complete), or the payload ended inside the DIFE (cut off)
		if (r === null) return result(reader.manufacturerData);
		const vif = reader.vif(r);
		if (!vif) return result(false);
		const value = reader.value(r);
		if (value === false) return result(false);
		if (value === null) return result(true);
		setValue(r, value.p, value.code, vif.vif, vif.vi, vif.known);
		setNote(r);
		records.push(r);
	}
	return result(true);
}
