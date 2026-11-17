// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// P25 Phase 2 burst primitives ported from OnAir core/src/p25p2/p25p2_proto.cpp.
// Ported to TypeScript for BrowSDR from OnAir core/src/p25p2/p25p2_proto.cpp (the rest of the protocol layer: ISCH and DUID
// encoders, ambePut, ambeFlatten, ambeUnflatten, hexbits, essEncode, essDecode, payloadPut, payloadGet, macEncodeAir,
// macDecodeAir, macMsgLenAt) and core/include/dect2/p25p2/p25p2_proto.h (burst layout, DUIDs, MAC opcodes and field
// offsets, rrcImpulse), https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the receiver's additions build on the burst primitives above them (ischValue, ischDecode, p25p2Duid,
// p25p2Scramble, p25p2Descramble, p25p2AmbeFrame); p25p2AmbeFrame and ambePut share one table of bit places; AMBE+2 frames
// are mbelib's ambe_fr[4][24] as one 96-byte array; OnAir's earlier private MAC layout (macEncode / macDecode, RS(46,26)
// and RS(52,30) with CRC-CCITT) is left out: it never occurs on the air.
//
// APCO P25 Phase 2 (TDMA, TIA-102.BBAB physical layer / BBAC MAC), as OnAir reads it: 6000 symbols/s differential QPSK
// (+-pi/4, +-3pi/4) through a 0.35 root raised cosine, 180-dibit bursts of 30 ms, 12 to a 360 ms superframe, each starting
// with a 40-bit ISCH (the sync word 0x575D57F7FF or a (40,9) I-ISCH code word). The DUID is an (8,4) code spread over
// dibits 20, 57, 142 and 179. The bursts are scrambled with a 44-bit LFSR seeded from the WACN, system ID and NAC.
import { AMBE_C0, AMBE_C1, AMBE_C2, AMBE_C3, AMBE_ROW, DUID_LOOKUP, ISCH_WORDS, MAC_MSG_LENGTHS } from './data';
import { crc12, rs63Decode, rsDecode, rsEncode } from './rs';
import type { P25p2MacPdu } from './types';

export const P25P2_SYNC = 0x575d57f7ffn;
export const P25P2_BURST_DIBITS = 180;
export const P25P2_VOICE_OFFSETS = [2, 76, 172, 246] as const;
export const DUID_POSITIONS = [20, 57, 142, 179] as const;
const MASK_44 = (1n << 44n) - 1n;

function bitErrors(value: bigint): number {
	let count = 0;
	while (value) {
		value &= value - 1n;
		count++;
	}
	return count;
}

export function ischValue(dibits: ArrayLike<number>): bigint {
	if (dibits.length < 20) throw new Error('P25 Phase 2 ISCH requires 20 dibits');
	let value = 0n;
	for (let index = 0; index < 20; index++) value = (value << 2n) | BigInt(dibits[index] & 3);
	return value;
}

export function ischSyncDistance(dibits: ArrayLike<number>): number {
	return bitErrors(ischValue(dibits) ^ P25P2_SYNC);
}

export function ischDecode(
	dibits: ArrayLike<number>,
): { channel: number; location: number; first: number; ultraframe: number; errors: number } | null {
	const value = ischValue(dibits);
	let best = -1;
	let errors = 41;
	for (let index = 0; index < ISCH_WORDS.length; index++) {
		const distance = bitErrors(value ^ ISCH_WORDS[index]);
		if (distance < errors) {
			errors = distance;
			best = index;
		}
	}
	if (errors > 7) return null;
	return { channel: (best >> 5) & 3, location: (best >> 3) & 3, first: (best >> 2) & 1, ultraframe: best & 3, errors };
}

export function p25p2Duid(burst: ArrayLike<number>): number {
	if (burst.length < P25P2_BURST_DIBITS) throw new Error('P25 Phase 2 burst requires 180 dibits');
	let word = 0;
	for (const position of DUID_POSITIONS) word = (word << 2) | (burst[position] & 3);
	return DUID_LOOKUP[word];
}

