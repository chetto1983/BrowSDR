// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/dmr/dmr_link.cpp (Link::decodeBurst: the burst classification,
// Link::decodeData, Link::voiceBurst, Link::startCall, Link::endCall, Link::handleCach), https://github.com/adswill/OnAir;
// see third_party/onair.
// Changes: BrowSDR's DSD stream finds the bursts and slices the symbols (OnAir's sync search, slot tracks, level
// calibration, symbol equaliser and heard-ID repair are not ported); the call log, message list and location list
// become the DmrInfo summary of the DSD panel with a short list of recent events; repeated events within 30 s are
// shown once, and preambles and the routine Tier III control blocks (Aloha, announcements) update the summary
// without an event. Tier III grants and system identity, the GPS info LC and Motorola's alias opcodes are additions
// (see control.ts and lc.ts).
//
// The DMR link layer of the receiver above the burst: voice LC headers and terminators, CSBKs, data headers and the
// rate 1/2, 3/4 and 1 blocks of a data message, the embedded LC of the voice bursts (late entry, talker alias, GPS),
// and the short LC of the CACH.
import { bitsToBytes } from './codes';
import { bptcAssisted, burstDataPayload, burstEmb, burstSlotType, matchSyncDibits, readBurst, syncIsData } from './burst';
import { grantText, ShortLc, tier3Grant, tier3SystemCode, tier3Text, vendorGrants } from './control';
import * as D from './data';
import { finishMessage } from './message';
import {
	be24,
	csbkName,
	csbkParse,
	crcBlockCheck,
	FLCO_GPS_INFO,
	FLCO_GROUP_VOICE,
	FLCO_TA_BLOCK3,
	FLCO_TA_HEADER,
	FLCO_UNIT_VOICE,
	gpsInfoParse,
	lcBurstDecode,
	MASK_DATA_HEADER,
	MASK_MBC_HEADER,
	MASK_PI,
	MASK_USBD,
	parseFullLc,
} from './lc';
import { cachDecode, embLcDecode, rate1Decode, trellis34Decode } from './product';
import { TalkerAlias } from './text';
import { CapPlus, conPlusParse, vendorCsbkName } from './vendor';
import { xptParseCall, xptParseCsbk, xptState, xptSummary } from './xpt';
import type { Csbk, DmrEvent, DmrInfo, DmrLateCall, DmrSlotCall, DmrSlotState, FullLc } from './types';

/** Recent events kept for the panel. */
export const DMR_EVENT_LIMIT = 20;
/** Seconds of signal in which the same event is shown once. */
const EVENT_REPEAT_SEC = 30;
/** Symbols per second: the stream clock of the link. */
const SYMBOL_RATE = 4800;

function newSlot(): DmrSlotState {
	return {
		cc: -1,
		vpos: -1,
		misses: 0,
		lcHave: 0,
		lcFrag: [],
		embPendKey: '',
		ta: new TalkerAlias(),
		msg: { active: false, hdr: D.emptyDataHeader(), dt: 0, bytes: [], got: 0, confirmed: false, crcAllOk: true, prop: null },
		inCall: false,
		call: noCall(),
		alias: '',
		lastCsbkKey: '',
		lastCsbkSec: -10,
		lastTermKey: '',
		lastTermSec: -100,
	};
}

function noCall(): DmrSlotCall {
	return { kind: 'group', src: 0, dst: 0, idsKnown: false, emergency: false, privacy: false, lateEntry: false, alias: '' };
}

const callKind = (flco: number, dst: number): DmrSlotCall['kind'] =>
	flco === FLCO_UNIT_VOICE ? 'private' : dst >= 0xfffff0 ? 'all call' : 'group';

function callText(c: DmrSlotCall): string {
	const who = c.kind === 'private' ? `Private call ${c.dst}` : c.kind === 'all call' ? 'All call' : `Group call TG ${c.dst}`;
	return `${who} ← ${c.src}${c.lateEntry ? ' (late entry)' : ''}${c.emergency ? ' EMERGENCY' : ''}${c.privacy ? ' encrypted' : ''}`;
}

