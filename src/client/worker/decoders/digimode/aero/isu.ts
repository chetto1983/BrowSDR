// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/aero/aero_su.cpp (AeroSuDecoder: ISU / SSU assembly, ACARS
// reassembly, log-ons) and core/src/aero/aero_acars.cpp (aeroParseAcarsBlock, aeroAcarsLabelText),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: the fields of an ACARS block are read by BrowSDR's
// ACARS parser (the one of the VDL2 mode: block check, registration, label, block id, downlink message number and flight
// in every downlink block, sublabel and MFI, the reading of fixed-format text); this file checks the Aero framing and the
// parity. Control characters in the text show as '.' (OnAir: '?', DEL as "<DEL>").
//
// Facts from JAERO (Jonti Olds, MIT, aerol.cpp): ISU / SSU numbering (ISUData::update), the ACARS user data layout of an
// ISU (ParserISU::parse): FF FF | SOH | mode | registration (7) | TAK | label (2) | block id | STX text... | ETX or ETB |
// BCS lo, hi | DEL, every byte from the mode to the ETX / ETB with odd parity; the BCS is CRC-16/KERMIT.

import { acarsCrc, acarsLabelText, acarsParseBlock } from '@/worker/decoders/digimode/vdl2/acars';
import { SU_LOGOFF_REQUEST, SU_LOGON_CONFIRM, SU_USER_ISU } from './su';
import type { AeroAcars, AeroAcarsBlock, AeroFragment, AeroIsu, AeroLogon, AeroSu } from './types';

const SOH = 0x01;
const STX = 0x02;
const ETX = 0x03;
const ETB = 0x17;
const MAX_ISUS = 16;
const MAX_FRAGMENTS = 16;
/** Seconds an ISU waits for its SSUs, and a message for its next block. */
const ISU_WAIT = 60;
const FRAGMENT_WAIT = 120;

const oddParity = (c: number): boolean => {
	let x = c ^ (c >> 4);
	x ^= x >> 2;
	x ^= x >> 1;
	return (x & 1) !== 0;
};

/** Labels the VDL2 table does not name: ARINC 620 / 622 usage as seen in JAERO and airframes.io output (OnAir's list). */
const AERO_LABELS: Record<string, string> = {
	_d: 'General response',
	':;': 'Data transceiver auto tune',
	H1: 'Message to/from terminal',
	'5Z': 'Airline designated message',
	A6: 'ADS-C uplink',
	B6: 'ADS-C downlink',
};
export const aeroAcarsLabelText = (label: string): string => acarsLabelText(label) || AERO_LABELS[label] || '';

/** The user data of one ISU as an ACARS block; undefined when it does not have the block's shape. */
export function aeroParseAcarsBlock(u: Uint8Array): AeroAcarsBlock | undefined {
	const n = u.length;
	if (n < 19 || u[0] !== 0xff || u[1] !== 0xff || u[2] !== SOH) return undefined;
	const at15 = u[15];
	if (at15 !== STX && at15 !== 0x83 && at15 !== 0x97) return undefined;
	const end = u[n - 4] & 0x7f;
	if ((end !== ETX && end !== ETB) || (at15 !== STX && n !== 19)) return undefined; // no text: ETX right after the block id
	const body = u.subarray(3, n - 3); // mode .. ETX / ETB
	const a = acarsParseBlock(
		body.map((c) => c & 0x7f),
		acarsCrc(body) === (u[n - 3] | (u[n - 2] << 8)),
	);
	if (!a) return undefined;
	return {
		mode: a.mode,
		registration: a.reg.trimEnd(),
		tak: u[11] & 0x7f,
		label: a.label,
		blockId: u[14] & 0x7f,
		text: a.text,
		hasText: at15 === STX,
		moreToCome: end === ETB,
		parityOk: body.every(oddParity),
		crcOk: a.crcOk,
		msgNo: a.msgNum + a.msgSeq,
		flight: a.flight.trim(),
		sublabel: a.sublabel,
		mfi: a.mfi,
		decoded: a.decoded,
	};
}

export function nextBlockId(bi: number): number {
	if (bi >= 0x30 && bi <= 0x39) return 0x30 + ((bi - 0x30 + 1) % 10);
	if (bi >= 0x41 && bi <= 0x5a) return 0x41 + ((bi - 0x41 + 1) % 26);
	return bi + 1;
}

const toHex = (data: number[]): string => data.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');

function acarsOf(isu: AeroIsu, blk: AeroAcarsBlock): AeroAcars {
	return {
		aesId: isu.aes,
		gesId: isu.ges,
		uplink: !(blk.blockId >= 0x30 && blk.blockId <= 0x39),
		mode: blk.mode,
		registration: blk.registration,
		label: blk.label,
		labelText: aeroAcarsLabelText(blk.label),
		blockId: String.fromCharCode(blk.blockId),
		msgNo: blk.msgNo,
		flight: blk.flight,
		text: blk.text,
		crcOk: blk.crcOk && blk.parityOk,
		decoded: blk.decoded,
		sublabel: blk.sublabel,
		mfi: blk.mfi,
		binary: false,
	};
}

