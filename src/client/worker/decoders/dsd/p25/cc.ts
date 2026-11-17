// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/p25/p25_cc.cpp (denyReasonText, queueReasonText, serviceText,
// tsbkDescribe, crc32Pdu, payloadCheck, mbtToTsbks, pduAssemble) and core/include/dect2/p25/p25_cc.h,
// https://github.com/adswill/OnAir; see third_party/onair.
// OnAir credits the layouts to OP25 (boatbod fork: tk_p25.py and p25p1_fdma.cc, Max H. Parke KA1RBI, Graham J. Norbury
// and contributors, GPL-3.0: patch, affiliation, deny, MBT and PDU layouts read, no code used) and the deny / queue reason
// codes and PDU header fields to SDRTrunk (Dennis Sheirer, GPL-3.0); BrowSDR keeps those credits.
// Changes: TSBK arguments are a bigint; the event texts are built with template strings.
//
// P25 Phase 1 control messages beyond the voice grants: Motorola and Harris patches, affiliation and registration,
// deny / queue / acknowledge responses, data channel grants, unit status, time, system services, and the multi-block
// (MBT) forms of the status broadcasts and grants; unconfirmed data packets.
import type { P25CcItem, P25PduData, P25Tsbk } from './types';

const DENY: Record<number, string> = {
	0x10: 'requesting unit not valid',
	0x11: 'requesting unit not authorised for this service',
	0x20: 'target unit not valid',
	0x21: 'target unit not authorised for this service',
	0x2f: 'target unit refused the call',
	0x30: 'target group not valid',
	0x31: 'target group not authorised for this service',
	0x40: 'invalid dialing',
	0x41: 'telephone number not authorised',
	0x42: 'PSTN not valid',
	0x50: 'call timeout',
	0x51: 'landline terminated the call',
	0x52: 'subscriber unit terminated the call',
	0x5f: 'call preempted',
	0x60: 'site access denial',
	0x67: 'PTT collide',
	0x77: 'PTT bonk',
	0xf0: 'call options not valid for service',
	0xf1: 'protection option not valid',
	0xf2: 'duplex option not valid',
	0xf3: 'circuit or packet mode not valid',
	0xff: 'system does not support this service',
};
export const denyReasonText = (r: number): string => DENY[r] ?? (r >= 0x61 && r <= 0xef ? 'user or system defined' : 'reserved');

const QUEUE: Record<number, string> = {
	0x10: 'requesting unit active in another service',
	0x20: 'target unit active in another service',
	0x2f: 'target unit queued this call',
	0x30: 'target group active in another service',
	0x40: 'channel resources not available',
	0x41: 'telephone resources not available',
	0x42: 'data resources not available',
	0x43: 'superframe resources not available',
	0x50: 'service in use',
};
export const queueReasonText = (r: number): string => QUEUE[r] ?? (r >= 0x61 ? 'user or system defined' : 'reserved');

const SERVICE: Record<number, string> = {
	0x00: 'group voice',
	0x04: 'unit to unit voice',
	0x05: 'unit to unit answer',
	0x08: 'telephone',
	0x14: 'data channel',
	0x15: 'data page',
	0x18: 'status update',
	0x1a: 'status query',
	0x1c: 'message update',
	0x1f: 'call alert',
	0x20: 'extended function',
	0x28: 'group affiliation',
	0x2c: 'registration',
};
export const serviceText = (s: number): string => SERVICE[s & 0x3f] ?? 'service';

/** Bits low .. low + width - 1 of a 64-bit argument word. */
const f = (a: bigint, low: number, width: number): number => Number((a >> BigInt(low)) & ((1n << BigInt(width)) - 1n));

function item(kind: P25CcItem['kind'], text: string, extra: Partial<P25CcItem> = {}): P25CcItem {
	return { kind, supergroup: -1, members: [], unit: -1, tg: -1, channel: -1, accepted: false, reason: -1, text, ...extra };
}

