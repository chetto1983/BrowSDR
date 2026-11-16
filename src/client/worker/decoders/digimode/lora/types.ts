// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/include/dect2/mesh/mesh_lora.h (Params, Header, SoftSym, RxFrame,
// DemodStats), core/include/dect2/lorawan/lora_bank.h (Channel, Decoded), core/include/dect2/mesh/mesh_proto.h
// (MeshLoraSettings), core/src/mesh/mesh_lora_demod.cpp (the SFD search candidates and preamble measurements) and
// core/src/mesh/mesh_crypto_ed25519.cpp (Fe, Point, Consts), https://github.com/adswill/OnAir; see third_party/onair.
// LoRa facts as credited there: gr-lora_sdr (Joachim Tapparel, EPFL, and contributors, GPL-3.0). Changes: the soft
// symbols live in flat typed arrays of the frame decoder; the bank works on the one channel of the VFO; no satellite
// fields of the frame (Doppler rate); named records for the values the C++ SFD search kept in locals.

/** The LoRa settings of one demodulator (one spreading factor of a channel). */
export interface LoraParams {
	/** 5..12 (SF5 / 6 as on the SX126x: two more symbols after the SFD, a full-rate header block). */
	sf: number;
	bwHz: number;
	/** 5..8 for 4/5..4/8 (the header of an explicit frame carries its own). */
	cr: number;
	/** Up-chirps before the sync word (only places the frame start). */
	preamble: number;
	syncWord: number;
	/** Further sync words tried by the same demodulator (one preamble search serves all of them). */
	moreSync: number[];
	/** Low data rate optimisation. */
	ldro: boolean;
	crc: boolean;
	/** No header: length, coding rate and CRC agreed beforehand. */
	implicitHdr: boolean;
	implicitLen: number;
	/** A CRC-bad frame is searched for sample jumps of multiples of this many chips; 0 turns the search off. */
	jumpChips: number;
}

export interface LoraHeader {
	len: number;
	/** 5..8 */
	cr: number;
	crc: boolean;
	ok: boolean;
}

/** A demodulated frame. */
export interface LoraFrame {
	payload: Uint8Array;
	hdr: LoraHeader;
	crcOk: boolean;
	/** Codewords with a corrected bit. */
	corrected: number;
	/** Carrier offset from the channel centre, Hz. */
	cfoHz: number;
	/** Clock offset measured over the frame. */
	sfoPpm: number;
	/** In the LoRa bandwidth. */
	snrDb: number;
	/** The CRC only came out right after the soft-decision list search. */
	softFixed: boolean;
	/** Sample jumps undone to get the CRC right. */
	jumpsFixed: number;
	/** Signal power, dB relative to full scale. */
	levelDb: number;
	/** Start of the frame (its preamble of the configured length) and end, channel samples since the start. */
	startSample: number;
	endSample: number;
	syncWord: number;
}

export interface LoraDemodStats {
	preambles: number;
	syncBad: number;
	headerBad: number;
	frames: number;
	crcBad: number;
	jumpFixed: number;
}

/** The decoded payload of one frame (FrameDecoder.finish). */
export interface LoraPayload {
	payload: Uint8Array;
	crcOk: boolean;
	corrected: number;
}

/** What the bank decodes on its channel: the spreading factors, sync words and the frame layout. */
export interface LoraBankConfig {
	bwHz: number;
	/** Complex sample rate of the channel (at least twice the bandwidth). */
	rate: number;
	sfs: number[];
	syncs: number[];
	/** Symbols of the preamble (only places the frame start). */
	preamble: number;
}

/** A frame found by the bank, with the spreading factor and sync word that found it. */
export interface LoraDecoded {
	sf: number;
	sync: number;
	bwHz: number;
	/** Signal time of the frame's start, seconds since the bank started. */
	sec: number;
	frame: LoraFrame;
}

/** The LoRa settings of a protocol preset (MeshLoraSettings). */
export interface LoraSettings {
	name: string;
	/** 0 = depends on the channel (Meshtastic slot). */
	freqHz: number;
	sf: number;
	bwHz: number;
	cr: number;
	preamble: number;
	syncWord: number;
	ldro: boolean;
}

/** What the LoRa layer knows about a received payload (MeshRadioInfo) and the frame bookkeeping of the record. */
export interface LoraRadio {
	sf: number;
	bwHz: number;
	cr: number;
	snrDb: number;
	levelDb: number;
	cfoHz: number;
	crcOk: boolean;
	/** The header asked for a payload CRC. */
	hasCrc: boolean;
	corrected: number;
	softFixed: boolean;
	jumpsFixed: number;
	syncWord: number;
}

/** A protocol on one LoRa channel: what the bank searches and the packet layer for its frames. */
export interface LoraMode {
	/** "Meshtastic", "MeshCore", ... */
	name: string;
	bwHz: number;
	/** Channel rate (the catalog's), at least twice the bandwidth. */
	rate: number;
	sfs: number[];
	syncs: number[];
	preamble: number;
	/** The packet layer: a record for the payload of a frame (also of a frame whose CRC failed). */
	decode(payload: Uint8Array, radio: LoraRadio): LoraReport;
}

/** One record of a protocol layer: summary, the protocol's fields and whether it is to be shown dimmed. */
export interface LoraReport {
	text: string;
	fields: Array<[label: string, value: string]>;
	/** Parsed as a packet of the protocol (else the raw bytes are shown). */
	ok: boolean;
	/** Short text for the status line ("!2a0b1c2d TEXT_MESSAGE_APP"). */
	last: string;
	alert?: boolean;
}

/** A candidate start of the down-chirps: tau (chips), window m, carrier bin, sync word index and its score. */
export interface SfdCand {
	score: number;
	tau: number;
	m: number;
	cfoC: number;
	si: number;
}

/** The best candidate on the resampled windows: start (chips from the origin), carrier bin, the sync symbols seen and wanted. */
export interface SfdBest {
	score: number;
	s: number;
	cfoC: number;
	v1: number;
	v2: number;
	sw1: number;
	sw2: number;
}

/** Peak position of every preamble window j = 1..J (ok, weight), the phase step of one bin, SNR sums. */
export interface SfdPreamble {
	ej: Float64Array;
	okj: Uint8Array;
	wj: Float64Array;
	accR: number;
	accI: number;
	sig: number;
	noi: number;
	ns: number;
}

/** A field element: 16 limbs of 16 bits. */
export type Fe = Float64Array;

/** A point in extended coordinates. */
export interface EdPoint {
	x: Fe;
	y: Fe;
	z: Fe;
	t: Fe;
}

/** 2 d, sqrt(-1), d and the base point, derived at start. */
export interface EdConsts {
	d2: Fe;
	sqrtm1: Fe;
	dd: Fe;
	base: EdPoint;
}