/** The DMR link layer for BrowSDR's DSD stream: feed it the bursts in the order they were on the air. */
export class DmrLink {
	/** What the panel shows; a new object whenever something changed. */
	info: DmrInfo = { events: [] };
	/** A call identity the embedded LC just gave (late entry), for the call line; taken by the caller. */
	lateCall: DmrLateCall | null = null;
	private slots = [newSlot(), newSlot()];
	private xpt = xptState();
	private capPlus = new CapPlus();
	private shortLc = new ShortLc();
	private seen = new Map<string, number>();

	reset(): void {
		this.info = { events: [] };
		this.lateCall = null;
		this.slots = [newSlot(), newSlot()];
		this.xpt = xptState();
		this.capPlus = new CapPlus();
		this.shortLc.reset();
		this.seen.clear();
	}

	/** The carrier went away: calls and messages in progress end; the summary stays. */
	lostSignal(): void {
		this.lateCall = null;
		this.shortLc.reset();
		for (const s of this.slots) {
			s.inCall = false;
			s.call = noCall();
			s.vpos = -1;
			s.lcHave = 0;
			s.msg.active = false;
		}
	}

	/** Changes the summary; with `event`, adds it unless the same one was shown in the last 30 s of signal. */
	private update(patch: Partial<DmrInfo>, event?: Omit<DmrEvent, 'at'>, now = 0): void {
		let events = this.info.events;
		if (event) {
			const key = `${event.kind}/${event.slot}/${event.text}`;
			const last = this.seen.get(key);
			if (last === undefined || now - last >= EVENT_REPEAT_SEC || now < last) {
				if (this.seen.size > 500) this.seen.clear();
				this.seen.set(key, now);
				events = [{ ...event, at: Date.now() }, ...events].slice(0, DMR_EVENT_LIMIT);
			}
		}
		this.info = { ...this.info, ...patch, events };
	}

	/** The CACH in front of a base station burst at absolute dibit `start`: its TDMA channel (0 / 1) when the TACT decoded clean, else -1. */
	cach(dibits: Uint8Array, mask: number, start: number): number {
		const bits = new Uint8Array(24);
		for (let i = 0; i < 12; i++) {
			const d = dibits[(start + i) & mask] & 3;
			bits[2 * i] = d >> 1;
			bits[2 * i + 1] = d & 1;
		}
		const c = cachDecode(bits);
		if (!c) {
			this.shortLc.reset();
			return -1;
		}
		const text = this.shortLc.add(c.lcss, c.payload17, start);
		if (text && text !== 'null' && text !== this.info.activity) this.update({ activity: text });
		// the TACT is a Hamming (7,4) code: noise always "decodes", so only words without a correction tell the slot
		return c.errors === 0 ? c.tc : -1;
	}

	/**
	 * One burst of `slot` whose first dibit is at absolute position `start`: what it was. `found`: the sync pattern the
	 * DSD stream already matched there (its sign-only match tolerates more symbol errors than this one).
	 */
	burst(dibits: Uint8Array, symbols: Float32Array, mask: number, start: number, slot: number, found?: number): 'voice' | 'data' | 'none' {
		const { bits, z } = readBurst(dibits, symbols, mask, start);
		const sync = found ?? matchSyncDibits(dibits, start + 54, mask, 4);
		const now = start / SYMBOL_RATE;
		if (sync >= 0 && syncIsData(sync)) return this.dataBurst(slot, bits, z, now) ? 'data' : 'none';
		if (sync === 4) return 'none'; // standalone reverse channel
		const s = this.slots[slot];
		if (sync >= 0) {
			this.voiceBurst(slot, 0, 0, null, now);
			return 'voice';
		}
		const emb = burstEmb(bits);
		if (emb && emb.errors <= 2 && (s.cc < 0 || emb.cc === s.cc) && (s.vpos >= 0 || s.inCall)) {
			const pos = s.vpos >= 0 ? (s.vpos + 1) % 6 : emb.lcss === 1 ? 1 : emb.lcss === 2 ? 4 : emb.lcss === 0 ? 5 : 2;
			this.voiceBurst(slot, pos, emb.lcss, emb.emb32, now);
			return 'voice';
		}
		s.misses++;
		s.lcHave = 0;
		s.vpos = s.vpos >= 0 && s.misses < 2 ? (s.vpos + 1) % 6 : -1;
		return 'none';
	}