/** Motorola (0x90) patch messages. */
function motorola(op: number, a: bigint): P25CcItem | null {
	const [f0, f1, f2, f3] = [f(a, 48, 16), f(a, 32, 16), f(a, 16, 16), f(a, 0, 16)];
	if (op === 0x00 || op === 0x01) {
		const members = [f1, f2, f3].filter((g) => g && g !== f0);
		const what = op === 0 ? 'adds' : 'drops';
		return item(op === 0 ? 'patch-add' : 'patch-del', `patch: supergroup ${f0} ${what} talkgroups ${f1} ${f2} ${f3}`, {
			supergroup: f0,
			members,
		});
	}
	if (op === 0x02) {
		const x = { channel: f(a, 40, 16), supergroup: f(a, 24, 16), unit: f(a, 0, 24) };
		return item('patch-grant', `patch call: supergroup ${x.supergroup} from ${x.unit} on channel ${x.channel}`, x);
	}
	if (op === 0x03)
		return item('patch-grant', `patch call update: supergroup ${f1} on channel ${f0}, supergroup ${f3} on channel ${f2}`, {
			channel: f0,
			supergroup: f1,
		});
	return null;
}

/** Harris (0xA4) regroup. */
function harris(a: bigint): P25CcItem | null {
	if (!f(a, 62, 1)) return null;
	const act = f(a, 61, 1);
	const supergroup = f(a, 40, 16);
	const ga = f(a, 0, 16);
	const members = ga && ga !== supergroup ? [ga] : [];
	return item(act ? 'patch-add' : 'patch-del', `patch: supergroup ${supergroup} ${act ? 'adds' : 'drops'} talkgroup ${ga} (Harris)`, {
		supergroup,
		members,
	});
}

function responses(op: number, a: bigint): P25CcItem | null {
	const unit = f(a, 0, 24);
	if (op === 0x20) return item('ack', `acknowledged: ${serviceText(f(a, 56, 6))} for unit ${unit}`, { unit });
	if (op === 0x21) {
		const reason = f(a, 48, 8);
		return item('queue', `queued: ${serviceText(f(a, 56, 6))} for unit ${unit}: ${queueReasonText(reason)}`, { unit, reason });
	}
	if (op === 0x27) {
		const reason = f(a, 48, 8);
		const service = f(a, 56, 6) | (f(a, 62, 2) << 4);
		return item('deny', `denied: ${serviceText(service)} for unit ${unit}: ${denyReasonText(reason)}`, { unit, reason });
	}
	return null;
}

function registrations(op: number, a: bigint): P25CcItem | null {
	if (op === 0x28) {
		const gav = f(a, 56, 2);
		const x = { accepted: gav === 0, tg: f(a, 24, 16), unit: f(a, 0, 24) };
		const what = [
			`affiliated to talkgroup ${x.tg}`,
			`refused talkgroup ${x.tg}`,
			`denied talkgroup ${x.tg}`,
			`affiliation to talkgroup ${x.tg} failed`,
		][gav];
		return item('affiliation', `unit ${x.unit} ${what}`, x);
	}
	if (op === 0x2a) return item('other', `group affiliation query to unit ${f(a, 0, 24)}`, { unit: f(a, 0, 24) });
	if (op === 0x2b) {
		const x = { accepted: f(a, 56, 2) === 0, tg: f(a, 40, 16), unit: f(a, 0, 24) };
		return item('registration', `unit ${x.unit} location ${x.accepted ? 'registered' : 'registration failed'}, talkgroup ${x.tg}`, x);
	}
	if (op === 0x2c) {
		const x = { accepted: f(a, 60, 2) === 0, unit: f(a, 24, 24) };
		return item('registration', `unit ${x.unit} ${x.accepted ? 'registered' : 'registration refused'}`, x);
	}
	if (op === 0x2d) return item('other', `registration command to unit ${f(a, 0, 24)}`, { unit: f(a, 0, 24) });
	if (op === 0x2f) return item('deregistration', `unit ${f(a, 0, 24)} deregistered`, { unit: f(a, 0, 24) });
	return null;
}