/** User data that is not an ACARS block, as hex; the SU checks held, there is no block check to test. */
function binaryOf(isu: AeroIsu): AeroAcars {
	return {
		aesId: isu.aes,
		gesId: isu.ges,
		uplink: true,
		mode: '',
		registration: '',
		label: '',
		labelText: 'Non-ACARS user data',
		blockId: '',
		msgNo: '',
		flight: '',
		text: toHex(isu.data),
		crcOk: true,
		decoded: '',
		sublabel: '',
		mfi: '',
		binary: true,
	};
}

/** Reassembles ACARS messages from the user data SUs (they span several SUs and blocks); hands on log-ons. */
export class AeroSuDecoder {
	private isus: AeroIsu[] = [];
	private frags: AeroFragment[] = [];

	reset(): void {
		this.isus = [];
		this.frags = [];
	}

	/** One SU heard at stream time `t` (s); what it completed. */
	feed(su: AeroSu, t: number): { acars: AeroAcars[]; logons: AeroLogon[] } {
		const out = { acars: [] as AeroAcars[], logons: [] as AeroLogon[] };
		if (!su.crcOk) return out;
		this.isus = this.isus.filter((i) => t - i.t <= ISU_WAIT); // forget what has waited too long
		this.frags = this.frags.filter((f) => t - f.t <= FRAGMENT_WAIT);
		const type = su.bytes[0];
		if (type === SU_LOGON_CONFIRM || type === SU_LOGOFF_REQUEST) {
			out.logons.push({ aesId: su.aesId, gesId: su.gesId, logon: type === SU_LOGON_CONFIRM });
			return out;
		}
		if (type === SU_USER_ISU) this.startIsu(su, t);
		else if ((type & 0xc0) === 0xc0) {
			const done = this.ssu(su, t);
			const m = done && this.message(done, t);
			if (m) out.acars.push(m);
		}
		return out;
	}

	private startIsu(su: AeroSu, t: number): void {
		const b = su.bytes;
		const i: AeroIsu = {
			aes: su.aesId,
			ges: su.gesId,
			qno: (b[5] >> 4) & 0x0f,
			refno: b[5] & 0x0f,
			remaining: b[6] & 0x3f,
			lastOctets: (b[7] >> 4) & 0x0f,
			data: [b[8], b[9]],
			t,
		};
		if (i.lastOctets > 8 || i.remaining === 0) return;
		const same = this.isus.findIndex((x) => x.aes === i.aes && x.ges === i.ges && x.qno === i.qno && x.refno === i.refno);
		if (same >= 0) this.isus.splice(same, 1);
		if (this.isus.length >= MAX_ISUS) this.isus.shift();
		this.isus.push(i);
	}

	/** An SSU: added to the most recent ISU that expects exactly it; the ISU when it is complete. */
	private ssu(su: AeroSu, t: number): AeroIsu | undefined {
		const seq = su.bytes[0] & 0x3f;
		const qno = (su.bytes[1] >> 4) & 0x0f,
			ref = su.bytes[1] & 0x0f;
		for (let k = this.isus.length - 1; k >= 0; k--) {
			const i = this.isus[k];
			if (i.qno !== qno || i.refno !== ref || i.remaining !== seq + 1) continue;
			i.remaining--;
			i.t = t;
			if (i.remaining) {
				i.data.push(...su.bytes.subarray(2, 10));
				return undefined;
			}
			i.data.push(...su.bytes.subarray(2, 2 + i.lastOctets));
			this.isus.splice(k, 1);
			return i;
		}
		return undefined;
	}

	/** A complete ISU: an ACARS message (or its first blocks, kept until the last), or user data shown as hex. */
	private message(isu: AeroIsu, t: number): AeroAcars | undefined {
		const blk = aeroParseAcarsBlock(Uint8Array.from(isu.data));
		if (!blk) return binaryOf(isu);
		const m = acarsOf(isu, blk);
		// continuation of a message that ended its last block with ETB
		const k = this.frags.findIndex(
			(f) =>
				f.msg.aesId === m.aesId &&
				f.msg.gesId === m.gesId &&
				f.msg.label === m.label &&
				f.msg.mode === m.mode &&
				f.tak === blk.tak &&
				f.msg.registration === m.registration &&
				nextBlockId(f.lastBi) === blk.blockId,
		);
		if (k >= 0) {
			const f = this.frags[k];
			f.msg.text += blk.text;
			f.msg.crcOk = f.msg.crcOk && m.crcOk;
			f.lastBi = blk.blockId;
			f.t = t;
			if (blk.moreToCome) return undefined;
			this.frags.splice(k, 1);
			return { ...f.msg, blockId: m.blockId };
		}
		if (!blk.moreToCome) return m;
		if (this.frags.length >= MAX_FRAGMENTS) this.frags.shift();
		this.frags.push({ msg: m, tak: blk.tak, lastBi: blk.blockId, t });
		return undefined;
	}
}
