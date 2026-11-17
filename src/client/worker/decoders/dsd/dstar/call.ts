// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/dstar/dstar_rx.cpp (DstarReceiver::Impl: lsFit, trimmed, levels,
// startHeader, startLate, readBit, onHeader, onFrame, updateBer, slowBlock, gpsLine, beginTx, applyHeader, endTx),
// https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the bits come from BrowSDR's 4800 symbols/s DSD chain (its RRC filter and clock recovery; the decoder found
// the frame or data sync), so OnAir's mixer, frequency capture, mirrored front end, bit timing and channel power
// measurement are left out: the level and offset are fitted on the sync and tracked bit by bit as in readBit. A call
// joined late starts on one data sync (OnAir waits for two) and is reported once a second one checks. The header repair
// from heard callsigns (dstar_repair.cpp) is left out. The voice goes to the decoder's mbelib in DSD's AMBE bit order.
import { DSTAR_W, DSTAR_X, SYNC_WORDS } from '@/worker/decoders/dsd/constants';
import { SyncType } from '@/worker/decoders/dsd/types';
import type { DsdChain, DsdEvent, DsdSink } from '@/worker/decoders/dsd/types';
import { parseDprs, parseNmea } from './gps';
import {
	DATA_SYNC,
	END_PATTERN,
	FRAME_BITS,
	HEADER_BITS,
	HEADER_BYTES,
	SLOW_SCRAMBLE,
	SUPERFRAME,
	VOICE_BITS,
	bitsToBytes,
	flagText,
	headerDecode,
	headerUnpack,
} from './header';
import type { DstarHeader, DstarStatus, DstarTx } from './types';

const EVENTS_MAX = 20;
/** The data sync and the end of the header sync, +1 where a bit is 1 (a negative symbol in DSD's polarity). */
const DATA_T = Int8Array.from(SYNC_WORDS.DSTAR, (c) => (c === '3' ? 1 : -1));
const HDR_T = Int8Array.from(SYNC_WORDS.DSTAR_HD, (c) => (c === '3' ? 1 : -1));

/** v = g * s + d */
function lsFit(v: ArrayLike<number>, s: ArrayLike<number>, n: number): { g: number; d: number } {
	let ms = 0;
	let mv = 0;
	for (let i = 0; i < n; i++) {
		ms += s[i];
		mv += v[i];
	}
	ms /= n;
	mv /= n;
	let c = 0;
	let a = 0;
	for (let i = 0; i < n; i++) {
		c += (s[i] - ms) * (v[i] - mv);
		a += (s[i] - ms) * (s[i] - ms);
	}
	const g = a > 0 ? c / a : 0;
	return { g, d: mv - g * ms };
}

/** Printable text, trailing spaces removed. */
function trimmed(s: string): string {
	return s.replace(/[^\x20-\x7e]/g, ' ').replace(/ +$/, '');
}

/** The 72 voice bits as mbelib's ambe_fr[4][24], in DSD's D-STAR order (dsd-dstar.ts). */
function ambeOf(bits: Uint8Array): Int8Array {
	const fr = new Int8Array(96);
	for (let i = 0; i < VOICE_BITS; i++) fr[DSTAR_W[i] * 24 + DSTAR_X[i]] = bits[i];
	return fr;
}

function freshTx(late: boolean): DstarTx {
	return {
		my: '',
		sfx: '',
		ur: '',
		rpt1: '',
		rpt2: '',
		flag: [0, 0, 0],
		flags: '',
		headerOk: false,
		headerFromSlow: false,
		lateEntry: late,
		active: true,
		endSeen: false,
		text: '',
		textBlocks: 0,
		gps: '',
		squelch: -1,
		voiceFrames: 0,
		durSec: 0,
		berPct: 0,
		inverted: false,
		events: [],
		syncOk: late ? 1 : 0,
		syncMiss: 0,
	};
}

/** D-STAR on the 4800 symbols/s chain: the radio header, the voice frames of each superframe and the slow data. */
export class DstarCalls {
	private tx: DstarTx | null = null;
	private events: DsdEvent[] = [];
	/** Dibits asked for after the last piece. */
	private piece = 0;
	/** Signed level (Hz per unit, negative in DSD's normal polarity) and offset of the bits. */
	private gs = -1;
	private mag = 1;
	private dc = 0;
	/** The level of the call's good frames (the carrier stopping is a jump of the discriminator noise). */
	private callMag = 0;
	private fi = 0;
	private syncMissRun = 0;
	private weakRun = 0;
	private pend: Int8Array[] = [];
	private hdrErr = 0;
	private hdrBits = 0;
	private syncErr = 0;
	private syncBits = 0;
	private half1: Uint8Array | null = null;
	private text: string[] = [];
	private textLogged = false;
	private gpsBuf = '';
	private hdrBuf: number[] = [];
	private lastPos = { call: '', lat: 1e9, lon: 1e9, at: 0 };