/** One superframe of 12 180-dibit bursts, with ten leading zero dibits. */
export function p25p2Scramble(wacn: number, system: number, nac: number): Uint8Array {
	const sequence = new Uint8Array(10 + 12 * P25P2_BURST_DIBITS);
	let state = (BigInt(wacn & 0xfffff) << 24n) | (BigInt(system & 0xfff) << 12n) | BigInt(nac & 0xfff);
	for (let index = 10; index < sequence.length; index++) {
		let dibit = 0;
		for (let bit = 0; bit < 2; bit++) {
			dibit = (dibit << 1) | Number((state >> 43n) & 1n);
			const feedback = ((state >> 33n) ^ (state >> 19n) ^ (state >> 14n) ^ (state >> 8n) ^ (state >> 3n) ^ (state >> 43n)) & 1n;
			state = ((state << 1n) | feedback) & MASK_44;
		}
		sequence[index] = dibit;
	}
	return sequence;
}

export function p25p2Descramble(burst: ArrayLike<number>, sequence: Uint8Array, slot: number): Uint8Array {
	if (burst.length < P25P2_BURST_DIBITS || slot < 0 || slot >= 12 || sequence.length < 12 * P25P2_BURST_DIBITS)
		throw new Error('Invalid P25 Phase 2 burst or scrambler');
	const result = new Uint8Array(P25P2_BURST_DIBITS);
	for (let index = 0; index < result.length; index++) result[index] = burst[index] ^ sequence[slot * P25P2_BURST_DIBITS + index];
	return result;
}

/** The cell of mbelib's four-row AMBE+2 word (row * 24 + column) of each of the 72 air bits. */
const AMBE_CELLS = (() => {
	const columns = [AMBE_C0, AMBE_C1, AMBE_C2, AMBE_C3];
	const rowCount = [0, 0, 0, 0];
	return Uint8Array.from(AMBE_ROW, (row) => row * 24 + columns[row][rowCount[row]++]);
})();

/** 72 air bits in mbelib's four-row AMBE+2 word order (96 bytes including unused cells). */
export function p25p2AmbeFrame(burst: ArrayLike<number>, offset: number): Uint8Array {
	if (burst.length < P25P2_BURST_DIBITS || offset < 0 || offset + 72 > 320) throw new Error('Invalid P25 Phase 2 AMBE offset');
	const frame = new Uint8Array(96);
	for (let index = 0; index < 72; index++) {
		const position = offset + index;
		const dibit = burst[20 + (position >> 1)];
		frame[AMBE_CELLS[index]] = (dibit >> (1 - (position & 1))) & 1;
	}
	return frame;
}

// ---------------------------------------------------------------- the rest of the burst layout (the receiver)

export const SYMBOL_RATE = 6000;
export const ISCH_DIBITS = 20;
export const SLOTS_PER_SUPERFRAME = 12;
export const ROLL_OFF = 0.35;
// DUIDs of the bursts
export const DUID_4V = 0;
export const DUID_SACCH = 3;
export const DUID_2V = 6;
export const DUID_FACCH = 9;
export const DUID_SACCH_CLEAR = 12;
export const DUID_LCCH = 13;
export const DUID_FACCH_CLEAR = 15;
/** ESS-B: 4 hexbits in each 4V burst at dibit 94; ESS-A: 16 hexbits at dibit 94 and 12 at dibit 143 of the 2V burst. */
export const ESS_B_POS = 94;
export const ESS_A1_POS = 94;
export const ESS_A2_POS = 143;
/** The burst dibits after the ISCH that the DUID leaves free. */
export const PAYLOAD_DIBITS = P25P2_BURST_DIBITS - ISCH_DIBITS - 4;
export const SACCH_AIR_BYTES = 21;
export const FACCH_AIR_BYTES = 18;
// MAC PDU opcodes (header byte bits 7..5)
export const MAC_SIGNAL = 0;
export const MAC_PTT = 1;
export const MAC_END_PTT = 2;
export const MAC_IDLE = 3;
export const MAC_ACTIVE = 4;
export const MAC_HANGTIME = 6;
// Message opcodes inside a MAC PDU (the TSBK opcode plus 0x40 for the ones that exist in both)
export const MSG_NULL = 0x00;
export const MSG_GRP_V_USER = 0x01;
export const MSG_UU_V_USER = 0x02;
export const MSG_GRP_V_GRANT = 0x40;
export const MSG_GRP_V_GRANT_UPD = 0x42;
export const MSG_UU_V_GRANT = 0x44;
export const MSG_IDEN_UP_VU = 0x74;
export const MSG_RFSS_STS = 0x7a;
export const MSG_NET_STS = 0x7b;
export const MSG_ADJ_STS = 0x7c;
export const MSG_IDEN_UP = 0x7d;
export const MSG_GRP_V_GRANT_EXT = 0xc0;
export const MSG_GRP_V_GRANT_UPD_EXT = 0xc3;
// PTT fields (after the header byte): message indicator 9 bytes, algorithm ID 1, key ID 2, source 3, group 2
export const PTT_MI_OFF = 1;
export const PTT_ALG_OFF = 10;
export const PTT_KEY_OFF = 11;
export const PTT_SRC_OFF = 13;
export const PTT_GRP_OFF = 16;
export const PTT_LEN = 18;
// END_PTT fields: colour code in the low 12 bits of the two bytes at END_COLOR_OFF, source 3, group 2
export const END_COLOR_OFF = 1;
export const END_SRC_OFF = 13;
export const END_GRP_OFF = 16;
export const END_LEN = 18;
export const ALG_CLEAR = 0x80;

