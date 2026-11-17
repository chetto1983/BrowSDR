// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR from OnAir core/src/dmr/dmr_gen.cpp (SlotScript: pushVoiceCall, pushText,
// pushCsbk, pushMotoLrrp, pushXptSite, pushIdle, txPacket, txLrrp; DmrSignal::Impl: makeShortLc, pushBurstSymbols,
// fillSymbols; Shaper; crc8Of24), core/src/dmr/dmr_lrrp.cpp (dmrLrrpEncode, dmrLrrpEncodeNoFix, putUintvar,
// putUfloatvar, wrapIpUdp), core/src/dmr/dmr_proto.cpp (talkerAliasPdus) and core/include/dect2/dmr/dmr_dsp.h
// (rrcTaps), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the content is a fixed script instead of random traffic, so a test knows what it sent; voice bursts carry
// valid AMBE+2 frames (the mbelib encoder of voice-fixtures.js) instead of random bits; added to OnAir's content: a GPS
// info LC in the embedded signalling, Tier III Aloha and channel grants, Capacity Plus and Connect Plus blocks, a
// Motorola TMS text, an NMEA sentence and status short data; the FM modulator and the noise are BrowSDR's
// (voice-fixtures.js) at 48 kHz.
import { putBits } from '@/worker/decoders/dsd/dmr/codes';
import { makeDataBurst, makeVoiceBurst, SYNC_BS_DATA, SYNC_BS_VOICE } from '@/worker/decoders/dsd/dmr/burst';
import { addressHash } from '@/worker/decoders/dsd/dmr/control';
import { crc32Msg } from '@/worker/decoders/dsd/dmr/codes';
import * as D from '@/worker/decoders/dsd/dmr/data';
import { crcBlockInfo, csbkInfo, lcBurstInfo, MASK_DATA_HEADER, packFullLc, putBe24 } from '@/worker/decoders/dsd/dmr/lc';
import { aliasPieces } from '@/worker/decoders/dsd/dmr/text';
import { bptc196Encode, cachEncode, dibitToSymbol, embLcEncode, shortLcEncode } from '@/worker/decoders/dsd/dmr/product';
import { xptCallLc, xptSiteStatusCsbk } from '@/worker/decoders/dsd/dmr/xpt';
import { rrcTaps } from '@/worker/decoders/dsd/dsd-dsp';
import { ambeEncode, channel, fmIq, randomBits } from '../voice-fixtures.js';

const IDLE_INFO = [0xff, 0x83, 0xdf, 0x17, 0x32, 0x09, 0x4e, 0xd1, 0xe7, 0xcd, 0x8a, 0x91]; // table D.2
const bytesToBits = (d) => Uint8Array.from({ length: d.length * 8 }, (_, i) => (d[i >> 3] >> (7 - (i & 7))) & 1);
const CC = 1;

// ── LRRP (dmr_lrrp.cpp encoder) ──────────────────────────────────────

