// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Symbol-level M17 receiver, adapted from OnAir core/src/m17/m17_rx.cpp at 3d3f1ca.
import { m17Crc16, m17DecodeLsf, m17DecodePacket, m17DecodeStream, m17UnpackLsf } from './protocol';
import { M17_SYNC_SYMBOLS, m17Correlation, m17FitFrame } from './demod';
import type { M17FrameType, M17Lsf, M17Status, M17Frame } from './types';

const SYNC_TYPES = ['lsf', 'stream', 'packet', 'bert'] as const;
const RING = 4096;

export class M17Receiver {
	private symbols = new Float32Array(RING);
	private count = 0;
	private candidate: { start: number; type: M17FrameType; polarity: number } | null = null;
	private nextStart = -1;
	private expected: M17FrameType = 'stream';
	private polarity = 0;
	private failures = 0;
	private lsf: M17Lsf | null = null;
	private lich = new Uint8Array(30);
	private lichMask = 0;
	private packet: number[] = [];
	private packetNext = 0;
	private status: M17Status = {
		src: '',
		dst: '',
		can: -1,
		kind: '',
		encrypted: false,
		frames: 0,
		voiceFrames: 0,
		codecReady: false,
		text: '',
		snrDb: 0,
		inverted: false,
		ended: false,
	};
	private onFrame: (frame: M17Frame) => void;

	constructor(onFrame: (frame: M17Frame) => void) {
		this.onFrame = onFrame;
	}
	get locked(): boolean {
		return this.nextStart >= 0;
	}

	reset(): void {
		this.symbols.fill(0);
		this.count = 0;
		this.candidate = null;
		this.nextStart = -1;
		this.polarity = 0;
		this.failures = 0;
		this.lsf = null;
		this.lichMask = 0;
		this.packet = [];
		this.packetNext = 0;
		this.status = {
			src: '',
			dst: '',
			can: -1,
			kind: '',
			encrypted: false,
			frames: 0,
			voiceFrames: 0,
			codecReady: this.status.codecReady,
			text: '',
			snrDb: 0,
			inverted: false,
			ended: false,
		};
	}

	setCodecReady(ready: boolean): void {
		this.status.codecReady = ready;
	}

	feed(symbol: number): void {
		this.symbols[this.count & (RING - 1)] = symbol;
		this.count++;
		if (this.locked) {
			if (this.count < this.nextStart + 192) return;
			const start = this.nextStart;
			if (this.processFrame(start, this.expected, true, this.polarity)) this.failures = 0;
			else if (++this.failures >= 3) {
				this.nextStart = -1;
				this.candidate = null;
				this.status.ended = true;
				this.onFrame({ status: { ...this.status } });
				return;
			}
			this.nextStart = this.status.ended ? -1 : start + 192;
			return;
		}
		if (this.candidate) {
			if (this.count >= this.candidate.start + 192) {
				const { start, type, polarity } = this.candidate;
				this.candidate = null;
				if (this.processFrame(start, type, false, polarity)) {
					this.nextStart = this.status.ended ? -1 : start + 192;
					this.expected = type === 'lsf' ? ((this.lsf?.type ?? 0) & 1 ? 'stream' : 'packet') : type;
					this.polarity = polarity;
				}
			}
			return;
		}
		if (this.count < 8) return;
		const last = new Float32Array(8);
		for (let i = 0; i < 8; i++) last[i] = this.symbols[(this.count - 8 + i) & (RING - 1)];
		let bestType: M17FrameType | null = null,
			best = 0;
		for (const type of SYNC_TYPES) {
			const value = m17Correlation(last, M17_SYNC_SYMBOLS[type]);
			if (Math.abs(value) > Math.abs(best)) {
				best = value;
				bestType = type;
			}
		}
		if (bestType && Math.abs(best) >= 0.92) this.candidate = { start: this.count - 8, type: bestType, polarity: Math.sign(best) };
	}