/** Dibit <-> differential phase step in units of pi/4: 00 +1, 01 +3, 10 -1, 11 -3 (the C4FM table of Phase 1). */
export const DIBIT_STEP = [1, 3, -1, -3];

export function popcount32(x: number): number {
	x -= (x >>> 1) & 0x55555555;
	x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
	return (Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24) & 63;
}

/** Root raised cosine impulse response at time t (in symbols), roll-off a. */
export function rrcImpulse(t: number, a: number): number {
	const at = a * t;
	if (t > -1e-9 && t < 1e-9) return 1 - a + (4 * a) / Math.PI;
	const q = 1 / (4 * a);
	if ((t > q - 1e-9 && t < q + 1e-9) || (t > -q - 1e-9 && t < -q + 1e-9)) {
		const r = Math.PI / (4 * a);
		return (a / Math.SQRT2) * ((1 + 2 / Math.PI) * Math.sin(r) + (1 - 2 / Math.PI) * Math.cos(r));
	}
	return (Math.sin(Math.PI * t * (1 - a)) + 4 * at * Math.cos(Math.PI * t * (1 + a))) / (Math.PI * t * (1 - 16 * at * at));
}

/** A 40-bit ISCH word into 20 dibits, the first dibit from the top bits. */
function ischPut(word: bigint, d: Uint8Array): void {
	for (let i = 0; i < ISCH_DIBITS; i++) d[i] = Number((word >> BigInt(38 - 2 * i)) & 3n);
}

export function ischSync(d: Uint8Array): void {
	ischPut(P25P2_SYNC, d);
}

/** I-ISCH: 7 information bits, channel (bits 6..5), location (4..3), first (2), ultraframe count (1..0). */
export function ischInfoOf(channel: number, loc: number, first: number, uf: number): number {
	return ((channel & 3) << 5) | ((loc & 3) << 3) | ((first & 1) << 2) | (uf & 3);
}

export function ischInfo(info: number, d: Uint8Array): void {
	ischPut(ISCH_WORDS[info & 127], d);
}

/** The logical channel (0 or 1) of the burst in slot s (0..11) of the superframe: the slot parity, swapped in slots 10 and 11. */
export function slotChannel(s: number): number {
	return (s & 1) ^ (s > 9 ? 1 : 0);
}

/** The 8-bit code word of a DUID: the centre of its DUID_LOOKUP sphere. */
export function duidWord(duid: number): number {
	for (let v = 0; v < 256; v++) {
		if (v >> 4 !== (duid & 15) || DUID_LOOKUP[v] !== (duid & 15)) continue;
		let centre = true;
		for (let b = 0; b < 8; b++) centre = centre && DUID_LOOKUP[v ^ (1 << b)] === (duid & 15);
		if (centre) return v;
	}
	return 0;
}

