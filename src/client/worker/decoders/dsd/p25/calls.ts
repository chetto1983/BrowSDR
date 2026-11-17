// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/p25/p25_rx.cpp (P25Receiver::Impl: nid with the known NAC, frame,
// lduHex, startCall, endCall, hdu, ldu, term, tsbks, pdu, grant, onCc, onTsbk, freqOf, voiceFrame, event),
// https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the frames come from BrowSDR's 4800 symbols/s DSD chain (its sync search and clock recovery), read piece by
// piece: the NID first, then what its data unit needs (a TSBK frame one block at a time, so the next frame's sync is not
// read over); each piece is re-sampled at the timing with the cleanest decisions (frame-timing.ts). The call, the site,
// its neighbours, the channel identifiers, the last grant and 20 events go to BrowSDR's DSD status; OnAir's call log,
// talkgroup table, patch and affiliation lists, decryption with user keys and trunking follower are left out (encrypted
// voice is reported and never reaches the codec). Voice goes to the decoder's mbelib in DSD's IMBE order (dsd-p25.ts).
import { extractP25IMBE } from '@/worker/decoders/dsd/dsd-p25';
import { chainLevels } from '@/worker/decoders/dsd/frame-timing';
import type { DsdChain, DsdEvent, DsdSink } from '@/worker/decoders/dsd/types';
import { rsDecode } from '@/worker/decoders/dsd/p25p2/rs';
import { mbtToTsbks, pduAssemble, tsbkDescribe } from './cc';
import {
	ALG_CLEAR,
	HDU,
	LC_GROUP,
	LC_UNIT,
	LDU1,
	LDU2,
	PDU,
	SYNC,
	SYNC_SYM,
	TDU,
	TDULC,
	TSBK,
	algName,
	crcCcitt,
	duidName,
	esParse,
	frameLen,
	golay24Decode,
	hardDibit,
	hduParse,
	isStatusPos,
	lcParse,
	mlGolay18,
	mlHamming,
	nidDecode,
	nidDecodeKnownNac,
	softBits,
	trellisDecode,
	tsbkParse,
} from './proto';
import { onTsbk } from './tsbk';
import type { P25Call, P25ControlState, P25Crypto, P25Iden, P25Status, P25Tsbk } from './types';

/** What the 4800 symbols/s chain reads after the sync: the NID with its status symbol (frame positions 24..56). */
export const P25_NID_READ = 33;
/** The payload's first data dibit (sync and NID, status symbols out). */
const P = 56;
const EVENTS_MAX = 20;
const VC_OFF = [0, 72, 164, 256, 348, 440, 532, 624, 712];
const HEX_OFF = [144, 236, 328, 420, 512, 604];

/** The frame length (status symbols in) that holds n data dibits. */
function rawFor(n: number): number {
	let p = 0;
	for (let k = 0; k < n; p++) if (!isStatusPos(p)) k++;
	return p;
}

const bitsToBytes12 = (b: Uint8Array): Uint8Array =>
	Uint8Array.from({ length: 12 }, (_, i) => b.slice(8 * i, 8 * i + 8).reduce((v, x) => (v << 1) | x, 0));

/** P25 Phase 1 on the 4800 symbols/s chain: data units, calls, the control channel and the events. */
export class P25Frames {
	private events: DsdEvent[] = [];
	private call: (P25Call & { last: number }) | null = null;
	private shown?: P25Call;
	readonly cc: P25ControlState = { adjacent: [], idens: new Array<P25Iden | null>(16).fill(null), grants: [], control: false };
	private knownNac = -1;
	private lastNac = -1;
	private knownCount = 0;
	private nac = -1;
	private duid = -1;
	private blocks = 0;
	private blocksOk = 0;
	private blocksBad = 0;
	private inverted = false;
	/** The dibit position of the frame being read (the chain's clock). */
	private at = 0;
	private chain!: DsdChain;

	constructor(private sink: DsdSink) {}

	reset(): void {
		this.endCall(false);
		this.events = [];
		this.shown = undefined;
		Object.assign(this.cc, {
			site: undefined,
			adjacent: [],
			idens: new Array(16).fill(null),
			grant: undefined,
			grants: [],
			control: false,
		});
		this.knownNac = this.lastNac = -1;
		this.blocksOk = this.blocksBad = 0;
	}

	/** No sync for a second: a call without its terminator was lost. */
	expire(): void {
		if (this.call) {
			this.endCall(false);
			this.publish();
		}
	}

