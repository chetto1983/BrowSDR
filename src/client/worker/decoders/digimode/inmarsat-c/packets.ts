// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/inmc/inmc_pkt.cpp (FrameParser) and
// core/include/dect2/inmc/inmc_pkt.h, https://github.com/adswill/OnAir; see third_party/onair. Changes: the parser keeps
// its own arrival counter (OnAir shares one between its channels) and lists the slots each frame touched, so that the
// decoder can log a message when it completes; the report list (trimMessages) and the packet builders (in the tests) are
// left out.
//
// Inmarsat-C TDM packets: a decoded 640 byte frame into system information and EGC messages. Not confirmed against a
// specification (OnAir's notes): the layout of the EGC address bytes (shown as hex), the meaning of the first address byte
// (read as satellite and station: tentative), and how the second EGC descriptor (0xB2) numbers its packets (parts are
// ordered by packet number, then 0xB1 before 0xB2).

import { FRAME_BYTES, packetCheckOk } from './code';
import { classifyEgc } from './egc';
import { addressLength, decodeText, frameTimeText, lesName, satName, serviceKind, serviceName, servicesText } from './tables';
import type { InmcMessage, InmcNcsInfo, InmcPacketCounts, InmcSlot } from './types';

const MAX_SLOTS = 150;
const CHANNEL_TYPES = ['Reserved', 'NCS', 'LES TDM', 'Joint NCS and TDM', 'Stand-by NCS'];
const STATUS_BITS = ['600 baud', 'operational', 'in service', 'clear', 'links open'];

export const emptyNcs = (): InmcNcsInfo => ({
	valid: false,
	sat: -1,
	region: '',
	lesId: -1,
	lesName: '',
	channelType: 0,
	channelTypeName: '',
	networkVersion: 0,
	signallingChannel: 0,
	count: 0,
	status: 0,
	statusText: '',
	services: 0,
	servicesText: '',
	randomInterval: 0,
	signallingUplinkMhz: 0,
	frameNo: 0,
	frameTime: '',
});