export function duidPut(duid: number, burst: Uint8Array): void {
	const w = duidWord(duid);
	for (let i = 0; i < 4; i++) burst[DUID_POSITIONS[i]] = (w >> (6 - 2 * i)) & 3;
}

// ---------------------------------------------------------------- voice

const ROW_LEN = [24, 23, 11, 14];

/** The AMBE+2 frame (mbelib's ambe_fr) into the burst at a bit offset counted from dibit 20 (the test signal). */
export function ambePut(fr: ArrayLike<number>, bitOff: number, burst: Uint8Array): void {
	for (let x = 0; x < 72; x++) {
		const at = ISCH_DIBITS + ((bitOff + x) >> 1);
		const m = (bitOff + x) & 1 ? 1 : 2;
		burst[at] = fr[AMBE_CELLS[x]] & 1 ? burst[at] | m : burst[at] & ~m;
	}
}

/** The 72 bits of a frame in code word order (C0 24 bits, C1 23, C2 11, C3 14). */
export function ambeFlatten(fr: ArrayLike<number>): Uint8Array {
	const bits = new Uint8Array(72);
	let k = 0;
	for (let r = 0; r < 4; r++) for (let c = 0; c < ROW_LEN[r]; c++) bits[k++] = fr[r * 24 + c] & 1;
	return bits;
}

export function ambeUnflatten(bits: ArrayLike<number>): Uint8Array {
	const fr = new Uint8Array(96);
	let k = 0;
	for (let r = 0; r < 4; r++) for (let c = 0; c < ROW_LEN[r]; c++) fr[r * 24 + c] = bits[k++] & 1;
	return fr;
}

// ---------------------------------------------------------------- ESS

/** n hexbits -> 3n dibits at d[at]. */
export function hexbitsPut(hex: ArrayLike<number>, n: number, d: Uint8Array, at = 0): void {
	for (let i = 0; i < n; i++) for (let j = 0; j < 3; j++) d[at + i * 3 + j] = (hex[i] >> (4 - 2 * j)) & 3;
}

/** 3n dibits at d[at] -> n hexbits into hex[into]. */
export function hexbitsGet(d: ArrayLike<number>, at: number, n: number, hex: Uint8Array, into = 0): void {
	for (let i = 0; i < n; i++) hex[into + i] = ((d[at + i * 3] & 3) << 4) | ((d[at + i * 3 + 1] & 3) << 2) | (d[at + i * 3 + 2] & 3);
}

/** RS(44,16) of the algorithm ID, key ID and message indicator: ESS-B (16 hexbits) and ESS-A (28 parity hexbits). */
export function essEncode(algId: number, keyId: number, mi: ArrayLike<number>): { b: Uint8Array; a: Uint8Array } {
	const bits = new Uint8Array(96);
	for (let i = 0; i < 8; i++) bits[i] = (algId >> (7 - i)) & 1;
	for (let i = 0; i < 16; i++) bits[8 + i] = (keyId >> (15 - i)) & 1;
	for (let i = 0; i < 72; i++) bits[24 + i] = (mi[i >> 3] >> (7 - (i & 7))) & 1;
	const sym = new Uint8Array(44);
	for (let i = 0; i < 16; i++) for (let b = 0; b < 6; b++) sym[i] = (sym[i] << 1) | bits[i * 6 + b];
	rsEncode(sym, 44, 16);
	return { b: sym.slice(0, 16), a: sym.slice(16, 44) };
}