	constructor(private sink: DsdSink) {}

	reset(): void {
		if (this.tx) this.endTx(false);
		this.events = [];
		this.piece = 0;
	}

	/**
	 * A piece read after a D-STAR sync that ended at start: the header (frame sync) or frame 1 (data sync, a call joined
	 * late) when read is the first length, else the next voice frame. Returns the dibits to read next, 0 when it ended.
	 */
	frame(chain: DsdChain, sync: SyncType, start: number, read: number): number {
		const header = sync === SyncType.DSTAR_HD || sync === SyncType.INV_DSTAR_HD;
		if (read === (header ? HEADER_BITS : FRAME_BITS)) {
			if (!this.fit(chain, start, header ? HDR_T : DATA_T)) return 0;
			if (header) this.onHeader(chain, start);
			else this.startLate(chain, start);
		} else this.onFrame(chain, start + read - this.piece);
		this.piece = this.tx ? FRAME_BITS : 0;
		return this.piece;
	}

	/** Level and offset from the 24 sync bits before start; false when the bits are not the pattern. */
	private fit(chain: DsdChain, start: number, t: Int8Array): boolean {
		const v = new Float32Array(24);
		for (let i = 0; i < 24; i++) v[i] = chain.symbols[(start - 24 + i) & chain.mask];
		const { g, d } = lsFit(v, t, 24);
		let err = 0;
		for (let i = 0; i < 24; i++) err += Number((v[i] - d) * g > 0 !== t[i] > 0);
		if (Math.abs(g) < 50 || err > 2) return false;
		this.gs = g;
		this.mag = Math.abs(g);
		this.dc = d;
		return true;
	}

	/** One bit's soft value (> 0 a 1, about +-1), the level and offset followed as OnAir's readBit does. */
	private bit(y: number): number {
		const z = (y - this.dc) / this.gs;
		const d = z >= 0 ? 1 : -1;
		this.dc += 0.003 * (y - this.dc - this.gs * d);
		this.mag = Math.max(50, this.mag + 0.003 * (Math.abs(y - this.dc) - this.mag));
		this.gs = Math.sign(this.gs) * this.mag;
		return z;
	}

	private get syncType(): SyncType {
		return this.gs < 0 ? SyncType.DSTAR : SyncType.INV_DSTAR;
	}

	private onHeader(chain: DsdChain, start: number): void {
		const soft = new Float32Array(HEADER_BITS);
		for (let k = 0; k < HEADER_BITS; k++) soft[k] = Math.max(-2, Math.min(2, this.bit(chain.symbols[(start + k) & chain.mask])));
		const { bytes, errors } = headerDecode(soft);
		const { header, ok } = headerUnpack(bytes);
		if (this.tx) this.endTx(false);
		this.beginTx(false);
		this.hdrErr = errors;
		this.hdrBits = HEADER_BITS;
		if (ok) this.applyHeader(header, false);
		this.fi = 0;
		this.updateBer();
		this.sink.status().mbeDecoding = false;
		this.publish();
	}

	/**
	 * The first data sync of a call whose frame sync was missed (the clock recovery and slicer were still settling on the
	 * bit sync): the radio header just before frame 0 is looked for in the buffer, a symbol either side; else a call
	 * joined late.
	 */
	private startLate(chain: DsdChain, start: number): void {
		if (this.tx) this.endTx(false);
		let found: DstarHeader | null = null;
		for (const off of [0, -1, 1, -2, 2]) {
			const at = start - FRAME_BITS - HEADER_BITS + off;
			const soft = Float32Array.from({ length: HEADER_BITS }, (_, k) => (chain.symbols[(at + k) & chain.mask] - this.dc) / this.gs);
			const { header, ok } = headerUnpack(headerDecode(soft).bytes);
			if (ok) found = header;
			if (ok) break;
		}
		this.beginTx(!found);
		if (found) {
			this.applyHeader(found, false);
			// Frame 0's voice is just before its data sync.
			const v0 = Uint8Array.from({ length: VOICE_BITS }, (_, k) =>
				Number(chain.symbols[(start - FRAME_BITS + k) & chain.mask] - this.dc > 0 === this.gs > 0),
			);
			(this.tx as DstarTx).voiceFrames++;
			this.sink.voice([ambeOf(v0)]);
		}
		this.fi = 1;
		this.onFrame(chain, start);
	}

