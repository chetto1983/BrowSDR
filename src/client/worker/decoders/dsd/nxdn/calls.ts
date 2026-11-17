// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/nxdn/nxdn_rx.cpp (NxdnReceiver::Impl: decodeFrame from the LICH
// on, startCall, endCall, endData, lost, trustCipher, onMsg, voiceFrame, event), https://github.com/adswill/OnAir; see
// third_party/onair.
// Changes: the transmission on air (or the last one), the site and the last 20 events go to BrowSDR's DSD status instead
// of OnAir's call log and event list; voice goes to the decoder's mbelib, never for an encrypted call (OnAir decrypts with
// a key the user loaded; BrowSDR has no keys). A SACCH CRC alone (6 bits: noise passes it once in 64) counts only on a
// frame that sits on a grid of frame syncs; the first frame after a search needs a FACCH1 or CAC. Signal time is counted
// in 48 kHz samples by the NXDN48 receiver's tick.
import { ambeFrame } from '@/worker/decoders/dsd/ambe';
import type { DsdEvent, DsdSink, SyncType } from '@/worker/decoders/dsd/types';
import {
	CAC,
	FACCH1,
	FCT_SACCH_SF,
	RCCH,
	SACCH,
	SD_DATA,
	SD_HEADER,
	SITE_INFO,
	SRV_INFO,
	STAT_REQ,
	TX_REL,
	VCALL,
	callTypeName,
	decode,
	emptyMsg,
	lichDecode,
	locSite,
	locSystem,
	msgName,
	parseMsg,
} from './proto';
import type { NxdnDecoded, NxdnFrame, NxdnLich, NxdnMsg, NxdnSite, NxdnStatus, NxdnTx } from './types';

const RATE = 48000;
const EVENTS_MAX = 20;
const RFCT = ['RCCH', 'RTCH', 'RDCH', 'composite'];
const FCT = ['SACCH', 'UDCH', 'SACCH superframe', 'SACCH superframe idle'];
const OPT = ['FACCH1 + FACCH1', 'FACCH1 + voice', 'voice + FACCH1', 'voice + voice'];
const id = (v: number) => (v < 0 ? '?' : String(v));

function lichText(l: NxdnLich): string {
	const dir = l.dir ? 'outbound' : 'inbound';
	if (l.rfct === RCCH) return `RCCH, CAC, ${dir}`;
	return `${RFCT[l.rfct]}, ${FCT[l.fct]}, ${OPT[l.opt]}, ${dir}`;
}

/** The NXDN calls, status and short data of one channel, from the frames of either rate. */
export class NxdnCalls {
	/** The voice call on air, and the transmission shown (the latest one). */
	private tx: NxdnTx | null = null;
	private shown: NxdnTx | null = null;
	private sd: NxdnTx | null = null;
	private sdBlocks = 0;
	private site?: NxdnSite;
	private events: DsdEvent[] = [];
	private ran = -1;
	private lastLich: NxdnLich | null = null;
	private frameText = '';
	private sf: Array<Uint8Array | null> = [null, null, null, null];
	private statKey = -1;
	private statAt = -1e12;
	private pendCipher = 0;
	private pendKey = 0;
	private blocksOk = 0;
	private blocksBad = 0;
	private inverted = false;
	/** Signal time (48 kHz samples), the last frame that belonged to the call, and its chain (0 NXDN48, 1 NXDN96). */
	private now = 0;
	private lastFrame = -1e12;
	private lastChain = -1;

	constructor(private sink: DsdSink) {}

	reset(): void {
		this.lost();
		this.shown = null;
		this.site = undefined;
		this.events = [];
		this.ran = -1;
		this.blocksOk = this.blocksBad = 0;
	}

	/** Signal time passes; a call whose frames stopped half a second ago was lost. */
	tick(samples: number): void {
		this.now += samples;
		if ((this.tx || this.sd) && this.now - this.lastFrame > RATE / 2) {
			this.lost();
			this.publish();
		}
	}