	/** A data burst: the slot type, then the payload by data type. True when the payload passed its check. */
	private dataBurst(slot: number, bits: Uint8Array, z: Float32Array, now: number): boolean {
		const st = burstSlotType(bits);
		if (!st || st.errors > 3) return false;
		// the colour code stays only if the payload checks out
		const ok = this.dataPayload(slot, st.dt, bits, z, now);
		if (ok) this.slots[slot].cc = st.cc;
		return ok;
	}

	private dataPayload(slot: number, dt: number, bits: Uint8Array, z: Float32Array, now: number): boolean {
		switch (dt) {
			case D.DT_VOICE_LC_HEADER:
			case D.DT_TERMINATOR_LC:
				return this.lcBurst(slot, bits, z, dt === D.DT_TERMINATOR_LC, now);
			case D.DT_CSBK:
				return this.csbkBurst(slot, bits, z, now);
			case D.DT_DATA_HEADER:
				return this.dataHeader(slot, bits, z, now);
			case D.DT_RATE12:
			case D.DT_RATE34:
			case D.DT_RATE1:
				return this.dataBlock(slot, dt, bits, z, now);
			case D.DT_IDLE:
				// idle bursts carry nothing: decoded without the soft retries
				this.endVoiceByData(slot);
				this.slots[slot].msg.active = false;
				return bptcAssisted(bits, z)[0] >= 0;
			case D.DT_MBC_CONTINUATION:
				return bptcAssisted(bits, z)[0] >= 0;
			default: {
				// PI header, MBC header and unified single block data: their CRC only
				const mask = dt === D.DT_PI_HEADER ? MASK_PI : dt === D.DT_MBC_HEADER ? MASK_MBC_HEADER : MASK_USBD;
				const [cor, info] = bptcAssisted(bits, z, (i) => crcBlockCheck(i, mask) !== null);
				return cor >= 0 && crcBlockCheck(info, mask) !== null;
			}
		}
	}

	private endVoiceByData(slot: number): void {
		if (this.slots[slot].inCall) this.endCall(slot);
		this.slots[slot].vpos = -1;
	}

	/** Voice LC header or terminator with LC. */
	private lcBurst(slot: number, bits: Uint8Array, z: Float32Array, term: boolean, now: number): boolean {
		const [cor, info] = bptcAssisted(bits, z, (i) => lcBurstDecode(i, term)[0] >= 0);
		if (cor < 0) return false;
		const f = parseFullLc(lcBurstDecode(info, term)[1]);
		if (xptParseCall(f, now, this.xpt)) {
			this.xptSite();
			return true;
		}
		if (f.flco !== FLCO_GROUP_VOICE && f.flco !== FLCO_UNIT_VOICE) return true;
		const s = this.slots[slot];
		const kind = callKind(f.flco, f.dst);
		if (!term) {
			if (!(s.inCall && s.call.idsKnown && s.call.src === f.src && s.call.dst === f.dst)) this.startCall(slot, kind, f, false, now);
			s.vpos = -1;
			return true;
		}
		// in hang time a base station repeats the terminator for seconds (TS 102 361-2 clause 5.2): one entry per call
		const key = `${f.src}/${f.dst}/${kind}`;
		const repeat = !s.inCall && key === s.lastTermKey && now - s.lastTermSec < 8;
		s.lastTermKey = key;
		s.lastTermSec = now;
		if (repeat) return true;
		if (!s.inCall) this.startCall(slot, kind, f, true, now);
		else if (!s.call.idsKnown) Object.assign(s.call, { src: f.src, dst: f.dst, idsKnown: true, kind });
		this.endCall(slot);
		return true;
	}

	private startCall(slot: number, kind: DmrSlotCall['kind'], f: FullLc | null, late: boolean, now: number): void {
		const s = this.slots[slot];
		if (s.inCall) this.endCall(slot);
		s.call = {
			...noCall(),
			kind,
			src: f?.src ?? 0,
			dst: f?.dst ?? 0,
			idsKnown: f !== null,
			emergency: ((f?.svc ?? 0) & 0x80) !== 0,
			privacy: ((f?.svc ?? 0) & 0x40) !== 0,
			lateEntry: late,
		};
		s.inCall = true;
		s.alias = '';
		s.ta.clear();
		if (f) this.update({}, { kind: 'call', slot, text: callText(s.call) }, now);
	}