/** Length of the packet at `pos`: short and medium descriptors; -1 for a long one (not used by these channels). */
function packetLength(f: Uint8Array, pos: number, end: number): number {
	const d = f[pos];
	if (d >> 7 === 0) return (d & 0x0f) + 1;
	if (d >> 6 === 2 && pos + 1 < end) return f[pos + 1] + 2;
	return -1;
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

function newMessage(id: number, svc: number, frameNo: number): InmcMessage {
	return {
		id,
		serviceCode: svc,
		kind: serviceKind(svc),
		priority: 0,
		serviceText: serviceName(svc),
		area: '',
		addr0: 0,
		sat: -1,
		lesId: -1,
		lesName: '',
		repetition: 0,
		presentation: 0,
		packets: 0,
		complete: false,
		seen: 0,
		frameNo,
		text: '',
		navarea: '',
		subject: '',
		ident: '',
	};
}

export class FrameParser {
	ncs = emptyNcs();
	readonly slots: InmcSlot[] = [];
	readonly packets: InmcPacketCounts = { ok: 0, bad: 0 };
	/** Messages seen since the start. */
	messageCount = 0;
	/** The slots that got a packet in the last frame parsed. */
	touched: InmcSlot[] = [];
	private order = 0;
	private curFrame = 0;
	/** Multiframe packet being collected (0xBD, 0xBE). */
	private mfp: number[] = [];
	private mfpTotal = 0;

	reset(): void {
		this.ncs = emptyNcs();
		this.slots.length = 0;
		this.packets.ok = this.packets.bad = 0;
		this.messageCount = this.curFrame = this.mfpTotal = 0;
		this.mfp = [];
		this.touched = [];
	}

	/** Parses one decoded frame (640 bytes). True when the frame starts with a bulletin board packet with a good check. */
	parseFrame(f: Uint8Array): boolean {
		let bbFirst = false;
		const end = FRAME_BYTES - 1; // the last byte is the flush byte
		this.touched = [];
		for (const s of this.slots) s.idleFrames++;
		for (let pos = 0; pos < end;) {
			const d = f[pos];
			if (d === 0) break; // no more packets
			const len = packetLength(f, pos, end);
			if (len < 3 || pos + len > end) {
				this.packets.bad++;
				break;
			}
			if (packetCheckOk(f, len, pos)) {
				this.packets.ok++;
				if (this.packet(f.subarray(pos, pos + len)) && pos === 0) bbFirst = true;
			} else this.packets.bad++;
			pos += len;
		}
		return bbFirst;
	}

	/** One packet with a good check; true for a bulletin board. */
	private packet(p: Uint8Array): boolean {
		const d = p[0];
		const len = p.length;
		if (d === 0x7d && len >= 14) {
			this.bulletinBoard(p);
			return true;
		}
		if (d === 0x6c && len >= 13) this.ncs.signallingUplinkMhz = (((p[2] << 8) | p[3]) - 6000) * 0.0025 + 1626.5;
		else if ((d === 0xb1 || d === 0xb2) && len >= 10) this.egc(p);
		else if (d === 0xbd && len >= 6) this.multiframeStart(p);
		else if (d === 0xbe && len >= 4 && this.mfpTotal) this.multiframeMore(p);
		return false;
	}

	private bulletinBoard(p: Uint8Array): void {
		const n = this.ncs;
		n.valid = true;
		n.networkVersion = p[1];
		n.frameNo = (p[2] << 8) | p[3];
		n.frameTime = frameTimeText(n.frameNo);
		n.signallingChannel = p[4] >> 2;
		n.count = (p[5] >> 4) * 2;
		n.channelType = p[6] >> 5;
		n.channelTypeName = CHANNEL_TYPES[n.channelType] ?? 'Reserved';
		n.sat = p[7] >> 6;
		n.region = satName(n.sat);
		n.lesId = p[7] & 63;
		n.lesName = lesName(n.sat, n.lesId);
		n.status = p[8];
		n.statusText = STATUS_BITS.filter((_, i) => p[8] & (0x80 >> i)).join(', ');
		n.services = (p[9] << 8) | p[10];
		n.servicesText = servicesText(n.services);
		n.randomInterval = p[11];
		this.curFrame = n.frameNo;
	}

	/** Multiframe packet: the start of another packet, continued in 0xBE packets of this or the next frames. */
	private multiframeStart(p: Uint8Array): void {
		const inner = p[2];
		let il = -1;
		if (inner >> 7 === 0) il = (inner & 15) + 1;
		else if (inner >> 6 === 2) il = p[3] + 2;
		this.mfp = [...p.subarray(2, p.length - 2)];
		this.mfpTotal = il > 0 ? il : 0;
	}

	private multiframeMore(p: Uint8Array): void {
		this.mfp.push(...p.subarray(2, p.length - 2));
		if (this.mfp.length + 2 < this.mfpTotal) return;
		const whole = new Uint8Array(this.mfpTotal); // the assembled packet has no check bytes of its own
		whole.set(this.mfp.slice(0, this.mfpTotal));
		if ((whole[0] === 0xb1 || whole[0] === 0xb2) && whole.length >= 10) this.egc(whole);
		this.mfp = [];
		this.mfpTotal = 0;
	}

	private slotFor(id: number, svc: number): InmcSlot {
		const found = this.slots.find((x) => x.msg.id === id && x.msg.serviceCode === svc);
		if (found) return found;
		if (this.slots.length >= MAX_SLOTS) {
			// drop the oldest
			let oldest = 0;
			for (let i = 1; i < this.slots.length; i++) if (this.slots[i].order < this.slots[oldest].order) oldest = i;
			this.slots.splice(oldest, 1);
		}
		const slot: InmcSlot = {
			msg: newMessage(id, svc, this.curFrame),
			parts: new Map(),
			lastKey: -1,
			passKeys: new Set(),
			counted: false,
			order: 0,
			shown: '',
			shownComplete: false,
			idleFrames: 0,
		};
		this.slots.push(slot);
		this.messageCount++;
		return slot;
	}

	/** The first packet of a message: another message under a reused number starts afresh, a repeat starts a new pass. */
	private firstPacket(s: InmcSlot, key: number, payload: Uint8Array): void {
		const kept = s.parts.get(key);
		if (kept && !sameBytes(kept, payload)) {
			s.parts.clear();
			s.lastKey = -1;
			s.msg.packets = 0;
			s.msg.text = '';
			s.msg.complete = false;
			s.msg.seen = 0;
			s.passKeys.clear();
			s.counted = false;
			s.msg.frameNo = this.curFrame;
		} else if (s.msg.complete) {
			// the next broadcast of a message we have: the text of the last one stays until this one is whole
			s.passKeys.clear();
			s.counted = false;
			s.msg.frameNo = this.curFrame;
		}
	}

	private egc(p: Uint8Array): void {
		const len = p.length;
		const svc = p[2];
		const al = addressLength(svc);
		const hdr = 8 + al;
		if (hdr > len - 2) return;
		const cont = (p[3] & 0x80) !== 0;
		const id = (p[4] << 8) | p[5];
		const key = p[6] * 2 + (p[0] === 0xb2 ? 1 : 0);
		const payload = p.slice(hdr, len - 2);
		const s = this.slotFor(id, svc);
		if (p[6] === 1 && p[0] === 0xb1) this.firstPacket(s, key, payload);
		s.order = ++this.order;
		s.idleFrames = 0;
		const m = s.msg;
		m.priority = (p[3] >> 5) & 3;
		m.repetition = p[3] & 31;
		m.presentation = p[7];
		m.addr0 = p[8];
		m.area = [...p.subarray(9, 8 + al)].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
		m.sat = p[8] >> 6;
		m.lesId = p[8] & 63;
		m.lesName = lesName(m.sat, m.lesId);
		s.parts.set(key, payload);
		if (!cont) s.lastKey = Math.max(s.lastKey, key);
		s.passKeys.add(key);
		m.packets = s.parts.size;
		this.finish(s);
		if (!this.touched.includes(s)) this.touched.push(s);
	}

	private finish(s: InmcSlot): void {
		const keys = [...s.parts.keys()].sort((a, b) => a - b);
		const all = new Uint8Array(keys.reduce((n, k) => n + s.parts.get(k)!.length, 0));
		let at = 0;
		for (const k of keys) {
			all.set(s.parts.get(k)!, at);
			at += s.parts.get(k)!.length;
		}
		const m = s.msg;
		m.text = decodeText(m.presentation, all);
		const info = classifyEgc(m.serviceCode, m.priority, m.text);
		m.navarea = info.area;
		m.subject = info.subject;
		m.ident = info.ident;
		let done = s.lastKey >= 0;
		for (let n = 1; done && n <= s.lastKey >> 1; n++) done = keys.some((k) => k >> 1 === n);
		m.complete = done;
		// every part heard in this broadcast
		if (done && !s.counted && keys.every((k) => s.passKeys.has(k))) {
			m.seen++;
			s.counted = true;
		}
	}
}