/** RS(44,16): corrects essB in place; an algorithm ID of 0 is reported as 0x80 (clear). Null when it cannot be decoded. */
export function essDecode(
	essB: Uint8Array,
	essA: ArrayLike<number>,
): { algId: number; keyId: number; mi: Uint8Array; fixed: number } | null {
	const sym = new Uint8Array(44);
	sym.set(essB.subarray(0, 16));
	for (let i = 0; i < 28; i++) sym[16 + i] = essA[i];
	const fixed = rsDecode(sym, 44, 16);
	if (fixed < 0) return null;
	essB.set(sym.subarray(0, 16));
	let algId = (essB[0] << 2) | (essB[1] >> 4);
	if (algId === 0) algId = ALG_CLEAR;
	const keyId = ((essB[1] & 0x0f) << 12) | (essB[2] << 6) | essB[3];
	const mi = new Uint8Array(9);
	for (let g = 0; g < 3; g++) {
		// the MI: hexbits 4..15 (four per group) -> bytes 0..8 (three per group)
		const h = 4 + 4 * g;
		mi[3 * g] = ((essB[h] << 2) | (essB[h + 1] >> 4)) & 0xff;
		mi[3 * g + 1] = (((essB[h + 1] & 0x0f) << 4) | (essB[h + 2] >> 2)) & 0xff;
		mi[3 * g + 2] = (((essB[h + 2] & 0x03) << 6) | essB[h + 3]) & 0xff;
	}
	return { algId, keyId, mi, fixed };
}

// ---------------------------------------------------------------- MAC PDU codewords in the burst

/** The burst index of each payload dibit (after the ISCH, around the DUID dibits). */
export const PAYLOAD_POS = (() => {
	const pos = new Int32Array(PAYLOAD_DIBITS);
	const duid = new Set<number>(DUID_POSITIONS);
	for (let i = ISCH_DIBITS, k = 0; i < P25P2_BURST_DIBITS; i++) if (!duid.has(i)) pos[k++] = i;
	return pos;
})();

/** n <= PAYLOAD_DIBITS; the rest is left as it is. */
export function payloadPut(d: ArrayLike<number>, n: number, burst: Uint8Array): void {
	for (let k = 0; k < n; k++) burst[PAYLOAD_POS[k]] = d[k];
}

export function payloadGet(burst: ArrayLike<number>): Uint8Array {
	return Uint8Array.from(PAYLOAD_POS, (i) => burst[i]);
}

// ---------------------------------------------------------------- MAC PDU codewords as on the air
// (TIA-102.BBAC-A, as OnAir reads OP25's p25p2_tdma.cc): the hexbits of a Reed-Solomon (63,35,29) codeword over GF(64)
// shortened at the front and punctured at the back.
//   SACCH  all 156 payload dibits = 52 hexbits at codeword positions 5..56; 30 data hexbits = 168 MAC bits + CRC-12.
//   FACCH  135 payload dibits (payload indices 0..66 and 88..155) = 45 hexbits at positions 9..53; 26 data hexbits =
//          144 MAC bits + CRC-12. The 21 payload dibits between are not part of the codeword.

/** Codeword layout: first sent position, data hexbits, hexbits sent, MAC bytes. */
export function airLayout(facch: boolean): { first: number; nData: number; nSent: number; nBytes: number } {
	return facch ? { first: 9, nData: 26, nSent: 45, nBytes: FACCH_AIR_BYTES } : { first: 5, nData: 30, nSent: 52, nBytes: SACCH_AIR_BYTES };
}

/** Payload index of the k-th codeword dibit. */
function airIndex(facch: boolean, k: number): number {
	return facch && k >= 67 ? k + 21 : k;
}

/** The received codeword symbols (63, the shortened and punctured ones 0). */
export function airSymbols(facch: boolean, payload: ArrayLike<number>): Uint8Array {
	const { first, nSent } = airLayout(facch);
	const rx = new Uint8Array(63);
	for (let i = 0; i < nSent; i++)
		for (let j = 0; j < 3; j++) rx[first + i] = (rx[first + i] << 2) | (payload[airIndex(facch, i * 3 + j)] & 3);
	return rx;
}

/** mac: SACCH_AIR_BYTES or FACCH_AIR_BYTES bytes -> the 156 payload dibits. */
export function macEncodeAir(facch: boolean, mac: ArrayLike<number>): Uint8Array {
	const { first, nData, nSent, nBytes } = airLayout(facch);
	const bits = new Uint8Array(180);
	for (let i = 0; i < nBytes * 8; i++) bits[i] = (mac[i >> 3] >> (7 - (i & 7))) & 1;
	const crc = crc12(bits, nBytes * 8);
	for (let i = 0; i < 12; i++) bits[nBytes * 8 + i] = (crc >> (11 - i)) & 1;
	const sym = new Uint8Array(63);
	for (let i = 0; i < nData; i++) for (let b = 0; b < 6; b++) sym[first + i] = (sym[first + i] << 1) | bits[i * 6 + b];
	rsEncode(sym, 63, 35);
	const payload = new Uint8Array(PAYLOAD_DIBITS);
	for (let i = 0; i < nSent; i++) for (let j = 0; j < 3; j++) payload[airIndex(facch, i * 3 + j)] = (sym[first + i] >> (4 - 2 * j)) & 3;
	return payload;
}