	private endCall(slot: number): void {
		const s = this.slots[slot];
		s.inCall = false;
		s.call = noCall();
	}

	/** A voice burst at position `pos` (0 = A, with the voice sync; 1..5 = B..F, with the EMB). */
	private voiceBurst(slot: number, pos: number, lcss: number, emb32: Uint8Array | null, now: number): void {
		const s = this.slots[slot];
		s.vpos = pos;
		s.misses = 0;
		if (!emb32) {
			// a call starts at a voice sync
			if (!s.inCall) this.startCall(slot, 'group', null, true, now);
			s.lcHave = 0;
			return;
		}
		// embedded link control: LCSS 1 starts, 3 continues, 2 ends the four fragments
		if (lcss === 1) {
			s.lcFrag = [emb32];
			s.lcHave = 1;
		} else if (lcss === 3 && s.lcHave >= 1 && s.lcHave <= 2) s.lcFrag[s.lcHave++] = emb32;
		else if (lcss === 2 && s.lcHave === 3) {
			s.lcFrag[3] = emb32;
			s.lcHave = 0;
			const [e, lc] = embLcDecode(s.lcFrag);
			if (e >= 0) this.embeddedLc(slot, parseFullLc(lc), now);
		} else s.lcHave = 0;
	}

	private embeddedLc(slot: number, f: FullLc, now: number): void {
		if (f.flco === FLCO_GROUP_VOICE || f.flco === FLCO_UNIT_VOICE) this.embeddedCall(slot, f, now);
		else if (f.flco >= FLCO_TA_HEADER && f.flco <= FLCO_TA_BLOCK3) this.talkerAlias(slot, f, now);
		else if (f.flco === FLCO_GPS_INFO) {
			const loc = gpsInfoParse(f);
			if (!loc) return;
			const src = this.slots[slot].call.src;
			const position = {
				lat: loc.lat,
				lon: loc.lon,
				source: 'GPS LC',
				src,
				slot,
				radiusM: loc.errorM >= 0 ? loc.errorM : undefined,
				at: Date.now(),
			};
			this.update(
				{ position },
				{ kind: 'position', slot, text: `${src || '?'}: ${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)} (GPS LC)` },
				now,
			);
		}
	}

	/**
	 * The call identity of the embedded LC. It is protected by a 5-bit checksum only: one that passes by chance must not
	 * mark a clear call encrypted or swap its IDs. Privacy and an ID change are believed when two embedded LCs in a row
	 * agree; clear and unchanged are taken at once.
	 */
	private embeddedCall(slot: number, f: FullLc, now: number): void {
		const s = this.slots[slot];
		const key = `${f.src}/${f.dst}/${f.svc}`;
		const agreed = s.embPendKey === key;
		s.embPendKey = key;
		const idChange = s.inCall && s.call.idsKnown && (s.call.src !== f.src || s.call.dst !== f.dst);
		if (((f.svc & 0x40) !== 0 || idChange) && !agreed) return;
		const kind = callKind(f.flco, f.dst);
		if (!s.inCall || idChange) this.startCall(slot, kind, f, true, now);
		else if (!s.call.idsKnown) {
			Object.assign(s.call, {
				src: f.src,
				dst: f.dst,
				kind,
				idsKnown: true,
				emergency: (f.svc & 0x80) !== 0,
				privacy: (f.svc & 0x40) !== 0,
			});
			this.update({}, { kind: 'call', slot, text: callText(s.call) }, now);
		} else {
			if (f.svc & 0x40) s.call.privacy = true; // confirmed twice
			return;
		}
		const c = s.call;
		this.lateCall = {
			colourCode: s.cc,
			terminator: false,
			group: c.kind !== 'private',
			featureSet: f.fid,
			emergency: c.emergency,
			privacy: c.privacy,
			target: c.dst,
			source: c.src,
			lateEntry: c.lateEntry,
			slot,
			at: Date.now(),
		};
	}

