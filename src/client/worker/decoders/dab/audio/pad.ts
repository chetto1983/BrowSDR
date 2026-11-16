// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir rust/onair_dab/src/pad.rs (pad_from_au, pad_split, dls_step, dl_segment) and
// core/src/dab/dab_pad.cpp (DabPadDecoder: accessUnit, pad, subfield, labelSegment), https://github.com/adswill/OnAir; see
// third_party/onair. Changes: only the dynamic label (X-PAD application types 2 and 3) is assembled; data groups, MOT,
// the slide show and DL Plus are not ported.

import { crc16 } from '@/worker/decoders/dab/fec/crc';
import { labelText } from '@/worker/decoders/dab/fic/charset';
import type { DlSegment, DlsStep, PadSub } from './types';

/** X-PAD subfield length by length index (EN 300 401 table 30). */
const SUBFIELD_LEN = [4, 6, 8, 12, 16, 24, 32, 48];

const tail16 = (d: Uint8Array, n: number) => (n < 2 ? 0 : (d[n - 2] << 8) | d[n - 1]);

/**
 * A dynamic label segment collected so far: a label segment has a 2-byte prefix, 1 to 16 characters and a CRC-16; a
 * command has no data (clear display) or a few bytes (DL Plus), its length being the one the CRC agrees with.
 */
export function dlsStep(dls: Uint8Array, n: number): DlsStep {
	if (n < 2) return { action: 0, segLen: 0 };
	const crcOk = (total: number) => n >= total && crc16(dls, total - 2) === tail16(dls, total);
	if ((dls[0] & 0x10) === 0) {
		const total = 2 + (dls[0] & 0x0f) + 1 + 2;
		if (n < total) return { action: 0, segLen: 0 };
		return crcOk(total) ? { action: 2, segLen: total - 2 } : { action: 1, segLen: 0 };
	}
	const most = (dls[0] & 0x0f) === 1 ? 0 : 16;
	for (let l = 0; l <= most; l++) if (crcOk(2 + l + 2)) return { action: 2, segLen: 2 + l };
	return n >= 2 + most + 2 ? { action: 1, segLen: 0 } : { action: 0, segLen: 0 };
}

/** The 2-byte prefix of a label segment. */
export function dlSegment(d: Uint8Array): DlSegment {
	const b0 = d[0] ?? 0,
		b1 = d[1] ?? 0;
	const first = (b0 & 0x40) !== 0;
	return {
		toggle: b0 >> 7,
		first,
		last: (b0 & 0x20) !== 0,
		cmd: (b0 & 0x10) !== 0,
		code: b0 & 0x0f,
		segNo: first ? 0 : (b1 >> 4) & 7,
		charset: b1 >> 4,
	};
}

/** The dynamic label in the PAD of DAB+ access units (TS 102 563 clause 5.2, EN 300 401 clause 7.4). */
export class PadDecoder {
	private readonly xpad = new Uint8Array(512);
	private readonly fpad = new Uint8Array(2);
	/** Application type of the last content indicator, for X-PAD without one. */
	private lastType = 0;
	private readonly dls = new Uint8Array(512);
	private dlsLen = 0;
	private dlsOn = false;
	private toggle = -1;
	private parts = new Map<number, Uint8Array>();
	private lastSeg = -1;
	private charset = 0;
	label = '';

	constructor(private readonly onLabel: (text: string) => void) {}

	reset(): void {
		this.lastType = 0;
		this.dlsLen = 0;
		this.dlsOn = false;
		this.toggle = -1;
		this.parts.clear();
		this.lastSeg = -1;
		this.label = '';
	}

