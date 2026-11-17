// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/fusion/fusion_rx.cpp (FusionReceiver::Impl::onFrame, beginTx,
// endTx, csd1, csd2, csd3, slow, remText, voice), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the transmission state fills BrowSDR's YsfStatus instead of FusionTelemetry, and voice goes to BrowSDR's
// mbelib WASM for all three kinds: V/D mode 1 as OnAir sends it to mbelib (the DMR / NXDN AMBE+2 frame), V/D mode 2 as
// 49 error-corrected AMBE 2450 parameter bits and voice FR as a P25 IMBE frame (OnAir hands those two to a codec plug-in).
// No voice monitor, audio device or call log.
import { ambeFrame, imbeFrame, unpackBits } from '@/worker/decoders/dsd/ambe';
import { decodeAmbe, decodeAmbe2450, decodeImbe } from '@/worker/decoders/mbelib-init';
import type { YsfStatus } from '@/worker/decoders/dsd/types';
import { ysfGpsParse } from './gps';
import { trimField } from './proto';
import type { YsfFrameContent, YsfFrameRead, YsfVoiceUnit } from './types';

const MODES = ['DN', 'Data', 'DN', 'VW'];
const SLOW_CHUNKS = 13;

/** Printable fields as text, others as hex. */
function remText(p: Uint8Array, start: number, n: number): string {
	let printable = true;
	for (let i = 0; i < n; i++) if (p[start + i] !== 0 && (p[start + i] < 32 || p[start + i] > 126)) printable = false;
	if (printable) return trimField(p, start, n);
	let s = '';
	for (let i = 0; i < n; i++) s += p[start + i].toString(16).toUpperCase().padStart(2, '0');
	return s;
}

function fresh(): YsfStatus {
	return {
		mode: 'DN',
		dataType: 0,
		frameType: 0,
		src: '',
		dest: '',
		down: '',
		up: '',
		rem: ['', '', '', ''],
		dgId: 0,
		callMode: 0,
		routing: 0,
		voip: false,
		text: '',
		frames: 0,
		ended: false,
		inverted: false,
		snrDb: 0,
	};
}

/** One Yaesu System Fusion transmission at a time: header, communication frames, terminator. */
export class YsfCall {
	private tel: YsfStatus | null = null;
	private txOn = false;
	private chunks: string[] = new Array<string>(SLOW_CHUNKS).fill('');
	private chunkHave: boolean[] = new Array<boolean>(SLOW_CHUNKS).fill(false);
	private gpsBuf = new Uint8Array(300);
	private gpsLen = 0;

	get status(): YsfStatus | undefined {
		return this.tel ? { ...this.tel, rem: [...this.tel.rem], gps: this.tel.gps && { ...this.tel.gps } } : undefined;
	}

	reset(): void {
		this.tel = null;
		this.txOn = false;
	}

	/** A frame whose FICH checked: updates the transmission and returns its voice sub-frames. */
	onFrame(read: YsfFrameRead): YsfVoiceUnit[] {
		const c = read.content;
		const f = c.fich;
		if (f.fi === 3) return []; // test frame
		if (f.fi === 0) this.beginTx();
		else if (f.fi === 1 && !this.txOn) this.beginTx();
		const tel = (this.tel ??= fresh());
		Object.assign(tel, {
			frameType: f.fi,
			dataType: f.dt,
			mode: MODES[f.dt],
			callMode: f.cm,
			routing: f.mr,
			voip: f.voip === 1,
			dgId: f.sqlCode,
			inverted: read.inverted,
			snrDb: read.snrDb,
		});
		tel.frames++;
		for (let i = 0; i < c.units.length; i++) if (c.unitOk[i]) this.unit(c, i);
		if (f.fi === 2) {
			tel.ended = true;
			this.txOn = false;
		}
		return c.voice;
	}