	private talkerAlias(slot: number, f: FullLc, now: number): void {
		const s = this.slots[slot];
		s.ta.add(f);
		const text = s.ta.complete() ? s.ta.text() : '';
		if (!text || text === s.alias) return;
		s.alias = text;
		s.call.alias = text;
		const src = s.call.src;
		this.update({ alias: { text, slot, src } }, { kind: 'alias', slot, text: `Talker alias "${text}"${src ? ` (${src})` : ''}` }, now);
	}

	private csbkBurst(slot: number, bits: Uint8Array, z: Float32Array, now: number): boolean {
		const [cor, info] = bptcAssisted(bits, z, (i) => csbkParse(i) !== null);
		const c = cor >= 0 ? csbkParse(info) : null;
		if (!c) return false;
		this.endVoiceByData(slot);
		if (xptParseCsbk(c, now, this.xpt)) {
			this.xptSite();
			return true;
		}
		const s = this.slots[slot];
		const key = `${c.opcode}/${c.fid}/${be24(c.data, 2)}/${be24(c.data, 5)}`;
		const repeat = key === s.lastCsbkKey && now - s.lastCsbkSec < 3;
		if (!repeat) {
			s.lastCsbkKey = key;
			s.lastCsbkSec = now;
		}
		const { text, kind } = this.csbkText(c);
		this.update({ control: { text, slot, at: Date.now() } }, repeat || !kind ? undefined : { kind, slot, text }, now);
		return true;
	}

	/** A CSBK in words, and the kind of event it makes ('' for none); trunking blocks update the system line. */
	private csbkText(c: Csbk): { text: string; kind: DmrEvent['kind'] | '' } {
		const vendor = vendorCsbkName(c.fid, c.opcode);
		if (c.fid === 0x06) this.connectPlusSite(c);
		const vg = vendorGrants(c, this.capPlus);
		if (vg?.rest !== undefined) this.update({ system: { kind: 'Capacity Plus', text: `rest channel ${vg.rest}`, at: Date.now() } });
		if (vg?.grants.length) return { text: `${vendor}: ${vg.grants.map(grantText).join(', ')}`, kind: 'grant' };
		if (vg && vg.rest !== undefined) return { text: `${vendor}: no calls`, kind: '' };
		if (vendor) return { text: vendor, kind: '' };
		const t3 = tier3Text(c);
		if (t3) {
			const sys = tier3SystemCode(c);
			if (sys)
				this.update({
					system: { kind: 'Tier III', text: `${sys.model} network ${sys.net} site ${sys.site} (${sys.par})`, at: Date.now() },
				});
			return { text: t3, kind: tier3Grant(c) ? 'grant' : '' };
		}
		const ids =
			c.opcode === 0x3d || c.opcode === 0x04 || c.opcode === 0x38 || c.opcode === 0x05 ? `: ${be24(c.data, 5)} → ${be24(c.data, 2)}` : '';
		const name = `${csbkName(c.opcode, c.fid)} (opcode ${c.opcode.toString(16).toUpperCase().padStart(2, '0')}${c.fid ? ', manufacturer' : ''})`;
		return { text: name + ids, kind: c.opcode === 0x3d ? '' : 'control' };
	}

	private xptSite(): void {
		this.update({ system: { kind: 'Hytera XPT', text: xptSummary(this.xpt).replace(/^Hytera XPT: /, ''), at: Date.now() } });
	}

	/** The system line of a Connect Plus site: its neighbours when announced. */
	private connectPlusSite(c: Csbk): void {
		const n = c.opcode === 0x01 ? conPlusParse(c.opcode, c.data)?.neighbours.filter(Boolean) : null;
		const old = this.info.system?.kind === 'Connect Plus' ? this.info.system.text : 'control channel';
		this.update({ system: { kind: 'Connect Plus', text: n?.length ? `neighbour sites ${n.join(', ')}` : old, at: Date.now() } });
	}