function services(op: number, a: bigint): P25CcItem | null {
	if (op === 0x14)
		return item('data-grant', `data channel grant to unit ${f(a, 0, 24)} on channel ${f(a, 40, 16)}`, {
			unit: f(a, 0, 24),
			channel: f(a, 40, 16),
		});
	if (op === 0x16) return item('data-grant', `SNDCP data channel ${f(a, 32, 16)} announced`, { channel: f(a, 32, 16) });
	if (op === 0x18) {
		const x = { unit: f(a, 0, 24), tg: f(a, 24, 24), reason: f(a, 48, 16) };
		return item('status', `status 0x${x.reason.toString(16).toUpperCase().padStart(4, '0')} from unit ${x.unit} to unit ${x.tg}`, x);
	}
	if (op === 0x35) {
		if (!f(a, 61, 1)) return item('other', 'time and date announcement');
		const raw = f(a, 48, 12);
		const mins = (raw & 0x7ff) * ((raw >> 11) & 1 ? -1 : 1);
		return item('other', `time announcement, local offset ${mins >= 0 ? '+' : ''}${mins} min`);
	}
	if (op === 0x38) {
		const hex = (v: number) => v.toString(16).toUpperCase().padStart(6, '0');
		return item('other', `system services: available 0x${hex(f(a, 32, 24))}, supported 0x${hex(f(a, 8, 24))}`);
	}
	return null;
}

/** One TSBK that is not a voice grant, an identifier update or a status broadcast; null when it holds none of these. */
export function tsbkDescribe(mfid: number, op: number, a: bigint): P25CcItem | null {
	if (mfid === 0x90) return motorola(op, a);
	if (mfid === 0xa4) return op === 0x30 ? harris(a) : null;
	if (mfid !== 0 && mfid !== 1) return null;
	return responses(op, a) ?? registrations(op, a) ?? services(op, a);
}

/** CRC-32 of PDU payloads (reflected 0xEDB88320). */
export function crc32Pdu(p: ArrayLike<number>, n: number): number {
	let crc = 0xffffffff;
	for (let i = 0; i < n; i++) {
		crc ^= p[i];
		for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
	}
	return ~crc >>> 0;
}

/** The payload after the header block (12-byte blocks), its CRC-32 (the last four bytes) checked; null when wrong. */
function payloadCheck(blocks: Uint8Array[]): Uint8Array | null {
	if (blocks.length < 2 || blocks[0].length !== 12) return null;
	const blks = blocks[0][6] & 0x7f;
	if (blks < 1 || blocks.length < blks + 1 || blocks.slice(1, blks + 1).some((b) => b.length !== 12)) return null;
	const d = new Uint8Array(12 * blks);
	for (let k = 1; k <= blks; k++) d.set(blocks[k], 12 * (k - 1));
	const n = d.length;
	const have = ((d[n - 4] << 24) | (d[n - 3] << 16) | (d[n - 2] << 8) | d[n - 1]) >>> 0;
	return have === crc32Pdu(d, n - 4) ? d : null;
}

/** Bits low .. low + width - 1 of the big-endian number d (LSB = 0), as OP25 counts with mbt_data << 32. */
function mbtBits(d: Uint8Array, low: number, width: number): bigint {
	let v = 0n;
	for (let i = low + width - 1; i >= low; i--) {
		const byte = d.length - 1 - Math.floor(i / 8);
		if (byte < 0) return 0n;
		v = (v << 1n) | BigInt((d[byte] >> (i % 8)) & 1);
	}
	return v;
}