	private beginTx(): void {
		this.txOn = true;
		this.tel = fresh();
		this.chunks.fill('');
		this.chunkHave.fill(false);
		this.gpsBuf.fill(0);
		this.gpsLen = 0;
	}

	private unit(c: YsfFrameContent, i: number): void {
		const f = c.fich;
		const p = c.units[i];
		if (f.fi === 0 || f.fi === 2) {
			if (i === 0) this.csd1(p);
			else this.csd2(p);
		} else if (f.dt === 0) {
			// V/D mode 1: FN 0..2 callsign data 1..3, then slow data of 20 bytes
			this.csdOrSlow(f.fn, p, 20);
		} else if (f.dt === 2) {
			this.vd2Unit(f.fn, p);
		} else if (f.dt === 1) {
			// data FR: two units a frame, CSD1, CSD2, CSD3, then data
			this.csdOrSlow(2 * f.fn + i, p, 20);
		} else if (f.fn === 0 && f.ft === 1) this.csd3(p);
	}

	private csdOrSlow(index: number, p: Uint8Array, n: number): void {
		if (index === 0) this.csd1(p);
		else if (index === 1) this.csd2(p);
		else if (index === 2) this.csd3(p);
		else this.slow(index - 3, p, n);
	}

	/** V/D mode 2: FN 0..5 in 10 byte fields, then slow data of 10 bytes. */
	private vd2Unit(fn: number, p: Uint8Array): void {
		const tel = this.tel!;
		if (fn === 0) tel.dest = trimField(p, 0, 10);
		else if (fn === 1) tel.src = trimField(p, 0, 10);
		else if (fn === 2) tel.down = trimField(p, 0, 10);
		else if (fn === 3) tel.up = trimField(p, 0, 10);
		else if (fn === 4 || fn === 5) {
			tel.rem[2 * (fn - 4)] = remText(p, 0, 5);
			tel.rem[2 * (fn - 4) + 1] = remText(p, 5, 5);
		} else this.slow(fn - 6, p, 10);
	}

	private csd1(p: Uint8Array): void {
		this.tel!.dest = trimField(p, 0, 10);
		this.tel!.src = trimField(p, 10, 10);
	}

	private csd2(p: Uint8Array): void {
		this.tel!.down = trimField(p, 0, 10);
		this.tel!.up = trimField(p, 10, 10);
	}

	private csd3(p: Uint8Array): void {
		for (let i = 0; i < 4; i++) this.tel!.rem[i] = remText(p, 5 * i, 5);
	}

	private slow(idx: number, p: Uint8Array, n: number): void {
		if (idx < 0 || idx >= SLOW_CHUNKS) return;
		let chunk = '';
		for (let i = 0; i < n; i++) chunk += p[i] >= 32 && p[i] < 127 ? String.fromCharCode(p[i]) : ' ';
		this.chunks[idx] = chunk;
		this.chunkHave[idx] = true;
		if (idx * n + n <= this.gpsBuf.length) {
			this.gpsBuf.set(p.subarray(0, n), idx * n);
			this.gpsLen = Math.max(this.gpsLen, (idx + 1) * n);
			const g = ysfGpsParse(this.gpsBuf, this.gpsLen);
			if (g.ok) this.tel!.gps = { lat: g.lat, lon: g.lon, radio: g.radio };
		}
		this.tel!.text = this.chunks
			.filter((_, i) => this.chunkHave[i])
			.join('')
			.replace(/ +$/, '');
	}
}

/** A voice sub-frame through mbelib: 160 samples at 8 kHz. */
export function decodeYsfVoice(unit: YsfVoiceUnit): Float32Array {
	if (unit.kind === 2) return decodeAmbe2450(unpackBits(unit.bytes, 49), unit.errors ?? 0);
	if (unit.kind === 1) return decodeAmbe(ambeFrame(unpackBits(unit.bytes, 72)));
	return decodeImbe(imbeFrame(unpackBits(unit.bytes, 144)));
}