	/**
	 * One access unit (CRC removed). The data stream element (id_syn_ele 4) that carries the PAD comes first; its bytes
	 * are in the order of EN 300 401 figure 29: the two F-PAD bytes last, the X-PAD reversed in front of them.
	 */
	accessUnit(au: Uint8Array, n: number): void {
		if (n < 4 || au[0] >> 5 !== 4) return;
		let pos = 2,
			cnt = au[1];
		if (cnt === 255) {
			cnt += au[2];
			pos = 3;
		}
		if (cnt < 2 || pos + cnt > n) return;
		const xlen = cnt - 2;
		for (let k = 0; k < xlen; k++) this.xpad[k] = au[pos + cnt - 3 - k];
		this.fpad[0] = au[pos + cnt - 2];
		this.fpad[1] = au[pos + cnt - 1];
		for (const s of this.split(xlen)) this.subfield(s.type, this.xpad.subarray(s.off, s.off + s.len));
	}

	/** The application subfields of one X-PAD (EN 300 401 clause 7.4.2). */
	private split(length: number): PadSub[] {
		const xp = this.xpad,
			fpad = this.fpad;
		const ind = (fpad[0] >> 4) & 3;
		const ci = (fpad[1] & 2) !== 0;
		if (fpad[0] >> 6 !== 0 || (ind !== 1 && ind !== 2) || length <= 0) return [];
		const xlen = ind === 1 ? Math.min(length, 4) : length;
		const subs: Array<[number, number]> = [];
		let pos = 0;
		if (ci) {
			if (ind === 1) {
				subs.push([xp[0] & 0x1f, 3]);
				pos = 1;
			} else {
				let i = 0;
				while (i < 4 && i < xlen) {
					const t = xp[i] & 0x1f;
					i++;
					if (t === 0) break;
					subs.push([t, SUBFIELD_LEN[xp[i - 1] >> 5]]);
				}
				pos = i;
			}
			if (subs.length) this.lastType = subs[subs.length - 1][0];
		} else {
			const t = this.lastType === 12 ? 13 : this.lastType === 2 ? 3 : this.lastType;
			if (t === 0) return [];
			subs.push([t, xlen]);
		}
		const out: PadSub[] = [];
		for (const [type, l] of subs) {
			const len = Math.min(l, xlen - pos);
			if (len <= 0) break;
			out.push({ type, off: pos, len });
			pos += len;
		}
		return out;
	}

	/** Dynamic label subfields: segments of a 2-byte prefix, up to 16 characters and a CRC-16. */
	private subfield(type: number, d: Uint8Array): void {
		if (type !== 2 && type !== 3) return;
		if (type === 2) {
			this.dlsLen = 0;
			this.dlsOn = true;
		}
		if (!this.dlsOn) return;
		const take = Math.min(d.length, this.dls.length - this.dlsLen);
		this.dls.set(d.subarray(0, take), this.dlsLen);
		this.dlsLen += take;
		if (this.dlsLen < 2) return;
		const st = dlsStep(this.dls, this.dlsLen);
		if (st.action === 2) {
			this.dlsOn = false;
			this.segment(this.dls.slice(0, st.segLen));
		} else if (st.action === 1) this.dlsOn = false;
	}

	/** One label segment without its CRC; the label is complete when segments 0 .. last are all in. */
	private segment(d: Uint8Array): void {
		const sg = dlSegment(d);
		if (sg.cmd) {
			if (sg.code === 1) {
				// command 1: clear the display
				this.parts.clear();
				this.lastSeg = -1;
				this.emit('');
			}
			return;
		}
		const text = d.subarray(2);
		const first = this.parts.get(0);
		if (sg.toggle !== this.toggle || (sg.first && first && !same(first, text))) {
			this.parts.clear(); // a new label
			this.lastSeg = -1;
			this.toggle = sg.toggle;
		}
		if (sg.first) this.charset = sg.charset;
		this.parts.set(sg.segNo, text);
		if (sg.last) this.lastSeg = sg.segNo;
		if (this.lastSeg < 0 || this.parts.size !== this.lastSeg + 1 || !this.parts.has(0)) return;
		const all: number[] = [];
		for (let i = 0; i <= this.lastSeg; i++) {
			const p = this.parts.get(i);
			if (!p) return;
			all.push(...p);
		}
		this.emit(labelText(this.charset, Uint8Array.from(all)));
	}

	private emit(text: string): void {
		if (text === this.label) return;
		this.label = text;
		this.onLabel(text);
	}
}

function same(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}
