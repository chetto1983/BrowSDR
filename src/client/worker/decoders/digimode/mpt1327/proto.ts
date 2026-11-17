// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/mpt1327/mpt1327_proto.cpp and
// core/include/dect2/mpt1327/mpt1327_proto.h (crc15, checkBits, encode, valid, correct, field, specialIdent,
// addressText, decodeCcsc, decodeAddress and its message tables), https://github.com/adswill/OnAir; see
// third_party/onair. As credited there: written from the public MPT 1327 signalling standard (1997 issue, sections 3
// and 5). Changes: codewords are bigints, the check bits are worked out on the 48 information bits as a number; the
// decoding of an address codeword is split by category (go-to-channel, Aloha, acknowledgements, ahoys, miscellaneous,
// short data); a message is returned (undefined for a data codeword) in place of a flag and an output argument.

import type { MptAddress, MptMessage } from './types';

/** Control channel codeword synchronisation sequence SYNC, bit 1 first (section 3.2.1.1). */
export const SYNC = 0xc4d7;
/** Traffic channel sequence SYNT (section 3.2.1.2); not used by the control channel receiver. */
export const SYNT = 0x3b28;

/** Generator X15 + X14 + X13 + X11 + X4 + X2 + 1 without the X15 term (section 3.2.3). */
const POLY = 0x6815;