	private processFrame(start: number, type: M17FrameType, locked: boolean, polarity: number): boolean {
		const values = new Float32Array(192);
		for (let i = 0; i < 192; i++) values[i] = this.symbols[(start + i) & (RING - 1)];
		const fitted = m17FitFrame(values, M17_SYNC_SYMBOLS[type], polarity, locked);
		if (!fitted) return false;
		const { soft, snrDb } = fitted;
		let voice: M17Frame['voice'];
		let end = false;
		if (type === 'lsf') {
			const decoded = m17DecodeLsf(soft);
			if (!decoded.lsf) return false;
			this.applyLsf(decoded.lsf);
		} else if (type === 'stream') {
			const decoded = this.handleStream(soft, locked);
			if (!decoded) return false;
			({ voice, end } = decoded);
		} else if (type === 'packet') {
			const packetEnd = this.handlePacket(soft, locked);
			if (packetEnd === null) return false;
			end = packetEnd;
		} else return false;
		this.status.frames++;
		this.status.snrDb = snrDb;
		this.status.inverted = polarity < 0;
		this.status.ended = end;
		this.onFrame({ status: { ...this.status }, voice });
		if (end) this.nextStart = -1;
		return true;
	}

	private handleStream(soft: Float32Array, locked: boolean): { voice?: M17Frame['voice']; end: boolean } | null {
		const decoded = m17DecodeStream(soft);
		if (decoded.corrected > (locked ? 70 : 40) || (!locked && (!decoded.lichValid || decoded.golayErrors > 6))) return null;
		if (decoded.lichValid) {
			const piece = (decoded.lich[5] >> 5) & 7;
			if (piece < 6) {
				this.lich.set(decoded.lich.subarray(0, 5), piece * 5);
				this.lichMask |= 1 << piece;
				if (this.lichMask === 63) {
					const reconstructed = m17UnpackLsf(this.lich);
					if (reconstructed) this.applyLsf(reconstructed);
					this.lichMask = 0;
				}
			}
		}
		let voice: M17Frame['voice'];
		if (this.lsf && !this.status.encrypted) {
			const data = (this.lsf.type >> 1) & 3;
			if (data === 2 || data === 3) {
				voice = { payload: decoded.payload, rate: data === 2 ? 3200 : 1600, frameNumber: decoded.frameNumber };
				this.status.voiceFrames += data === 2 ? 2 : 1;
			}
		}
		return { voice, end: Boolean(decoded.frameNumber & 0x8000) };
	}

	private handlePacket(soft: Float32Array, locked: boolean): boolean | null {
		const decoded = m17DecodePacket(soft);
		if (decoded.corrected > (locked ? 70 : 20)) return null;
		if (!decoded.eof) {
			if (decoded.counter !== this.packetNext) {
				this.packet = [];
				this.packetNext = -1;
			} else {
				this.packet.push(...decoded.chunk);
				this.packetNext++;
			}
			return false;
		}
		if (this.packetNext >= 0) this.packet.push(...decoded.chunk.subarray(0, Math.max(1, Math.min(25, decoded.counter))));
		if (this.packetNext >= 0 && this.packet.length >= 3 && m17Crc16(this.packet) === 0) {
			if (this.packet[0] === 5) {
				const text = this.packet.slice(1, -2);
				const end = text.indexOf(0);
				if (end >= 0) text.length = end;
				if (text.every((byte) => byte >= 32 && byte < 127)) this.status.text = String.fromCharCode(...text);
			} else this.status.text = `Packet type 0x${this.packet[0].toString(16).padStart(2, '0')}, ${this.packet.length - 2} bytes`;
		}
		this.packet = [];
		this.packetNext = 0;
		return true;
	}

	private applyLsf(lsf: M17Lsf): void {
		this.lsf = lsf;
		this.status.src = lsf.src;
		this.status.dst = lsf.dst;
		this.status.can = (lsf.type >> 7) & 15;
		this.status.encrypted = ((lsf.type >> 3) & 3) !== 0;
		const data = (lsf.type >> 1) & 3;
		this.status.kind = !(lsf.type & 1) ? 'Packet' : data === 2 ? 'Voice 3200' : data === 3 ? 'Voice/data 1600' : 'Data';
		if (!this.status.encrypted && ((lsf.type >> 5) & 3) === 0 && lsf.meta[0]) {
			const text = Array.from(lsf.meta.subarray(1)).filter((byte) => byte >= 32 && byte < 127);
			this.status.text = String.fromCharCode(...text).trimEnd();
		}
	}
}