/** RS and CRC must pass. The punctured parity is erased; the shortened front symbols are taken as zeros, then as erased. */
export function macDecodeAir(facch: boolean, payload: ArrayLike<number>): P25p2MacPdu | null {
	const { first, nData, nSent, nBytes } = airLayout(facch);
	const rx = airSymbols(facch, payload);
	for (let attempt = 0; attempt < 2; attempt++) {
		const era: number[] = [];
		for (let p = first + nSent; p < 63; p++) era.push(p);
		if (attempt) for (let p = 0; p < first; p++) era.push(p);
		const sym = rx.slice();
		const corrected = rs63Decode(sym, era);
		if (corrected < 0) continue;
		const bits = new Uint8Array(180);
		for (let i = 0; i < nData; i++) for (let b = 0; b < 6; b++) bits[i * 6 + b] = (sym[first + i] >> (5 - b)) & 1;
		let crc = 0;
		for (let i = 0; i < 12; i++) crc = (crc << 1) | bits[nBytes * 8 + i];
		if (crc !== crc12(bits, nBytes * 8)) continue;
		const mac = new Uint8Array(nBytes);
		for (let i = 0; i < nBytes; i++) for (let b = 0; b < 8; b++) mac[i] = (mac[i] << 1) | bits[i * 8 + b];
		return { mac, corrected };
	}
	return null;
}

// ---------------------------------------------------------------- MAC PDU

/** Bytes including the opcode; 0 when the opcode is not known here (parsing of the PDU stops). */
export function macMsgLen(op: number): number {
	return MAC_MSG_LENGTHS.get(op & 0xff) ?? 0;
}

/**
 * The length of the message at m[at] (avail bytes left in the PDU), by the rules of OP25's p25p2_tdma.cc: 0x00 fills the
 * rest of the PDU; 0x08 carries its length in the low 6 bits of byte 1; 0x11 and 0x12 are ((byte1 & 3) + 1) * 2 + 2 and
 * * 3 + 2 bytes; a manufacturer message (top bits 10) has its length in the low 6 bits of byte 2, falling back to the
 * table when that is 0; every other opcode takes the table. 0: unknown, parsing stops.
 */
export function macMsgLenAt(m: ArrayLike<number>, at: number, avail: number): number {
	if (avail <= 0) return 0;
	const op = m[at];
	if (op === 0x00) return avail;
	if (avail < 2) return macMsgLen(op);
	if (op === 0x08) return m[at + 1] & 0x3f;
	if (op === 0x11) return ((m[at + 1] & 3) + 1) * 2 + 2;
	if (op === 0x12) return ((m[at + 1] & 3) + 1) * 3 + 2;
	if (op >> 6 === 2 && avail > 2 && m[at + 2] & 0x3f) return m[at + 2] & 0x3f;
	return macMsgLen(op);
}

export function macOpcode(header: number): number {
	return (header >> 5) & 7;
}

export function be16(p: ArrayLike<number>, at: number): number {
	return (p[at] << 8) | p[at + 1];
}

export function be24(p: ArrayLike<number>, at: number): number {
	return (p[at] << 16) | (p[at + 1] << 8) | p[at + 2];
}

/** (be64(p + at) >> shift) & (2^width - 1): a field of the 64 bits that follow a message opcode, width <= 32. */
export function argField(p: ArrayLike<number>, at: number, shift: number, width: number): number {
	let v = 0;
	// bit b of the 64 (0 the least significant) is bit b & 7 of byte (63 - b) >> 3
	for (let b = shift + width - 1; b >= shift; b--) v = v * 2 + ((p[at + ((63 - b) >> 3)] >> (b & 7)) & 1);
	return v;
}
