// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir rust/onair_vdl2/src/bits.rs (Layout, Header), avlc.rs (Addr),
// proto.rs (Parsed), core/include/dect2/vdl2/vdl2_tel.h (Vdl2Message) and rust/onair_acars/src/block.rs (Fields),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: the detail text is a list of labelled lines.

/** How a burst's data and FEC octets are laid out: octet counts, number of blocks, length and parity of the last block. */
export interface Vdl2Layout {
	dataOct: number;
	fecOct: number;
	blocks: number;
	lastLen: number;
	lastFec: number;
}

/** What decoding a burst header word gives. */
export interface Vdl2Header {
	ok: boolean;
	corrected: boolean;
	/** Transmission length in bits. */
	len: number;
}

/** An AVLC address: 24 bit address, 3 bit type and the A/G (destination) or C/R (source) status bit. */
export interface Vdl2Addr {
	addr: number;
	type: number;
	status: boolean;
}

/** One line of the decoded layers: what it is about, and the text. */
export type Vdl2Line = [label: string, value: string];

/** The fields of an ACARS block carried in an AVLC information field (ARINC 618). */
export interface Vdl2Acars {
	/** The block check sequence matched. */
	crcOk: boolean;
	mode: string;
	/** Registration, leading dots removed. */
	reg: string;
	/** Technical acknowledgement: a block id, '!' for NAK, '^' for ACK. */
	ack: string;
	/** Two characters; the DEL of "_<DEL>" shows as 'd'. */
	label: string;
	labelText: string;
	blockId: string;
	/** Aircraft to ground (block id is a digit). */
	downlink: boolean;
	/** ETX: the last block of its message; ETB: more blocks follow. */
	finalBlock: boolean;
	/** Downlink: message number ("M01"), block sequence letter and flight id. */
	msgNum: string;
	msgSeq: string;
	flight: string;
	sublabel: string;
	mfi: string;
	/** Printable text; line breaks are '\n'. */
	text: string;
	/** Short reading of fixed-format text (OOOI times, media advisory), else empty. */
	decoded: string;
}

/** A decoded AVLC frame (vdl2_tel.h Vdl2Message, the part a frame sets). */
export interface Vdl2Message {
	dst: number;
	dstType: number;
	src: number;
	srcType: number;
	/** Destination A/G bit: the aircraft is on the ground. */
	onGround: boolean;
	/** Source C/R bit. */
	response: boolean;
	fromAir: boolean;
	fromGround: boolean;
	/** 'I', 'S' or 'U'. */
	frameKind: string;
	/** "I", "RR", "UI", "XID", "GSIF", ... */
	frameName: string;
	/** I / S frame sequence numbers (-1: not in this frame). */
	ns: number;
	nr: number;
	pf: boolean;
	/** Highest protocol read: ACARS, X.25, CLNP, COTP, ES-IS, IDRP, XID (empty for bare link frames). */
	proto: string;
	summary: string;
	/** The decoded layers, one line each. */
	detail: Vdl2Line[];
	/** The information field. */
	info: Uint8Array;
	/** Offset in the frame of the SOH of an ACARS block (-1 none). */
	acarsAt: number;
	acars?: Vdl2Acars;
	hasPos: boolean;
	lat: number;
	lon: number;
	posKind: string;
	hasAlt: boolean;
	altFt: number;
}

/** Connection management bits h and r of an XID frame, which name the frame. */
export interface Vdl2XidBits {
	h: number;
	r: number;
}

/** A burst taken from the air: its frames with good check sequences and how it was received. */
export interface Vdl2Burst {
	messages: Vdl2Message[];
	/** Seconds of signal time at the training sequence. */
	timeSec: number;
	/** Burst amplitude, dB of the channel's full scale. */
	levelDb: number;
	snrDb: number;
	/** Carrier offset from the channel centre (tuning error included), Hz. */
	cfoHz: number;
	/** Octets corrected by the Reed-Solomon code. */
	rsFixed: number;
	headerFixed: boolean;
	/** Frames with a bad check sequence in the burst. */
	bad: number;
}

/** The demodulated bits of a burst and its quality. */
export interface Vdl2Demod {
	bits: Uint8Array;
	snrDb: number;
	levelDb: number;
	cfoHz: number;
}

/** Burst counters of the channel. */
export interface Vdl2Counters {
	bursts: number;
	good: number;
	bad: number;
	frames: number;
	fcsBad: number;
}