function mbtArgs(op: number, h: Uint8Array, b: (low: number, width: number) => bigint, n: number): P25Tsbk | null {
	const src = BigInt((h[3] << 16) | (h[4] << 8) | h[5]);
	const sys = BigInt(((h[4] << 8) | h[5]) & 0xfff);
	const t = (opcode: number, args: bigint, mfid = 0): P25Tsbk => ({ last: true, prot: false, opcode, mfid, args });
	if (op === 0x00 && n >= 12) return t(0x00, (b(64, 16) << 40n) | (b(32, 16) << 24n) | src);
	if (op === 0x02 && n >= 24 && b(168, 8) === 0x90n) return t(0x02, (b(80, 16) << 40n) | (b(48, 16) << 24n) | src, 0x90);
	if (op === 0x28 && n >= 24) return t(0x28, (b(127, 1) << 63n) | (b(120, 2) << 56n) | (b(144, 16) << 40n) | (b(128, 16) << 24n) | src);
	if (op === 0x2c && n >= 12) return t(0x2c, (b(48, 2) << 60n) | (b(80, 12) << 48n) | (b(56, 24) << 24n) | src);
	if (op === 0x3a) return t(0x3a, (sys << 40n) | (b(88, 8) << 32n) | (b(80, 8) << 24n) | (b(64, 16) << 8n));
	if (op === 0x3b) return t(0x3b, (b(76, 20) << 36n) | (sys << 24n) | (b(56, 16) << 8n));
	if (op === 0x3c) return t(0x3c, (sys << 40n) | (BigInt(h[8]) << 32n) | (BigInt(h[9]) << 24n) | (b(80, 16) << 8n));
	return null;
}

/**
 * Multi-block trunking (SAP 61, format 0x15 or 0x17) checked with its CRC-32 and turned into the equivalent TSBK where a
 * short form exists; null when the CRC or the layout is wrong.
 */
export function mbtToTsbks(blocks: Uint8Array[]): P25Tsbk[] | null {
	if (!blocks.length || blocks[0].length !== 12) return null;
	const h = blocks[0];
	const fmt = h[0] & 0x1f;
	if ((h[1] & 0x3f) !== 61 || (fmt !== 0x15 && fmt !== 0x17)) return null;
	const d = payloadCheck(blocks);
	if (!d) return null;
	d.fill(0, d.length - 4); // the CRC replaced by four zero bytes
	const t = mbtArgs(h[7] & 0x3f, h, (low, width) => mbtBits(d, low, width), d.length);
	return t ? [t] : null;
}

function pduSummary(sap: number, p: Uint8Array): string {
	if ((sap === 4 || sap === 0) && p.length >= 20 && p[0] >> 4 === 4) {
		const ihl = (p[0] & 15) * 4;
		let s = `IPv4 ${p.slice(12, 16).join('.')} to ${p.slice(16, 20).join('.')}, protocol ${p[9]}, ${p.length} bytes`;
		if ((p[9] === 17 || p[9] === 6) && p.length >= ihl + 4)
			s += `, ports ${(p[ihl] << 8) | p[ihl + 1]} to ${(p[ihl + 2] << 8) | p[ihl + 3]}`;
		return s;
	}
	const asc = String.fromCharCode(...Array.from(p).filter((c) => c >= 32 && c < 127));
	return `SAP ${sap}, ${p.length} bytes${asc.length >= 4 && asc.length * 2 >= p.length ? ': ' + asc.slice(0, 80) : ''}`;
}

/** An unconfirmed data PDU in 12-byte blocks: payload (padding and CRC-32 removed, the CRC checked) and a summary. */
export function pduAssemble(blocks: Uint8Array[]): P25PduData | null {
	if (!blocks.length || blocks[0].length !== 12) return null;
	const h = blocks[0];
	if ((h[0] & 0x1f) !== 0x15) return null; // unconfirmed delivery only
	const d = payloadCheck(blocks);
	if (!d) return null;
	const pad = h[7] & 0x1f;
	const off = h[9] & 0x3f;
	const len = d.length - 4 - pad;
	if (len < 0 || off > len) return null;
	const payload = d.slice(off, len);
	const sap = h[1] & 0x3f;
	return { payload, sap, llid: (h[3] << 16) | (h[4] << 8) | h[5], outbound: !!((h[0] >> 5) & 1), summary: pduSummary(sap, payload) };
}