	/**
	 * One frame of either chain; announce: the sync to count when the frame checks (NXDN48 and the NXDN96 syncs that the
	 * decoder did not announce itself). Returns true when a channel passed its CRC.
	 */
	frame(f: NxdnFrame, chain: number, announce?: SyncType): boolean {
		const lich = this.lich(f.sym);
		if (!lich) return false;
		const d = this.channels(f.sym, lich.l);
		// A SACCH CRC alone counts only on a grid of frame syncs.
		const trusted = d.any && (d.strong || f.onGrid);
		if (trusted) {
			this.frameText = lichText(lich.l);
			for (const [m, fromSacch] of d.msgs) this.onMsg(m, f.baud, chain, fromSacch);
		}
		const active = this.follow(f, d, chain, trusted && d.sacchOk && lich.ok, lich.ok);
		if (trusted) {
			this.inverted = f.inverted;
			if (announce !== undefined) this.sink.synced(announce);
		}
		if (trusted || active) this.publish();
		return d.any;
	}

	/**
	 * Voice only from frames that are surely the call's: a good SACCH on a found sync starts one (late entry), a good
	 * LICH on the chain of the call goes on with it. Returns whether the frame belongs to the call on air.
	 */
	private follow(f: NxdnFrame, d: NxdnDecoded, chain: number, sure: boolean, lichOk: boolean): boolean {
		const active = !!this.tx?.active && this.lastChain === chain;
		if ((sure && !f.fly) || (lichOk && active && (d.sacchOk || !f.fly))) this.voice(d.voice, f.baud, chain, sure && !f.fly);
		const own = (d.any && (d.strong || f.onGrid)) || (active && lichOk);
		if (own) {
			this.lastFrame = this.now;
			this.lastChain = chain;
		}
		return active;
	}

	/** The LICH, one parity error repaired at the least reliable symbol; the last good one when it does not check. */
	private lich(s: Float32Array): { l: NxdnLich; ok: boolean } | null {
		let lb = 0;
		for (let k = 0; k < 8; k++) lb = (lb << 1) | (s[k] < 0 ? 1 : 0);
		let l = lichDecode(lb);
		if (!l) {
			let wk = 0;
			for (let k = 1; k < 8; k++) if (Math.abs(s[k]) < Math.abs(s[wk])) wk = k;
			if (Math.abs(s[wk]) < 1) l = lichDecode(lb ^ (0x80 >> wk));
		}
		if (l) this.lastLich = l;
		return l ? { l, ok: true } : this.lastLich ? { l: this.lastLich, ok: false } : null;
	}

	/** The soft bits of the 174 channel symbols (> 0 a 1) through SACCH, FACCH1 or CAC, and the voice frames. */
	private channels(s: Float32Array, l: NxdnLich): NxdnDecoded {
		const sb = new Float32Array(348);
		for (let k = 0; k < 174; k++) {
			const x = s[8 + k];
			sb[2 * k] = Math.max(-3, Math.min(3, -x));
			sb[2 * k + 1] = Math.max(-1, Math.min(1, Math.abs(x) - 2)) * 2;
		}
		const d: NxdnDecoded = { any: false, strong: false, sacchOk: false, msgs: [], voice: [] };
		if (l.rfct === RCCH) this.cac(sb, d);
		else {
			this.sacch(sb.subarray(0, 60), l, d);
			for (let h = 0; h < 2; h++) {
				const hb = sb.subarray(60 + 144 * h, 204 + 144 * h);
				if (l.opt === 0 || (l.opt === 1 && h === 0) || (l.opt === 2 && h === 1)) this.facch(hb, d);
				else for (let vf = 0; vf < 2; vf++) d.voice.push(Uint8Array.from(hb.subarray(72 * vf, 72 * vf + 72), (x) => (x > 0 ? 1 : 0)));
			}
		}
		return d;
	}

	private ranOf(info: Uint8Array): number {
		let ran = 0;
		for (let i = 2; i < 8; i++) ran = (ran << 1) | info[i];
		return ran;
	}

	private cac(sb: Float32Array, d: NxdnDecoded): void {
		const r = decode(CAC, sb);
		this.count(!!r);
		if (!r) return;
		Object.assign(d, { any: true, strong: true });
		this.ran = this.ranOf(r.info);
		const m = parseMsg(r.info.subarray(8), 147);
		if (m) d.msgs.push([m, false]);
	}