	/**
	 * A piece read after a P25 frame sync that ended at start: the NID when read is P25_NID_READ, else the rest of the
	 * data unit or its next TSBK / PDU block. Returns the dibits to read next, 0 when the frame is done.
	 */
	frame(chain: DsdChain, start: number, read: number): number {
		this.at = start;
		this.chain = chain;
		const more = read === P25_NID_READ ? this.nid(chain, start) : this.payload(chain, start, read);
		this.publish();
		return more;
	}

	private nid(chain: DsdChain, start: number): number {
		const lv = chainLevels(chain, start - SYNC_SYM, SYNC_SYM + P25_NID_READ, SYNC);
		if (!lv) return 0;
		const bits = new Uint8Array(64);
		for (let p = SYNC_SYM, k = 0; k < 32; p++) {
			if (isStatusPos(p)) continue;
			const d = hardDibit(lv.x[p]);
			bits[2 * k] = d >> 1;
			bits[2 * k++ + 1] = d & 1;
		}
		const id = this.nidOf(bits);
		if (!id) {
			this.blocksBad++;
			return 0;
		}
		this.blocksOk++;
		Object.assign(this, { nac: id.nac, duid: id.duid, blocks: 0, inverted: lv.g < 0 });
		const status = this.sink.status();
		Object.assign(status, { nac: id.nac, duid: duidName(id.duid), mbeDecoding: false });
		if (this.call && start - this.call.last > 4800) this.endCall(false); // a second without the call's frames
		if (id.duid === TSBK || id.duid === PDU) return rawFor(P + 98) - SYNC_SYM - P25_NID_READ;
		return frameLen(id.duid) - SYNC_SYM - P25_NID_READ;
	}

	/** The NID; with the site's NAC known (three frames in a row agreed on it) a damaged one is read as one of its frame types. */
	private nidOf(bits: Uint8Array): { nac: number; duid: number } | null {
		const id = nidDecode(bits, this.knownNac >= 0 ? this.knownNac : this.lastNac);
		if (id && frameLen(id.duid)) {
			if (this.knownNac >= 0 && id.nac !== this.knownNac) this.knownCount = this.knownNac = -1; // another system on this frequency
			this.knownCount = id.nac === this.lastNac ? this.knownCount + 1 : 1;
			if (this.knownCount >= 3) this.knownNac = id.nac;
			this.lastNac = id.nac;
			return id;
		}
		const known = this.knownNac >= 0 ? nidDecodeKnownNac(bits, this.knownNac) : null;
		return known ? { nac: this.knownNac, duid: known.duid } : null;
	}

	private payload(chain: DsdChain, start: number, read: number): number {
		const lv = chainLevels(chain, start - SYNC_SYM, SYNC_SYM + read, SYNC);
		if (!lv) return 0;
		const dl = lv.x.filter((_, p) => !isStatusPos(p));
		if (this.duid === TSBK) return this.tsbk(dl, read);
		if (this.duid === PDU) return this.pdu(dl, read);
		if (this.duid === HDU) this.hdu(dl);
		else if (this.duid === LDU1 || this.duid === LDU2) this.ldu(dl);
		else if (this.duid === TDULC) this.term(dl);
		else if (this.duid === TDU) this.endCall(true);
		return 0;
	}

	/** Each TSBK block in turn: the next one is read only when this one checked and is not the last. */
	private tsbk(dl: Float32Array, read: number): number {
		const bits = trellisDecode(dl, P + 98 * this.blocks);
		const t = bits && tsbkParse(bits);
		this.count(!!t);
		if (!t) return 0;
		this.cc.control = true;
		this.onTsbk(t);
		if (t.last || ++this.blocks >= 3) return 0;
		return rawFor(P + 98 * (this.blocks + 1)) - SYNC_SYM - read;
	}

	private onTsbk(t: P25Tsbk): void {
		const cc = tsbkDescribe(t.mfid, t.opcode, t.args);
		if (cc) this.event(cc.text);
		if (t.mfid === 0 || t.mfid === 1) onTsbk(t, this.cc, this.nac, this.at, (text) => this.event(text));
	}