export function popcount(value: number): number {
	let x = value - ((value >>> 1) & 0x55555555);
	x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
	return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

/** Codeword bits 1 .. 48 as the coefficients of X62 .. X15: info * X15 divided by the generator. */
function crc15(hi32: number, lo16: number): number {
	let reg = 0;
	for (let i = 47; i >= 0; i--) {
		const bit = i >= 16 ? (hi32 >>> (i - 16)) & 1 : (lo16 >>> i) & 1;
		const fb = ((reg >> 14) & 1) ^ bit;
		reg = (reg << 1) & 0x7fff;
		if (fb) reg ^= POLY;
	}
	return reg;
}

/** Codeword bits 49 .. 64 of the information bits (bits 1 .. 32 in hi32, 33 .. 48 in lo16). */
export function checkParts(hi32: number, lo16: number): number {
	const c = crc15(hi32, lo16) ^ 1; // the final check bit of the (63,48) code is inverted
	const parity = (popcount(hi32) + popcount(lo16) + popcount(c)) & 1; // even parity over the whole codeword
	return (c << 1) | parity;
}

/** The check bits of the 48 information bits (codeword bit 1 in bit 47). */
export const checkBits = (info48: bigint): number => checkParts(Number((info48 >> 16n) & 0xffffffffn), Number(info48 & 0xffffn));

/** The 64-bit codeword of 48 information bits. */
export const encode = (info48: bigint): bigint => ((info48 & 0xffffffffffffn) << 16n) | BigInt(checkBits(info48 & 0xffffffffffffn));

/** The codeword of two 32-bit halves (hi: bits 1 .. 32). */
export const fromParts = (hi: number, lo: number): bigint => (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);

/** The check bits and the parity agree with the information bits (the codeword as two 32-bit halves). */
export const validParts = (hi: number, lo: number): boolean => checkParts(hi >>> 0, lo >>> 16) === (lo & 0xffff);

export const valid = (cw: bigint): boolean => validParts(Number(cw >> 32n), Number(cw & 0xffffffffn));

/** A word with exactly one wrong bit, repaired (Appendix 2: distance 6 corrects 1, detects 4); undefined otherwise. */
export function correct(cw: bigint): bigint | undefined {
	if (valid(cw)) return undefined;
	for (let i = 0n; i < 64n; i++) if (valid(cw ^ (1n << i))) return cw ^ (1n << i);
	return undefined;
}

/** Codeword bits first .. first + count - 1 (1-based) as a number, the first bit most significant. */
export const field = (cw: bigint, first: number, count: number): number =>
	Number((cw >> BigInt(64 - (first - 1) - count)) & ((1n << BigInt(count)) - 1n));

const SPECIAL: Record<number, string> = {
	8191: 'ALLI',
	8190: 'TSCI',
	8189: 'IPFIXI',
	8188: 'SDMI',
	8187: 'DIVERTI',
	8186: 'INCI',
	8185: 'REGI',
	8103: 'DNI',
	8102: 'PABXI',
	8101: 'PSTNGI',
	0: 'DUMMYI',
};
/** The special idents of Table 4-1; undefined for an ordinary ident. */
export const specialIdent = (ident: number): string | undefined => SPECIAL[ident];

/** "prefix/ident", "ident N" without a prefix, "-" when absent. */
export function addressText(a: MptAddress): string {
	if (a.ident < 0) return '-';
	const sp = specialIdent(a.ident);
	if (sp) return sp;
	if (a.ident >= 8121 && a.ident <= 8135) return `short-form ident ${a.ident - 8120}`;
	return a.pfix < 0 ? `ident ${a.ident}` : `${a.pfix}/${a.ident}`;
}

/** The control channel system codeword: bit 1 = 0, SYS in bits 2 .. 16, the last 16 bits SYNC; its SYS or undefined. */
export function decodeCcsc(cw: bigint): number | undefined {
	if (field(cw, 1, 1) !== 0 || Number(cw & 0xffffn) !== SYNC) return undefined;
	return field(cw, 2, 15);
}

const NONE: MptAddress = { pfix: -1, ident: -1 };
const blank = (cw: bigint): MptMessage => ({ type: '', detail: '', called: NONE, caller: NONE, channel: -1, sys: -1, cw });

const ALOHA = ['ALH', 'ALHS', 'ALHD', 'ALHE', 'ALHR', 'ALHX', 'ALHF', 'reserved'];
const ALOHA_TEXT = [
	'any single codeword message invited',
	'invited, except RQD',
	'invited, except RQS',
	'emergency requests only',
	'registration or emergency requests',
	'invited, except RQR',
	'fall-back mode',
	'reserved',
];
const ACK = ['ACK', 'ACKI', 'ACKQ', 'ACKX', 'ACKV', 'ACKE', 'ACKT', 'ACKB'];
const ACK_TEXT = [
	'acknowledgement',
	'intermediate acknowledgement',
	'call queued',
	'message rejected',
	'called unit unavailable',
	'emergency call acknowledged',
	'try on the given address',
	'call-back or negative acknowledgement',
];
const AHOY = ['AHY', 'spare', 'AHYX', 'reserved', 'reserved', 'AHYP', 'AHYQ', 'AHYC'];
const AHOY_TEXT = [
	'availability check',
	'spare (customisation)',
	'cancel alert / waiting state',
	'reserved',
	'reserved',
	'called unit presence check',
	'status message',
	'short data invitation',
];
const MISC = ['MARK', 'MAINT', 'CLEAR', 'MOVE', 'BCAST', 'reserved', 'reserved', 'reserved'];
const MISC_TEXT = [
	'control channel marker',
	'call maintenance',
	'clear down from allocated channel',
	'move to control channel',
	'system parameter broadcast',
	'reserved',
	'reserved',
	'reserved',
];
const MAINT_OPER = [
	'pressel on',
	'pressel off',
	'periodic message',
	'disconnect',
	'customised',
	'reserved',
	'clear down units not labelled by this address',
	'disable user transmission',
];

/** Go to channel (section 5.4): bit 22 is 0. */
function goToChannel(cw: bigint, m: MptMessage): MptMessage {
	m.type = 'GTC';
	m.channel = field(cw, 24, 10);
	m.caller = { pfix: -1, ident: field(cw, 34, 13) };
	m.detail = `go to channel ${m.channel}, ${field(cw, 23, 1) ? 'data (audio muted)' : 'speech'}`;
	return m;
}

/** Aloha (5.5.1): CHAN4 31-34, WT 35-37, RSVD 38-39, (M) 40-44, (N) 45-48. */
function aloha(cw: bigint, func: number, m: MptMessage): MptMessage {
	m.type = ALOHA[func];
	m.detail = `${ALOHA_TEXT[func]}, control channel (low 4 bits) ${field(cw, 31, 4)}, wait ${field(cw, 35, 3)}, address bits ${field(cw, 40, 5)}, aloha number ${field(cw, 45, 4)}`;
	return m;
}

/** Acknowledgements (5.5.2): IDENT2 31-43, QUAL 44, (N) 45-48. */
function acknowledge(cw: bigint, func: number, m: MptMessage): MptMessage {
	m.type = ACK[func];
	m.caller = { pfix: -1, ident: field(cw, 31, 13) };
	m.detail = `${ACK_TEXT[func]}, qualifier ${field(cw, 44, 1)}`;
	return m;
}

/** Ahoys (5.5.3.2): IDENT2 31-43, then the function's parameters. */
function ahoy(cw: bigint, func: number, m: MptMessage): MptMessage {
	m.type = AHOY[func];
	m.caller = { pfix: -1, ident: field(cw, 31, 13) };
	m.detail = AHOY_TEXT[func];
	if (func === 0) {
		// AHY: D 44, POINT 45, CHECK 46, E 47, AD 48
		m.detail =
			`availability check of the ${field(cw, 45, 1) ? 'calling' : 'called'} unit, ${field(cw, 44, 1) ? 'data' : 'speech'}` +
			`${field(cw, 46, 1) ? ', readiness checked' : ''}${field(cw, 47, 1) ? ', emergency' : ''}${field(cw, 48, 1) ? ', data codeword follows' : ''}`;
	} else if (func === 6)
		m.detail = `status message ${field(cw, 44, 5)}`; // AHYQ: STATUS 44-48
	else if (func === 7) m.detail = `short data invitation, descriptor ${field(cw, 46, 3)}, ${field(cw, 44, 2)} slots`; // AHYC
	return m;
}

/** BCAST (5.5.4.5): SYSDEF in bits 2 .. 6, SYS in bits 7 .. 21, the parameters from bit 31. */
function broadcast(cw: bigint, m: MptMessage): MptMessage {
	const sysdef = field(cw, 2, 5);
	m.sys = field(cw, 7, 15);
	if (sysdef === 0 || sysdef === 1 || sysdef === 4 || sysdef === 5) {
		m.channel = field(cw, 31, 10);
		const what = ['control channel announced', 'control channel withdrawn', '', '', 'adjacent site control channel', 'vote now advice'][
			sysdef
		];
		const adj = sysdef >= 4 ? field(cw, 45, 4) : 0;
		m.detail = `${what}, system ${m.sys}, control channel ${m.channel}${adj ? `, site ${adj}` : ''}`;
	} else if (sysdef === 2) {
		// PER 31, IVAL 32-36, PON 37, ID 38
		const per = field(cw, 31, 1) === 0;
		m.detail =
			`call maintenance parameters, system ${m.sys}: ${per ? `periodic messages every ${field(cw, 32, 5)} s` : 'no periodic messages'}, ` +
			`pressel on ${field(cw, 37, 1) ? 'not sent' : 'sent'}, MAINT address ${field(cw, 38, 1) ? 'individual' : 'group'}`;
	} else if (sysdef === 3) m.detail = `registration parameters, system ${m.sys}`;
	else m.detail = `broadcast type ${sysdef}, system ${m.sys} (reserved or spare)`;
	return m;
}

/** Miscellaneous (5.5.4): MARK, MAINT, CLEAR, MOVE, BCAST. */
function miscellaneous(cw: bigint, func: number, called: MptAddress, m: MptMessage): MptMessage {
	m.type = MISC[func];
	m.detail = MISC_TEXT[func];
	if (func === 0) {
		// MARK: CHAN4 (bits 2-5), A, SYS (7-21)
		m.sys = field(cw, 7, 15);
		m.detail = `${MISC_TEXT[0]}, system ${m.sys}, control channel (low 4 bits) ${field(cw, 2, 4)}`;
	} else if (func === 1) {
		// MAINT: PFIX/IDENT1, CHAN (31-40), OPER (41-43)
		m.called = called;
		m.channel = field(cw, 31, 10);
		m.detail = `call maintenance on channel ${m.channel}: ${MAINT_OPER[field(cw, 41, 3)]}`;
	} else if (func === 2) {
		// CLEAR: CHAN (2-11), CONT (12-21)
		m.channel = field(cw, 2, 10);
		const cont = field(cw, 12, 10);
		m.detail = `clear down from channel ${m.channel}${cont ? `, move to control channel ${cont}` : ''}`;
	} else if (func === 3) {
		// MOVE: PFIX/IDENT1, CONT (31-40), (M) (41-45)
		m.called = called;
		m.channel = field(cw, 31, 10);
		m.detail = `move to control channel ${m.channel} (address qualifier ${field(cw, 41, 5)})`;
	} else if (func === 4) return broadcast(cw, m);
	else m.called = called; // reserved functions: shown as sent
	return m;
}

/** Category 0: Aloha, acknowledgements, ahoys, miscellaneous. */
function categoryZero(cw: bigint, called: MptAddress, m: MptMessage): MptMessage {
	const type = field(cw, 26, 2);
	const func = field(cw, 28, 3);
	if (type === 3) return miscellaneous(cw, func, called, m);
	m.called = called;
	if (type === 0) return aloha(cw, func, m);
	if (type === 1) return acknowledge(cw, func, m);
	return ahoy(cw, func, m);
}

/** Categories 1 - 7: short data and the standard data messages. */
function categoryOther(cw: bigint, cat: number, m: MptMessage): MptMessage {
	if (cat === 1 && field(cw, 26, 1)) {
		// HEAD (5.6.2): LEN 27-28, PFIX2 29-35, IDENT2 36-48
		m.type = 'HEAD';
		m.caller = { pfix: field(cw, 29, 7), ident: field(cw, 36, 13) };
		const len = field(cw, 27, 2);
		m.detail = `short data message header, ${len + 1} data codeword${len ? 's' : ''} follow`;
	} else if (cat === 1) [m.type, m.detail] = ['SAM', 'single address message'];
	else if (cat === 2) [m.type, m.detail] = ['STDDATA', 'standard data call set-up'];
	else if (cat === 5) [m.type, m.detail] = ['STDACK', 'standard data acknowledgement or selective acknowledgement'];
	else [m.type, m.detail] = ['RSVD', `category ${cat} (reserved or spare)`];
	return m;
}

/** The fields of an address codeword; undefined when bit 1 is 0 (a data codeword). The check bits are not tested. */
export function decodeAddress(cw: bigint): MptMessage | undefined {
	if (field(cw, 1, 1) !== 1) return undefined;
	const m = blank(cw);
	const called = { pfix: field(cw, 2, 7), ident: field(cw, 9, 13) };
	if (field(cw, 22, 1) === 0) {
		m.called = called;
		return goToChannel(cw, m);
	}
	const cat = field(cw, 23, 3);
	if (cat === 0) return categoryZero(cw, called, m);
	m.called = called;
	return categoryOther(cw, cat, m);
}