	private onFrame(chain: DsdChain, at: number): void {
		const tx = this.tx;
		if (!tx) return;
		const z = new Float32Array(FRAME_BITS);
		const b = new Uint8Array(FRAME_BITS);
		for (let k = 0; k < FRAME_BITS; k++) {
			z[k] = this.bit(chain.symbols[(at + k) & chain.mask]);
			b[k] = z[k] >= 0 ? 1 : 0;
		}
		let endErr = 0;
		for (let i = 0; i < 48; i++) endErr += Number(b[i] !== END_PATTERN[i]);
		if (endErr <= 4) return this.endTx(true);
		const weak = this.weak(z);
		if (weak && ++this.weakRun >= 3) {
			// The carrier has gone: the two weak frames before are taken back.
			const back = Math.min(2, tx.voiceFrames);
			tx.voiceFrames -= back;
			tx.durSec = tx.voiceFrames * 0.02;
			this.pend = [];
			return this.endTx(false);
		}
		if (!weak) this.weakRun = 0;
		const idx = this.fi++ % SUPERFRAME;
		if (idx === 0 && !this.dataSync(b)) return this.endTx(false);
		tx.voiceFrames++;
		tx.durSec = tx.voiceFrames * 0.02;
		// The voice of a weak frame is held back until a good frame shows that the call goes on.
		this.pend.push(ambeOf(b));
		if (!weak) this.sink.voice(this.pend.splice(0));
		if (weak) this.half1 = null;
		else if (idx) this.slowHalf(b, idx);
		this.publish();
	}

	/**
	 * A frame that does not look like bits. OnAir also watches the channel power; here the carrier stopping shows as the
	 * discriminator noise rising above the level of the call's good frames (by a third within two frames).
	 */
	private weak(z: Float32Array): boolean {
		let m = 0;
		for (const x of z) m += Math.abs(x);
		m /= z.length;
		let v = 0;
		for (const x of z) v += (Math.abs(x) - m) ** 2;
		v /= z.length;
		const snr = 10 * Math.log10((m * m) / Math.max(v, 1e-9));
		const weak = snr < 4 || m > 1.8 || m < 0.4 || (this.callMag > 0 && this.mag > 1.3 * this.callMag);
		if (!weak) this.callMag = this.callMag > 0 ? this.callMag + 0.05 * (this.mag - this.callMag) : this.mag;
		return weak;
	}

	/** Frame 0's data sync; false when two in a row were missed. */
	private dataSync(b: Uint8Array): boolean {
		const tx = this.tx as DstarTx;
		let e = 0;
		for (let i = 0; i < 24; i++) e += Number(b[72 + i] !== DATA_SYNC[i]);
		this.syncErr += Math.min(e, 12);
		this.syncBits += 24;
		this.updateBer();
		this.half1 = null;
		if (e > 6) {
			tx.syncMiss++;
			return ++this.syncMissRun < 2;
		}
		tx.syncOk++;
		this.syncMissRun = 0;
		this.sink.synced(this.syncType);
		return true;
	}

	private slowHalf(b: Uint8Array, idx: number): void {
		const bytes = bitsToBytes(b, 3, 72);
		for (let k = 0; k < 3; k++) bytes[k] ^= SLOW_SCRAMBLE[k];
		if (((idx - 1) & 1) === 0) {
			this.half1 = bytes;
			return;
		}
		if (!this.half1) return;
		const block = [...this.half1, ...bytes];
		this.half1 = null;
		this.slowBlock(block);
	}

	private updateBer(): void {
		const bits = this.hdrBits + this.syncBits;
		if (this.tx) this.tx.berPct = bits ? (100 * (this.hdrErr + this.syncErr)) / bits : 0;
	}

	private slowBlock(b: number[]): void {
		const tx = this.tx as DstarTx;
		const type = b[0] >> 4;
		const len = Math.min(5, b[0] & 0x0f);
		if (type === 0x4) this.textBlock(b);
		else if (type === 0x3) this.gpsChars(b.slice(1, 1 + len));
		else if (type === 0x5) this.headerChars(b.slice(1, 1 + len));
		else if (type === 0xc) tx.squelch = b[1];
	}

	private textBlock(b: number[]): void {
		const tx = this.tx as DstarTx;
		const i = b[0] & 0x0f;
		if (i > 3) return;
		for (let k = 0; k < 5; k++) this.text[5 * i + k] = String.fromCharCode(b[1 + k]);
		tx.textBlocks |= 1 << i;
		let s = '';
		for (let k = 0; k < 4; k++) s += tx.textBlocks & (1 << k) ? this.text.slice(5 * k, 5 * k + 5).join('') : '     ';
		tx.text = trimmed(s);
		if (tx.textBlocks === 15 && !this.textLogged && tx.text) {
			this.textLogged = true;
			this.event(`message from ${tx.my || '?'}: ${tx.text}`);
		}
	}