	/** The header block, then its data blocks: multi-block trunking or unconfirmed data. */
	private pdu(dl: Float32Array, read: number): number {
		const head = trellisDecode(dl, P);
		if (!head || head.slice(80).reduce((v, x) => (v << 1) | x, 0) !== crcCcitt(head, 80)) return this.count(false);
		const nb = Math.min(
			head.slice(49, 56).reduce((v, x) => (v << 1) | x, 0),
			6,
		);
		const have = Math.floor((dl.length - P) / 98) - 1;
		if (have < nb) return rawFor(P + 98 * (nb + 1)) - SYNC_SYM - read;
		const blocks = [bitsToBytes12(head)];
		for (let k = 1; k <= nb; k++) {
			const d = trellisDecode(dl, P + 98 * k);
			if (!d) break;
			blocks.push(bitsToBytes12(d));
		}
		this.count(true);
		const mbt = mbtToTsbks(blocks);
		if (mbt) {
			for (const t of mbt) this.onTsbk(t);
			return 0;
		}
		const h = blocks[0];
		const llid = (h[3] << 16) | (h[4] << 8) | h[5];
		const out = !!(h[0] & 0x20);
		const data = pduAssemble(blocks);
		const what = data ? `data: ${data.summary}` : `SAP ${h[1] & 0x3f}, ${h[6] & 0x7f} blocks`;
		this.event(`PDU ${out ? 'to' : 'from'} LLID ${llid}, ${what}`);
		return 0;
	}

	/** 24 Hamming words (from 120 data dibits taken in six pieces), soft decided, then RS (24, k). */
	private lduHex(dl: Float32Array, k: number): Uint8Array | null {
		const s = new Uint8Array(24);
		const sb = new Float32Array(240);
		HEX_OFF.forEach((off, piece) => sb.set(softBits(dl, P + off, 20), 40 * piece));
		for (let w = 0; w < 24; w++) s[w] = mlHamming(sb, 10 * w);
		return rsDecode(s, 24, k) >= 0 ? s.subarray(0, k) : null;
	}

	/** The header word: 36 Golay (18,6) words, soft decided, then RS (36,20). */
	private hduWord(dl: Float32Array): P25Crypto | null {
		const sb = softBits(dl, P, 324);
		const s = Uint8Array.from({ length: 36 }, (_, w) => mlGolay18(sb, 18 * w));
		return rsDecode(s, 36, 20) >= 0 ? hduParse(s.subarray(0, 20)) : null;
	}

	/**
	 * A call's first link control without its header: the header frame before this LDU1, or before the LDU pair or two
	 * before it, is looked for in the buffer (the clock recovery may still have been settling on its sync after the
	 * silence before the call).
	 */
	private hduBefore(): P25Crypto | null {
		for (let pairs = 0; pairs <= 2; pairs++) {
			const first = this.at - SYNC_SYM - 2 * frameLen(LDU1) * pairs - frameLen(HDU);
			const lv = chainLevels(this.chain, first, frameLen(HDU), SYNC);
			if (!lv) return null;
			const dl = lv.x.filter((_, p) => !isStatusPos(p));
			const bits = new Uint8Array(64);
			for (let k = 0; k < 32; k++) {
				const d = hardDibit(dl[SYNC_SYM + k]);
				bits[2 * k] = d >> 1;
				bits[2 * k + 1] = d & 1;
			}
			const id = nidDecode(bits, this.nac);
			if (id && id.nac === this.nac && id.duid === HDU) return this.hduWord(dl);
		}
		return null;
	}

	private hdu(dl: Float32Array, c = this.hduWord(dl)): void {
		this.count(!!c);
		if (!c) return;
		this.startCall(false);
		const call = this.call as P25Call;
		Object.assign(call, { dst: c.tg > 0 ? c.tg : -1, group: true, algId: c.algId, keyId: c.keyId, encrypted: c.algId !== ALG_CLEAR });
		const crypto = call.encrypted
			? `, encrypted: ${algName(c.algId)} (0x${c.algId.toString(16).toUpperCase()}), key ${c.keyId}`
			: ', clear';
		this.event(`HDU NAC ${this.nacText()} talkgroup ${c.tg}${crypto}`);
	}

	private ldu(dl: Float32Array): void {
		const one = this.duid === LDU1;
		const hex = this.lduHex(dl, one ? 12 : 16);
		this.count(!!hex);
		if (hex && one) this.linkControl(hex);
		else if (hex && this.call) this.encryptionSync(hex);
		const call = this.call;
		if (!call) return;
		call.last = this.at;
		const frames = VC_OFF.map((off) =>
			extractP25IMBE(
				Uint8Array.from({ length: 72 }, (_, i) => hardDibit(dl[P + off + i])),
				0,
			),
		);
		call.voiceFrames += frames.length;
		call.durSec = call.voiceFrames * 0.02;
		if (!call.encrypted) this.sink.voice(frames);
	}

