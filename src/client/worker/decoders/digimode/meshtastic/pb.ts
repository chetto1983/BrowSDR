// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir rust/onair_mesh/src/pb.rs (the Protocol Buffers reader of the Meshtastic
// messages: varint, fixed64, length-delimited and fixed32 fields; groups and reserved wire types end the message;
// repeated fixed32 / varint helpers), https://github.com/adswill/OnAir; see third_party/onair. Changes: a varint keeps
// its low 32 bits exactly (`lo`) next to its value as a double (exact up to 2^53).

import type { PbField } from './types';

export const asI32 = (f: PbField): number => f.lo | 0;
export const asSint32 = (f: PbField): number => ((f.lo >>> 1) ^ -(f.lo & 1)) | 0;
const f32 = new DataView(new ArrayBuffer(4));
export function asF32(f: PbField): number {
	f32.setUint32(0, f.lo);
	return f32.getFloat32(0);
}

/** Walks the fields of one message; next() is undefined at the end or on a malformed field (then ok is false). */
export class PbReader {
	private pos = 0;
	ok = true;
	constructor(private readonly buf: Uint8Array) {}

	/** A varint of at most 10 bytes into value and lo; false when cut short. */
	private varint(out: { value: number; lo: number }): boolean {
		let value = 0,
			lo = 0;
		for (let i = 0; i < 10; i++) {
			if (this.pos >= this.buf.length) return false;
			const b = this.buf[this.pos++];
			value += (b & 0x7f) * 2 ** (7 * i);
			if (i < 5) lo |= (b & 0x7f) << (7 * i);
			if (!(b & 0x80)) {
				out.value = value;
				out.lo = lo >>> 0;
				return true;
			}
		}
		return false;
	}

	next(): PbField | undefined {
		if (!this.ok || this.pos >= this.buf.length) return;
		const key = { value: 0, lo: 0 };
		if (!this.varint(key)) return this.fail();
		const num = Math.floor(key.value / 8) >>> 0,
			wire = key.lo & 7;
		if (num === 0) return this.fail();
		const f: PbField = { num, wire, value: 0, lo: 0, data: new Uint8Array(0) };
		const rest = this.buf.length - this.pos;
		if (wire === 0) {
			if (!this.varint(f)) return this.fail();
		} else if (wire === 1 || wire === 5) {
			const n = wire === 1 ? 8 : 4;
			if (rest < n) return this.fail();
			for (let i = 0; i < n; i++) f.value += this.buf[this.pos + i] * 2 ** (8 * i);
			f.lo = (this.buf[this.pos] | (this.buf[this.pos + 1] << 8) | (this.buf[this.pos + 2] << 16) | (this.buf[this.pos + 3] << 24)) >>> 0;
			this.pos += n;
		} else if (wire === 2) {
			const len = { value: 0, lo: 0 };
			if (!this.varint(len) || len.value > this.buf.length - this.pos) return this.fail();
			f.data = this.buf.subarray(this.pos, this.pos + len.value);
			this.pos += len.value;
		} else return this.fail();
		return f;
	}

	private fail(): undefined {
		this.ok = false;
		return undefined;
	}
}

/** Each value of a repeated fixed32 field, packed or not (a partial trailing group of a packed field is ignored). */
export function eachFixed32(f: PbField, cb: (v: number) => void): void {
	if (f.wire === 5) cb(f.lo);
	else if (f.wire === 2)
		for (let i = 0; i + 4 <= f.data.length; i += 4)
			cb((f.data[i] | (f.data[i + 1] << 8) | (f.data[i + 2] << 16) | (f.data[i + 3] << 24)) >>> 0);
}

/** Each value (low 32 bits) of a repeated varint field, packed or not (a varint cut short by the end of the field is still reported). */
export function eachVarint(f: PbField, cb: (lo: number) => void): void {
	if (f.wire === 0) cb(f.lo);
	else if (f.wire === 2) {
		const d = f.data;
		let p = 0;
		while (p < d.length) {
			let lo = 0;
			for (let i = 0; i < 10 && p < d.length; i++) {
				const b = d[p++];
				if (i < 5) lo |= (b & 0x7f) << (7 * i);
				if (!(b & 0x80)) break;
			}
			cb(lo >>> 0);
		}
	}
}