function putUintvar(v, x) {
	const tmp = [x & 0x7f];
	while ((x = Math.floor(x / 128))) tmp.push((x & 0x7f) | 0x80);
	for (let i = tmp.length - 1; i >= 0; i--) v.push(tmp[i]);
}
function putUfloatvar(v, x) {
	const integer = Math.floor(Math.max(0, x));
	putUintvar(v, integer);
	putUintvar(v, Math.floor((x - integer) * 128 + 0.5) & 0x7f);
}
const putBe32 = (v, x) => v.push((x >>> 24) & 0xff, (x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff);

function wrapIpUdp(doc, port = 4001) {
	const total = 28 + doc.length;
	const pkt = [0x45, 0, total >> 8, total & 0xff, 0, 0, 0, 0, 0x40, 17, 0, 0, 10, 0, 0, 1, 10, 0, 0, 2];
	let sum = 0;
	for (let i = 0; i < 20; i += 2) sum += (pkt[i] << 8) | pkt[i + 1];
	while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
	pkt[10] = (~sum >> 8) & 0xff;
	pkt[11] = ~sum & 0xff;
	const udpLen = 8 + doc.length;
	pkt.push(port >> 8, port & 0xff, port >> 8, port & 0xff, udpLen >> 8, udpLen & 0xff, 0, 0, ...doc);
	return pkt;
}

/** An IPv4/UDP/LRRP Triggered-Location-Report: request-id, circle-2d and optionally speed and heading. */
export function dmrLrrpEncode(lat, lon, radiusM, speedMs, headingDeg, requestId = 1) {
	const tok = [0x22, 2, requestId >> 8, requestId & 0xff, 0x51];
	putBe32(tok, Math.round((lat * 2147483648) / 90) >>> 0);
	putBe32(tok, Math.round(((lon < 0 ? lon + 360 : lon) * 4294967296) / 360) >>> 0);
	putUfloatvar(tok, radiusM);
	if (speedMs !== undefined) {
		tok.push(0x6c);
		putUfloatvar(tok, speedMs);
	}
	if (headingDeg !== undefined) tok.push(0x56, Math.round(headingDeg / 2) & 0xff);
	const doc = [];
	putUintvar(doc, 0x0d);
	putUintvar(doc, tok.length);
	return wrapIpUdp([...doc, ...tok]);
}

/** A NoFix status report (result 16). */
export function dmrLrrpEncodeNoFix(requestId = 1) {
	const tok = [0x22, 2, requestId >> 8, requestId & 0xff, 0x37, 16];
	return wrapIpUdp([0x0d, tok.length, ...tok]);
}

/** A Motorola TMS text message in IPv4/UDP port 4007 (the layout dmr_vendor.cpp ipService reads). */
export function tmsPacket(text) {
	const body = [0xa0, 0x00]; // header (a message, no ack bits), address length 0
	body.push(0x00); // the first character's high byte goes here and is reused
	for (const ch of text) {
		const u = ch.codePointAt(0);
		if (body.length > 3) body.push(u >> 8);
		body.push(u & 0xff);
	}
	const len = body.length;
	return wrapIpUdp([len >> 8, len & 0xff, ...body], 4007);
}

// ── link control and talker alias ────────────────────────────────────

/** dmr_proto.cpp talkerAliasPdus: the nine-octet LCs of a talker alias (header + blocks) in format 0..3. */
export function talkerAliasPdus(alias, format) {
	const head = new Uint8Array(9);
	const blocks = [1, 2, 3].map((b) => Uint8Array.of(4 + b, 0, 0, 0, 0, 0, 0, 0, 0));
	head[0] = 4;
	let length;
	if (format === 0) {
		// 7 bit: 49 bits in the header (the first in the last bit of octet 2), 56 in each block
		length = Math.min(alias.length, 31);
		const bits = [];
		for (const c of alias.slice(0, length)) putBits(bits, c.charCodeAt(0) & 0x7f, 7);
		while (bits.length < 217) bits.push(0);
		const byteAt = (pos) => parseInt(bits.slice(pos, pos + 8).join(''), 2);
		head[2] = (length << 1) | bits[0];
		for (let i = 0; i < 6; i++) head[3 + i] = byteAt(1 + 8 * i);
		blocks.forEach((lc, b) => {
			for (let i = 0; i < 7; i++) lc[2 + i] = byteAt(49 + 56 * b + 8 * i);
		});
	} else {
		let bytes;
		if (format === 3) bytes = [...alias].flatMap((c) => [c.codePointAt(0) >> 8, c.codePointAt(0) & 0xff]);
		else if (format === 2) bytes = [...new TextEncoder().encode(alias)];
		else bytes = [...alias].map((c) => c.charCodeAt(0) & 0xff);
		length = Math.min(format === 3 ? bytes.length / 2 : bytes.length, format === 3 ? 13 : 27);
		const data = new Uint8Array(28);
		data.set(bytes.slice(0, 27));
		head[2] = (format << 6) | (length << 1);
		head.set(data.subarray(0, 6), 3);
		blocks.forEach((lc, b) => lc.set(data.subarray(6 + 7 * b, 13 + 7 * b), 2));
	}
	return [head, ...blocks].slice(0, aliasPieces(format, length));
}

/** GPS info LC (FLCO 8): position error, 25 bit longitude, 24 bit latitude (two's complement). */
export function gpsInfoLc(lat, lon, posErr = 2) {
	const bits = [];
	putBits(bits, 8, 8); // PF 0, reserved 0, FLCO 8
	putBits(bits, 0, 8); // FID
	putBits(bits, 0, 4);
	putBits(bits, posErr, 3);
	putBits(bits, (Math.round((lon * 2 ** 25) / 360) + 2 ** 25) % 2 ** 25, 25);
	putBits(bits, (Math.round((lat * 2 ** 24) / 180) + 2 ** 24) % 2 ** 24, 24);
	return Uint8Array.from({ length: 9 }, (_, i) => parseInt(bits.slice(i * 8, i * 8 + 8).join(''), 2));
}

// ── one time slot's bursts (SlotScript) ──────────────────────────────

const csbk = (opcode, fid, data, lb = true, pf = false) => ({ lb, pf, opcode, fid, data: Uint8Array.from(data) });

export class SlotScript {
	constructor(seed = 1) {
		this.q = [];
		this.seed = seed;
		this.frame = 0;
	}
	bptc(dt, info96, act = 0) {
		this.q.push({ bits: makeDataBurst(CC, dt, bptc196Encode(info96), SYNC_BS_DATA), act });
	}
	idle(n) {
		for (let i = 0; i < n; i++) this.bptc(D.DT_IDLE, bytesToBits(IDLE_INFO));
		return this;
	}
	csbk(c, act = 3) {
		this.bptc(D.DT_CSBK, csbkInfo(c), act);
		return this;
	}
	/** pushCsbk: preamble (0x3D), unit to unit voice request (0x04), BS outbound activation (0x38). */
	standardCsbk(opcode, src, dst, extra = 0) {
		const d = new Uint8Array(8);
		if (opcode === 0x3d) [d[0], d[1]] = [0x80, extra];
		putBe24(d, 2, dst);
		putBe24(d, 5, src);
		return this.csbk(csbk(opcode, 0, d));
	}
	/** Valid AMBE+2 voice: three frames of 49 parameter bits as 216 channel bits. */
	voiceBits() {
		const vs = new Uint8Array(216);
		for (let f = 0; f < 3; f++) vs.set(ambeEncode(randomBits(this.seed * 977 + this.frame++, 49)), 72 * f);
		return vs;
	}
	/**
	 * pushVoiceCall: header, superframes (embedded LC: the call's own LC, every other superframe the next piece of the
	 * talker alias, then the GPS info LC), terminator and hang time.
	 */
	voiceCall({
		kind = 0,
		src,
		dst,
		svc = 0,
		alias = '',
		aliasFormat = 1,
		gps = null,
		superframes = 4,
		hang = 3,
		header = true,
		terminator = true,
	}) {
		const raw = packFullLc({ pf: false, flco: kind === 1 ? 3 : 0, fid: 0, svc: svc | (kind === 2 ? 0x08 : 0), dst, src });
		const act = kind === 1 ? 9 : 8;
		const pieces = alias ? talkerAliasPdus(alias, aliasFormat) : [];
		const extra = [...pieces, ...(gps ? [gpsInfoLc(gps.lat, gps.lon)] : [])];
		const n = Math.max(superframes, 2 * extra.length);
		if (header) this.bptc(D.DT_VOICE_LC_HEADER, lcBurstInfo(raw, false), act);
		const frag = embLcEncode(raw);
		const extraFrag = extra.map((lc) => embLcEncode(lc));
		for (let sf = 0; sf < n; sf++) {
			const fr = sf % 2 === 1 && sf >> 1 < extraFrag.length ? extraFrag[sf >> 1] : frag;
			for (let b = 0; b < 6; b++) {
				const vs = this.voiceBits();
				let bits;
				if (b === 0) bits = makeVoiceBurst(vs, SYNC_BS_VOICE, CC, 0, 0, []);
				else if (b < 5) bits = makeVoiceBurst(vs, -1, CC, 0, b === 1 ? 1 : b === 4 ? 2 : 3, fr[b - 1]);
				else bits = makeVoiceBurst(vs, -1, CC, 0, 0, new Uint8Array(32));
				this.q.push({ bits, act, voice: true });
			}
		}
		if (terminator) for (let h = 0; h <= hang; h++) this.bptc(D.DT_TERMINATOR_LC, lcBurstInfo(raw, true), act);
		return this;
	}
	/** txPacket / pushText: a preamble, a data header and the blocks of rate dt with the message CRC-32. */
	packet(data, { dpf, sap, dd = 0, dt = D.DT_RATE12, src, dst, group = false, preamble = true }) {
		const bs = D.dataBlockBytes(dt, false);
		const nBlocks = Math.ceil((data.length + 4) / bs);
		const area = nBlocks * bs - 4;
		const msg = [...data, ...new Array(area - data.length).fill(0)];
		const crc = crc32Msg(msg);
		msg.push(crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, (crc >>> 24) & 0xff);
		if (preamble) this.standardCsbk(0x3d, src, dst, nBlocks + 1);
		const shortData = dpf === D.DPF_SHORT_DEFINED;
		const h = {
			...D.emptyDataHeader(dpf),
			sap,
			group,
			dst,
			src,
			blocks: nBlocks,
			dd,
			fmf: shortData,
			pad: shortData ? (area - data.length) * 8 : area - data.length,
		};
		this.bptc(D.DT_DATA_HEADER, crcBlockInfo(D.packDataHeader(h), MASK_DATA_HEADER), 10);
		for (let b = 0; b < nBlocks; b++)
			this.q.push({ bits: makeDataBurst(CC, dt, D.dataBlockEncode(dt, msg.slice(b * bs, (b + 1) * bs), false, 0), SYNC_BS_DATA), act: 10 });
		return this;
	}
	/** pushText: short data defined in ISO 8859-1, UTF-8 or UTF-16LE. */
	text(text, { dd = 3, dt = D.DT_RATE12, src, dst }) {
		let data;
		if (dd === 21) data = [...text].flatMap((c) => [c.codePointAt(0) & 0xff, c.codePointAt(0) >> 8]);
		else if (dd === 18) data = [...new TextEncoder().encode(text)];
		else data = [...text].map((c) => c.codePointAt(0) & 0xff);
		return this.packet(data, { dpf: D.DPF_SHORT_DEFINED, sap: 10, dd, dt, src, dst });
	}
	/** pushMotoLrrp: the real Motorola report of OnAir #335 (radio 204 to 1), a position behind a compressed header. */
	motoLrrp() {
		const prop = [0x1f, 0x10, 0x02, 0x01, 0x11, 0x71, 0xcc, 0x0d, 0x1a, 0x22];
		const blocks = [
			0x04, 0x00, 0x00, 0x00, 0x01, 0x34, 0x1f, 0xaa, 0xc4, 0xb2, 0x02, 0x51, 0x40, 0x75, 0x48, 0xba, 0x06, 0x51, 0xd2, 0x60, 0x01, 0x5b,
			0x6c, 0x00, 0x09, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xa0, 0xb3, 0x94, 0x93,
		];
		const h = { ...D.emptyDataHeader(D.DPF_UNCONFIRMED), sap: 9, dst: 1, src: 204, blocks: 4, pad: 7 };
		this.bptc(D.DT_DATA_HEADER, crcBlockInfo(D.packDataHeader(h), MASK_DATA_HEADER), 10);
		this.bptc(D.DT_DATA_HEADER, crcBlockInfo(prop, MASK_DATA_HEADER), 10);
		for (let b = 0; b < 3; b++)
			this.q.push({
				bits: makeDataBurst(CC, D.DT_RATE12, D.dataBlockEncode(D.DT_RATE12, blocks.slice(12 * b, 12 * b + 12), false, 0), SYNC_BS_DATA),
				act: 10,
			});
		return this;
	}
	/** Status / precoded short data: a header alone. */
	status(value, src, dst) {
		const h = { ...D.emptyDataHeader(D.DPF_SHORT_RAW), sap: 10, dst, src, status: value };
		this.bptc(D.DT_DATA_HEADER, crcBlockInfo(D.packDataHeader(h), MASK_DATA_HEADER), 10);
		return this;
	}
	/** pushXptSite and the XPT call set-up in a terminator. */
	xpt() {
		this.csbk(xptSiteStatusCsbk(0, 5, [3, 0, 2, 0, 0, 3], [21, 0, 77, 0, 0, 35]));
		this.bptc(D.DT_TERMINATOR_LC, lcBurstInfo(xptCallLc(3, 5, 1, 0x0015, 0x001234), true), 8);
		return this;
	}
	/** A Tier III C_ALOHA with a system code: model (0 Tiny .. 3 Huge), network and site counted from 0, partition. */
	aloha(model, net, site, par = 3) {
		const netBits = [9, 7, 4, 2][model];
		const code = (model << 12) | (net << (12 - netBits)) | site;
		const d = new Uint8Array(8);
		d[3] = code >> 6;
		d[4] = ((code & 0x3f) << 2) | par;
		return this.csbk(csbk(0x19, 0, d), 0);
	}
	/** A Tier III channel grant (0x30 PV, 0x31 TV, ...): 12 bit channel, slot, emergency, target, source. */
	grant(opcode, channel, slot, dst, src, emergency = false) {
		const d = new Uint8Array(8);
		d[0] = channel >> 4;
		d[1] = ((channel & 15) << 4) | (slot << 3) | (emergency ? 2 : 0);
		putBe24(d, 2, dst);
		putBe24(d, 5, src);
		return this.csbk(csbk(opcode, 0, d), 2);
	}
	/** Capacity Plus channel status, one block: rest channel, bank 1 bits and the groups. */
	capPlus(rest, bank1, groups) {
		return this.csbk(csbk(0x3e, 0x10, [(3 << 6) | (rest & 15), bank1, ...groups, 0, 0, 0, 0, 0, 0].slice(0, 8)), 2);
	}
	/** The Connect Plus voice grant of DSD-FME's sample: source 113114, target 1216, LCN 2, slot 1. */
	conPlusGrant() {
		return this.csbk(csbk(0x03, 0x06, [0x01, 0xb9, 0xda, 0x00, 0x04, 0xc0, 0x28, 0x02]), 2);
	}
}

// ── the base station signal (DmrSignal) ──────────────────────────────

/**
 * The downlink symbols of a two slot base station: CACH (TACT and short LC) and the bursts of both slots, idle when a
 * slot's script has run out. lead / tail: idle slots before and after.
 */
export function baseStationSymbols(s1, s2, { lead = 40, tail = 40 } = {}) {
	const slots = Math.max(s1.q.length, s2.q.length) * 2 + lead + tail;
	const idle = makeDataBurst(CC, D.DT_IDLE, bptc196Encode(bytesToBits(IDLE_INFO)), SYNC_BS_DATA);
	const sym = new Int8Array(slots * 144);
	const act = [0, 0];
	let shortLc = [];
	for (let n = 0; n < slots; n++) {
		const k = n - lead;
		const slot = n & 1;
		const script = slot ? s2 : s1;
		const b = k >= 0 ? script.q[k >> 1] : undefined;
		act[slot] = b?.act ?? 0;
		const phase = n & 3;
		if (!phase) shortLc = shortLcEncode(n & 4 ? (1 << 24) | (act[0] << 20) | (act[1] << 16) | (addressHash(0) << 8) | addressHash(0) : 0);
		const lcss = phase === 0 ? 1 : phase === 3 ? 2 : 3;
		let payload = 0;
		for (let i = 0; i < 17; i++) payload = (payload << 1) | shortLc[phase][i];
		const cach = cachEncode(act[slot] ? 1 : 0, slot, lcss, payload);
		const bits = [...cach, ...(b?.bits ?? idle)];
		for (let i = 0; i < 144; i++) sym[n * 144 + i] = dibitToSymbol((bits[2 * i] << 1) | bits[2 * i + 1]);
	}
	return sym;
}

/** Shaper: square root raised cosine (alpha 0.2) 4FSK at 648 Hz per level step, 48 kHz, as instantaneous frequency. */
export function dmrFrequency(symbols, { devScale = 1, cfoHz = 0 } = {}) {
	const sps = 10;
	const taps = rrcTaps(241, 48000, 4800, 0.2);
	const sum = taps.reduce((a, b) => a + b, 0);
	const g = taps.map((t) => (t / sum) * sps * 648 * devScale);
	const n = symbols.length * sps;
	const freq = new Float32Array(n + g.length);
	for (let i = 0; i < symbols.length; i++) {
		const v = symbols[i];
		if (!v) continue;
		const at = i * sps;
		for (let k = 0; k < g.length; k++) freq[at + k] += v * g[k];
	}
	return freq.map((f) => f + cfoHz);
}

/** The base station signal as 48 kHz IQ through BrowSDR's test channel (noise in 12.5 kHz, channel filter). */
export function dmrSignal(s1, s2, { cnrDb = 99, seed = 3, cfoHz = 0, devScale = 1, ...opts } = {}) {
	return channel(fmIq(dmrFrequency(baseStationSymbols(s1, s2, opts), { cfoHz, devScale })), { cnrDb, seed });
}