	private sacch(sb: Float32Array, l: NxdnLich, d: NxdnDecoded): void {
		const r = decode(SACCH, sb);
		this.count(!!r);
		if (!r) {
			this.sf.fill(null);
			return;
		}
		Object.assign(d, { any: true, sacchOk: true });
		this.ran = this.ranOf(r.info);
		if (l.fct !== FCT_SACCH_SF) return;
		// Four SACCHs of a superframe carry one 72-bit message, the structure field counting down.
		const part = 3 - ((r.info[0] << 1) | r.info[1]);
		if (part === 0) this.sf.fill(null);
		this.sf[part] = r.info.slice(8, 26);
		if (part !== 3 || this.sf.some((x) => !x)) return;
		const mb = new Uint8Array(72);
		this.sf.forEach((x, p) => mb.set(x as Uint8Array, 18 * p));
		this.sf.fill(null);
		const m = parseMsg(mb, 72);
		if (m) d.msgs.push([m, true]);
	}

	private facch(hb: Float32Array, d: NxdnDecoded): void {
		const r = decode(FACCH1, hb);
		this.count(!!r);
		if (!r) return;
		Object.assign(d, { any: true, strong: true });
		const m = parseMsg(r.info, 80);
		if (m) d.msgs.push([m, false]);
	}

	private count(ok: boolean): void {
		if (ok) this.blocksOk++;
		else this.blocksBad++;
	}

	private voice(frames: Uint8Array[], baud: number, chain: number, sure: boolean): void {
		if (!frames.length || (!this.tx?.active && !sure)) return;
		if (!this.tx?.active) this.startCall(emptyCall(), baud, chain, true);
		const tx = this.tx as NxdnTx;
		tx.voiceFrames += frames.length;
		// Encrypted: reported, never decoded.
		if (tx.cipher === 0) this.sink.voice(frames.map((vb) => ambeFrame(vb)));
		const status = this.sink.status();
		status.nxdnType = 'Voice';
	}

	private event(text: string): void {
		this.events = [{ at: Date.now(), text }, ...this.events].slice(0, EVENTS_MAX);
	}

	private fresh(kind: NxdnTx['kind'], m: NxdnMsg, baud: number, chain: number): NxdnTx {
		return {
			kind,
			active: kind === 'voice',
			src: m.src,
			dst: m.dst,
			callType: callTypeName(m.callType),
			cipher: m.cipher,
			keyId: m.keyId,
			ran: this.ran,
			baud,
			lateEntry: false,
			endSeen: kind !== 'voice',
			voiceFrames: 0,
			durSec: 0,
			text: '',
			start: this.now,
			chain,
		};
	}

	private startCall(m: NxdnMsg, baud: number, chain: number, late: boolean): void {
		if (this.tx) this.endCall(false);
		this.tx = { ...this.fresh('voice', m, baud, chain), lateEntry: late };
		this.shown = this.tx;
		this.lastChain = chain;
		this.lastFrame = this.now;
		this.sink.reset();
	}

	private endCall(rel: boolean): void {
		const tx = this.tx;
		if (!tx) return;
		Object.assign(tx, { active: false, endSeen: rel, durSec: (this.now - tx.start) / RATE });
		this.pendCipher = this.pendKey = 0;
		this.tx = null;
		this.sink.reset();
		this.event(`call ${id(tx.src)} → ${id(tx.dst)} (${tx.callType}), ${tx.durSec.toFixed(1)} s${rel ? '' : ', signal lost'}`);
	}

	private endData(): void {
		const sd = this.sd;
		if (!sd) return;
		this.sd = null;
		sd.durSec = (this.now - sd.start) / RATE;
		this.shown = sd;
		this.event(`short data ${id(sd.src)} → ${id(sd.dst)}: ${sd.text}`);
	}

	private lost(): void {
		this.endCall(false);
		this.endData();
		this.lastLich = null;
		this.sf.fill(null);
	}

	/**
	 * A cipher flag is believed only when it is seen twice in a row: one misparsed message must not turn a clear call into
	 * an encrypted one. Clear is taken at once.
	 */
	private trustCipher(m: NxdnMsg): boolean {
		if (m.cipher === 0) {
			this.pendCipher = 0;
			return true;
		}
		const seen = this.pendCipher === m.cipher && this.pendKey === m.keyId;
		this.pendCipher = m.cipher;
		this.pendKey = m.keyId;
		return seen || (!!this.tx?.active && this.tx.cipher === m.cipher && this.tx.keyId === m.keyId);
	}