	private gpsChars(chars: number[]): void {
		for (const code of chars) {
			const c = String.fromCharCode(code);
			if (c === '$' && this.gpsBuf && this.gpsBuf !== '$') {
				// A new sentence: the last one lost its end in a missing block.
				this.gpsLine(this.gpsBuf);
				this.gpsBuf = '';
			}
			if (c === '\r' || c === '\n') {
				if (this.gpsBuf) this.gpsLine(this.gpsBuf);
				this.gpsBuf = '';
			} else this.gpsBuf = this.gpsBuf.length < 200 ? this.gpsBuf + c : '';
		}
	}

	private headerChars(chars: number[]): void {
		this.hdrBuf.push(...chars);
		if (this.hdrBuf.length > 2 * HEADER_BYTES) this.hdrBuf.splice(0, this.hdrBuf.length - HEADER_BYTES);
		if (this.hdrBuf.length < HEADER_BYTES) return;
		const { header, ok } = headerUnpack(Uint8Array.from(this.hdrBuf.slice(-HEADER_BYTES)));
		if (!ok) return;
		this.hdrBuf = [];
		if (!this.tx?.headerOk) this.applyHeader(header, true);
	}

	private gpsLine(line: string): void {
		const tx = this.tx as DstarTx;
		const f = line.startsWith('$$') ? parseDprs(line) : parseNmea(line);
		tx.gps = trimmed(line);
		if (!f) return;
		const call = f.aprs ? f.call : tx.my;
		const same =
			tx.position && tx.position.call === call && Math.abs(tx.position.lat - f.lat) < 1e-5 && Math.abs(tx.position.lon - f.lon) < 1e-5;
		const pos = same && tx.position ? { ...tx.position } : { call, lat: f.lat, lon: f.lon, dprs: f.aprs, comment: f.comment };
		if (f.altValid) pos.altM = f.altM;
		if (f.velValid) Object.assign(pos, { speedKmh: f.speedKmh, course: f.course });
		tx.position = pos;
		// GGA and RMC of one fix come together, and the slow data repeats: one event per station and place.
		const last = this.lastPos;
		const now = Date.now();
		if (call === last.call && Math.abs(f.lat - last.lat) < 1e-5 && Math.abs(f.lon - last.lon) < 1e-5 && now - last.at < 30000) return;
		this.lastPos = { call, lat: f.lat, lon: f.lon, at: now };
		const where = `${f.lat.toFixed(5)}, ${f.lon.toFixed(5)}`;
		this.event(`position ${call || '?'} ${where} (${f.aprs ? 'D-PRS' : 'NMEA'})${f.comment ? ': ' + f.comment : ''}`);
	}

	private beginTx(late: boolean): void {
		this.tx = freshTx(late);
		this.tx.inverted = this.gs > 0;
		this.hdrErr = this.hdrBits = this.syncErr = this.syncBits = 0;
		this.syncMissRun = this.weakRun = 0;
		this.callMag = 0;
		this.half1 = null;
		this.text = new Array<string>(20).fill(' ');
		this.textLogged = false;
		this.gpsBuf = '';
		this.hdrBuf = [];
		this.pend = [];
		this.sink.reset();
	}

	private applyHeader(h: DstarHeader, fromSlow: boolean): void {
		const tx = this.tx as DstarTx;
		Object.assign(tx, { headerOk: true, headerFromSlow: fromSlow, flag: h.flag, flags: flagText(h.flag[0]) });
		Object.assign(tx, { my: h.my, sfx: h.sfx, ur: h.ur, rpt1: h.rpt1, rpt2: h.rpt2 });
		this.sink.status().callsign = h.my;
		const via = h.rpt1 || h.rpt2 ? ` via ${h.rpt1 || '-'} / ${h.rpt2 || '-'}` : '';
		this.event(`${h.my}${h.sfx ? '/' + h.sfx : ''} → ${h.ur}${via}${fromSlow ? ' (header from the slow data)' : ''}`);
	}

	private endTx(endSeen: boolean): void {
		const tx = this.tx;
		if (!tx) return;
		if (this.pend.length) this.sink.voice(this.pend.splice(0));
		tx.active = false;
		tx.endSeen = endSeen;
		this.sink.reset();
		if (this.counts(tx)) this.event(`${endSeen ? 'end of' : 'signal lost:'} ${tx.my || '?'}, ${tx.durSec.toFixed(1)} s`);
		this.publish();
		this.tx = null;
	}

	/** A transmission is reported once something in it checked: its header, or a data sync after the one it was found by. */
	private counts(tx: DstarTx): boolean {
		return tx.headerOk || tx.syncOk >= (tx.lateEntry ? 2 : 1);
	}

	private event(text: string): void {
		this.events = [{ at: Date.now(), text }, ...this.events].slice(0, EVENTS_MAX);
	}

	private publish(): void {
		const tx = this.tx;
		if (!tx || !this.counts(tx)) return;
		const { syncOk: _ok, syncMiss: _miss, ...shown } = tx;
		const status: DstarStatus = { ...shown, events: this.events };
		this.sink.status().dstar = status;
	}
}