	private dataHeader(slot: number, bits: Uint8Array, z: Float32Array, now: number): boolean {
		const [cor, info] = bptcAssisted(bits, z, (i) => crcBlockCheck(i, MASK_DATA_HEADER) !== null);
		const d = cor >= 0 ? crcBlockCheck(info, MASK_DATA_HEADER) : null;
		const hd = d && D.parseDataHeader(d);
		if (!d || !hd) return false;
		this.endVoiceByData(slot);
		const s = this.slots[slot];
		const m = s.msg;
		if (hd.dpf === D.DPF_PROPRIETARY && m.active && m.got === 0 && !m.prop) {
			// the second header of a packet (Motorola's compressed IP/UDP header): one of the blocks to follow
			m.prop = d;
			if (++m.got >= m.hdr.blocks) this.finish(slot, now);
			return true;
		}
		const withBlocks = [D.DPF_UNCONFIRMED, D.DPF_CONFIRMED, D.DPF_SHORT_DEFINED, D.DPF_SHORT_RAW, D.DPF_RESPONSE, D.DPF_UDT].includes(
			hd.dpf,
		);
		s.msg = {
			active: hd.blocks > 0 && withBlocks,
			hdr: hd,
			dt: 0,
			bytes: [],
			got: 0,
			confirmed: hd.dpf === D.DPF_CONFIRMED,
			crcAllOk: true,
			prop: null,
		};
		if (hd.dpf === D.DPF_SHORT_RAW && hd.blocks === 0) {
			// status / precoded short data: no blocks follow
			const text = `status ${hd.status}`;
			const message = { text, format: 'status / precoded', src: hd.src, dst: hd.dst, group: hd.group, slot, crcOk: true, at: Date.now() };
			this.update({ message }, { kind: 'data', slot, text: `Status ${hd.status}: ${hd.src} → ${hd.dst}` }, now);
		}
		return true;
	}

	/** One block of a rate 1/2, 3/4 or 1 data message. */
	private dataBlock(slot: number, dt: number, bits: Uint8Array, z: Float32Array, now: number): boolean {
		let oct: Uint8Array | null = null;
		if (dt === D.DT_RATE12) {
			const [cor, info] = bptcAssisted(bits, z);
			if (cor >= 0) oct = bitsToBytes(info, 0, 96);
		} else if (dt === D.DT_RATE34) {
			const sym = new Float32Array(98);
			sym.set(z.subarray(0, 49), 0);
			sym.set(z.subarray(83, 132), 49);
			const [bad, data] = trellis34Decode(sym);
			if (bad >= 0) oct = data;
		} else oct = rate1Decode(burstDataPayload(bits)).data;
		if (!oct) return false;
		const m = this.slots[slot].msg;
		if (!m.active) return true; // a block without its header: nothing to attach it to
		if (m.dt === 0) m.dt = dt;
		if (dt !== m.dt) {
			m.active = false;
			return true;
		}
		const blk = D.dataBlockParse(dt, oct, m.confirmed);
		if (!blk) return true;
		if (!blk.crcOk) m.crcAllOk = false;
		m.bytes.push(...blk.bytes);
		if (++m.got >= m.hdr.blocks) this.finish(slot, now);
		return true;
	}

	/** A data message whose blocks have all arrived: its text, its position. */
	private finish(slot: number, now: number): void {
		const m = this.slots[slot].msg;
		m.active = false;
		const r = finishMessage(m);
		const { src, dst, group } = m.hdr;
		if (r.location?.hasFix) {
			const loc = r.location;
			const position = {
				lat: loc.lat,
				lon: loc.lon,
				source: r.source,
				src,
				slot,
				speedKmh: loc.speedMs === undefined ? undefined : loc.speedMs * 3.6,
				headingDeg: loc.headingDeg,
				radiusM: loc.radiusM,
				at: Date.now(),
			};
			this.update(
				{ position },
				{ kind: 'position', slot, text: `${src}: ${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)} (${r.source})` },
				now,
			);
			return;
		}
		const crc = r.crcOk ? '' : ' (CRC wrong)';
		const textual = !r.location && !r.format.startsWith('ARS') && !r.format.endsWith('acknowledgment') && !/^\d+ bytes$|^\[/.test(r.text);
		const patch = textual ? { message: { text: r.text, format: r.format, src, dst, group, slot, crcOk: r.crcOk, at: Date.now() } } : {};
		this.update(patch, { kind: textual ? 'message' : 'data', slot, text: `${r.format} ${src} → ${dst}${crc}: ${r.text}` }, now);
	}
}