	private onMsg(m: NxdnMsg, baud: number, chain: number, fromSacch: boolean): void {
		if (m.type === VCALL) this.vcall(m, baud, chain, fromSacch);
		else if (m.type === TX_REL) {
			if (this.sd) this.endData();
			else if (this.tx?.active) {
				this.endCall(true);
				this.event(`TX_REL ${m.src} → ${m.dst}`);
			}
		} else if (m.type === STAT_REQ) this.statReq(m, baud, chain);
		else if (m.type === SD_HEADER) {
			this.endData();
			this.sd = { ...this.fresh('data', m, baud, chain), active: true, endSeen: false };
			this.sdBlocks = m.blocks;
			this.shown = this.sd;
		} else if (m.type === SD_DATA) this.sdData(m);
		else if (m.type === SITE_INFO || m.type === SRV_INFO) this.siteInfo(m);
	}

	private vcall(m: NxdnMsg, baud: number, chain: number, fromSacch: boolean): void {
		if (!this.trustCipher(m))
			Object.assign(m, { cipher: this.tx?.active ? this.tx.cipher : 0, keyId: this.tx?.active ? this.tx.keyId : 0 });
		const tx = this.tx;
		if (tx?.active && (tx.src === m.src || tx.src < 0) && (tx.dst === m.dst || tx.dst < 0)) {
			// The call goes on, or its ids arrive.
			Object.assign(tx, { src: m.src, dst: m.dst, callType: callTypeName(m.callType), cipher: m.cipher, keyId: m.keyId, ran: this.ran });
			return;
		}
		this.startCall(m, baud, chain, fromSacch);
		const cipher = m.cipher ? `, encrypted (cipher ${m.cipher}, key ${m.keyId})` : '';
		this.event(`VCALL ${callTypeName(m.callType)} ${m.src} → ${m.dst}${cipher}${fromSacch ? ' (joined late)' : ''}`);
	}

	private statReq(m: NxdnMsg, baud: number, chain: number): void {
		const key = (m.src << 8) ^ (m.dst << 4) ^ m.status;
		if (key === this.statKey && this.now - this.statAt < RATE) return; // sent in both halves
		this.statKey = key;
		this.statAt = this.now;
		this.shown = { ...this.fresh('status', m, baud, chain), text: `status ${m.status}` };
		this.event(`status ${m.status} from ${m.src} to ${m.dst}`);
	}

	private sdData(m: NxdnMsg): void {
		const sd = this.sd;
		if (!sd || m.block * 8 < sd.text.length) return;
		sd.text = sd.text.padEnd(m.block * 8, '?') + m.text; // '?' for a lost block
		if (m.block + 1 >= this.sdBlocks) this.endData();
	}

	private siteInfo(m: NxdnMsg): void {
		const news = !this.site || this.site.location !== m.location;
		const channel = m.type === SITE_INFO ? m.channel : (this.site?.channel ?? 0);
		this.site = {
			location: m.location,
			system: locSystem(m.location),
			site: locSite(m.location),
			service: m.service,
			channel,
			ran: this.ran,
		};
		const loc = m.location.toString(16).toUpperCase().padStart(6, '0');
		if (news) this.event(`${msgName(m.type)} location 0x${loc} (system ${this.site.system}, site ${this.site.site}), RAN ${this.ran}`);
	}

	private publish(): void {
		const shown = this.tx ?? this.sd ?? this.shown;
		const status = this.sink.status();
		if (!shown && !this.site) return;
		const call = shown ?? { ...this.fresh('control', emptyCall(), 4800, -1), endSeen: false };
		const { start, chain: _chain, ...rest } = call;
		const durSec = call.active ? (this.now - start) / RATE : call.durSec;
		const nxdn: NxdnStatus = {
			...rest,
			durSec,
			frame: this.frameText,
			blocksOk: this.blocksOk,
			blocksBad: this.blocksBad,
			inverted: this.inverted,
			events: this.events,
		};
		if (this.site) nxdn.site = this.site;
		status.nxdn = nxdn;
		if (!this.tx?.active) status.nxdnType = this.site ? 'Control' : 'Data';
	}
}

/** A call whose ids are not known yet. */
function emptyCall(): NxdnMsg {
	return { ...emptyMsg(VCALL), src: -1, dst: -1 };
}