	private linkControl(hex: Uint8Array): void {
		const l = lcParse(hex);
		if ((l.lco !== LC_GROUP && l.lco !== LC_UNIT) || l.mfid > 1) return;
		const grp = l.lco === LC_GROUP;
		const dst = grp ? l.tg : l.dst;
		const n = this.call;
		const flags = `${l.svcOpts & 0x80 ? ', EMERGENCY' : ''}${l.svcOpts & 0x40 ? ', encrypted' : ''}`;
		const header = !n ? this.hduBefore() : null;
		if (header) this.hdu(new Float32Array(0), header);
		if (!this.call || (n && ((n.dst >= 0 && n.dst !== dst) || (n.src >= 0 && n.src !== l.src)))) {
			this.startCall(true);
			this.event(`LDU1 ${grp ? 'group' : 'unit to unit'} ${l.src} → ${dst}${flags} (joined late)`);
		} else if ((this.call as P25Call).src < 0) this.event(`LDU1 ${grp ? 'group' : 'unit to unit'} ${l.src} → ${dst}${flags}`);
		const call = this.call as P25Call;
		Object.assign(call, { src: l.src, dst, group: grp, emergency: !!(l.svcOpts & 0x80) });
		if (l.svcOpts & 0x40) call.encrypted = true;
		Object.assign(this.sink.status(), { src: l.src, tg: dst, emr: call.emergency });
	}

	private encryptionSync(hex: Uint8Array): void {
		const c = esParse(hex);
		const call = this.call as P25Call;
		if (c.algId === call.algId && c.keyId === call.keyId) return;
		Object.assign(call, { algId: c.algId, keyId: c.keyId, encrypted: c.algId !== ALG_CLEAR });
		this.sink.status().algid = c.algId;
		if (call.encrypted) this.event(`LDU2 encrypted: ${algName(c.algId)} (0x${c.algId.toString(16).toUpperCase()}), key ${c.keyId}`);
	}

	/** TDULC: 12 Golay (24,12) words (hard decided), RS (24,12). */
	private term(dl: Float32Array): void {
		const s = new Uint8Array(24);
		for (let w = 0; w < 12; w++) {
			let cw = 0;
			for (let i = 0; i < 12; i++) cw = (cw << 2) | hardDibit(dl[P + 12 * w + i]);
			const { data } = golay24Decode(cw >>> 0);
			const d = data < 0 ? cw >>> 12 : data;
			s[2 * w] = d >> 6;
			s[2 * w + 1] = d & 63;
		}
		this.count(rsDecode(s, 24, 12) >= 0);
		this.endCall(true);
	}

	private count(ok: boolean): 0 {
		if (ok) this.blocksOk++;
		else this.blocksBad++;
		return 0;
	}

	private startCall(late: boolean): void {
		if (this.call) this.endCall(false);
		this.call = {
			active: true,
			src: -1,
			dst: -1,
			group: true,
			emergency: false,
			encrypted: false,
			algId: ALG_CLEAR,
			keyId: 0,
			lateEntry: late,
			endSeen: false,
			voiceFrames: 0,
			durSec: 0,
			last: this.at,
		};
		this.sink.reset();
	}

	private endCall(term: boolean): void {
		const n = this.call;
		if (!n) return;
		this.call = null;
		const { last: _last, ...call } = n;
		this.shown = { ...call, active: false, endSeen: term };
		this.sink.reset();
		const to = `${n.group ? 'TG ' : ''}${n.dst < 0 ? '?' : n.dst}`;
		this.event(
			`call ${n.src < 0 ? '?' : n.src} → ${to}, ${n.durSec.toFixed(1)} s${n.encrypted ? ', encrypted' : ''}${term ? '' : ', signal lost'}`,
		);
		this.publish();
	}

	private nacText(): string {
		return this.nac.toString(16).toUpperCase().padStart(3, '0');
	}

	private event(text: string): void {
		if (this.events[0]?.text === text) return;
		this.events = [{ at: Date.now(), text }, ...this.events].slice(0, EVENTS_MAX);
	}

	private publish(): void {
		const call = this.call ? (({ last: _last, ...c }) => c)(this.call) : this.shown;
		const { site, adjacent, idens, grant, control } = this.cc;
		const p25: P25Status = {
			nac: this.nac,
			duid: duidName(this.duid),
			control,
			adjacent: [...adjacent],
			idens: [...idens],
			blocksOk: this.blocksOk,
			blocksBad: this.blocksBad,
			inverted: this.inverted,
			events: this.events,
		};
		if (call) p25.call = call;
		if (site) p25.site = site;
		if (grant) p25.grant = grant;
		this.sink.status().p25 = p25;
	}
}
