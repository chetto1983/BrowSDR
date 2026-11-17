import type { M17Status } from './m17/types';
import type { P25p2Status } from './p25p2/types';
import type { DmrInfo } from './dmr/types';
import type { DstarStatus } from './dstar/types';
import type { NxdnStatus } from './nxdn/types';
import type { P25Status } from './p25/types';
/*
 * DSD (Digital Speech Decoder) status and sync types.
 * Ported from SDR++ Brown ch_extravhf_decoder.
 *
 * Original DSD source: https://github.com/szechyjs/dsd
 * Copyright (C) 2010 DSD Author (ISC License)
 *
 * The Yaesu System Fusion and dPMR statuses (YsfStatus, DpmrStatus) describe what BrowSDR shows of OnAir's
 * FusionTelemetry and DpmrTelemetry (core/include/dect2/fusion/fusion_rx.h, core/include/dect2/dpmr/dpmr_tel.h,
 * GPL-3.0-or-later, see third_party/onair); the decoding is in ysf/ and dpmr/.
 * The P25 Phase 2 status (P25p2Status) is in p25p2/types.ts with its receiver (OnAir, GPL-3.0-or-later).
 * DmrInfo (talker alias, positions, messages, trunking, control blocks) is in dmr/types.ts (OnAir, GPL-3.0-or-later).
 */

// ── Detected DSD mode ────────────────────────────────────────────────
export type DSDMode = 'dmr' | 'dstar' | 'p25' | 'p25p2' | 'nxdn' | 'ysf' | 'dpmr' | 'm17' | 'unknown';

export interface DSDStatus {
	mode: DSDMode;
	synced: boolean;
	/** Which sync word was matched (e.g. "DMR_BS_VOICE") */
	syncName?: string;

	// ── mbelib state ──
	/** Whether mbelib WASM is loaded and ready */
	mbelibLoaded?: boolean;
	/** Voice codec assets failed to load or initialize. */
	mbelibError?: string;
	/** Whether MBE decoder is actively producing audio */
	mbeDecoding?: boolean;
	/** MBE error bar string (e.g. "======R") — one char per voice frame */
	mbeErrors?: string;
	/** Total voice frames decoded this session */
	voiceFrameCount?: number;
	/** Confirmed syncs and the most recent protocol, retained between bursts. */
	syncCount?: number;
	lastSyncName?: string;

	// ── DMR ──
	/** DMR color code (0-15) */
	colorCode?: number;
	/** DMR current slot (0 or 1) */
	slot?: number;
	/** DMR slot 0 burst type description */
	slot0Burst?: string;
	/** DMR slot 1 burst type description */
	slot1Burst?: string;
	/** Last DMR call addressing from a Voice LC Header or Terminator, with its slot and time. */
	dmrCall?: DmrLinkControl & { slot: number; at: number };
	/** DMR beyond the call header: talker alias, position, text, trunking, control blocks and recent events (dmr/). */
	dmr?: DmrInfo;

	// ── P25 ──
	/** P25 Network Access Code (12-bit) */
	nac?: number;
	/** P25 Data Unit ID type string */
	duid?: string;
	/** P25 Source ID */
	src?: number;
	/** P25 Talkgroup ID */
	tg?: number;
	/** P25 Emergency flag */
	emr?: boolean;
	/** P25 Algorithm ID (encryption) */
	algid?: number;
	/** P25 Phase 1 call, control channel (site, neighbours, channel identifiers, grants) and events (p25/). */
	p25?: P25Status;

	// ── P25 Phase 2 ──
	p25p2?: P25p2Status;

	// ── D-STAR ──
	/** D-STAR callsign (if decoded from header) */
	callsign?: string;
	/** D-STAR header, slow data, positions and events (dstar/). */
	dstar?: DstarStatus;

	// ── NXDN ──
	/** NXDN type description */
	nxdnType?: string;
	/** NXDN48 / NXDN96 call, site and events (nxdn/). */
	nxdn?: NxdnStatus;

	// ── Yaesu System Fusion ──
	ysf?: YsfStatus;

	// ── dPMR ──
	dpmr?: DpmrStatus;

	// ── M17 ──
	m17?: M17Status;
}

/** The last dPMR transmission: a voice call, a status message, a short message or packet data. */
export interface DpmrStatus {
	kind: 'voice' | 'status' | 'message' | 'packet';
	/** Colour code 0 to 63 (-1: not received yet). */
	colourCode: number;
	/** Own (source) and called (destination) 24-bit ids; -1 while not known (a call joined late). */
	src: number;
	dst: number;
	/** 'individual', 'group' or 'all call'. */
	callType: string;
	/** Communication mode, e.g. 'voice' or 'data type 2'. */
	commMode: string;
	emergency: boolean;
	/** Found from the control channel superframe (the header was missed). */
	lateEntry: boolean;
	/** The end frame or the loss of the signal closed it. */
	ended: boolean;
	/** It ended without an end frame (the signal was lost). */
	lost: boolean;
	/** Status message: "status N"; short message or packet data: the text. */
	text: string;
	/** Blocks that passed their CRC. */
	blocks: number;
	inverted: boolean;
	snrDb: number;
}

/** A Yaesu System Fusion transmission as far as it has been decoded. */
export interface YsfStatus {
	/** 'DN' (V/D mode 1 or 2), 'VW' (voice full rate) or 'Data' (data full rate). */
	mode: string;
	/** FICH data type: 0 V/D mode 1, 1 data FR, 2 V/D mode 2, 3 voice FR. */
	dataType: number;
	/** FICH frame type: 0 header, 1 communication, 2 terminator, 3 test. */
	frameType: number;
	/** Source (own) and destination callsigns. */
	src: string;
	dest: string;
	/** Repeater downlink and uplink callsigns. */
	down: string;
	up: string;
	/** Callsign data 3: four five-character fields (radio IDs). */
	rem: string[];
	/** Digital group ID (the FICH squelch code field, 0 to 127). */
	dgId: number;
	/** 0 group / CQ, 3 individual. */
	callMode: number;
	/** Message routing: 0 direct, 1 and 2 via a repeater downlink. */
	routing: number;
	voip: boolean;
	/** Slow data as text. */
	text: string;
	/** Position from the slow data GPS block, with the radio model. */
	gps?: { lat: number; lon: number; radio: string };
	/** Frames whose FICH checked in this transmission. */
	frames: number;
	/** A terminator frame closed the transmission. */
	ended: boolean;
	/** The spectrum is mirrored. */
	inverted: boolean;
	snrDb: number;
}

/** DMR Full Link Control of a voice call (ETSI TS 102 361-2 §7.1.1). */
export interface DmrLinkControl {
	colourCode: number;
	/** Terminator with LC (end of the transmission) rather than a Voice LC Header. */
	terminator: boolean;
	/** Group call (talkgroup in target) rather than unit-to-unit. */
	group: boolean;
	featureSet: number;
	emergency: boolean;
	/** Service option privacy flag: the voice is encrypted. */
	privacy: boolean;
	target: number;
	source: number;
	/** Learned from the embedded LC of the voice bursts: the call was joined without its header (dmr/link.ts). */
	lateEntry?: boolean;
}

/** One line of a protocol's short event list in the DSD panel (newest first). */
export interface DsdEvent {
	/** Wall clock time (ms). */
	at: number;
	text: string;
}

/** The 4800 symbols/s chain's buffers as D-STAR, NXDN96 and P25 Phase 1 read their frames from them. */
export interface DsdChain {
	dibits: Uint8Array;
	/** The symbol value (Hz) of each dibit. */
	symbols: Float32Array;
	/** Each dibit's time in samples of the RRC filter output, kept in samples (48 kHz, its own mask). */
	times: Float64Array;
	samples: Float32Array;
	mask: number;
}

/** What the decoder does for D-STAR, NXDN and P25 Phase 1: the status, voice through mbelib, a codec reset, a sync to count. */
export interface DsdSink {
	status(): DSDStatus;
	voice(frames: Int8Array[]): void;
	reset(): void;
	synced(sync: SyncType): void;
}

// ── Frame sync state ─────────────────────────────────────────────────
export const enum SyncType {
	NONE = -1,
	P25P1 = 0,
	INV_P25P1 = 1,
	/** P25 Phase 2 (found by its own receiver, p25p2/) */
	P25P2 = 40,
	X2TDMA_BS_VOICE = 2,
	X2TDMA_BS_DATA = 3,
	X2TDMA_MS_VOICE = 4,
	X2TDMA_MS_DATA = 5,
	DSTAR = 6,
	INV_DSTAR = 7,
	NXDN_MS_DATA = 8,
	INV_NXDN_MS_DATA = 9,
	NXDN_MS_VOICE = 10,
	INV_NXDN_MS_VOICE = 11,
	DMR_BS_DATA = 12,
	DMR_BS_VOICE = 13,
	DMR_MS_DATA = 14,
	DMR_MS_VOICE = 15,
	PROVOICE = 16,
	INV_PROVOICE = 17,
	NXDN_BS_DATA = 18,
	INV_NXDN_BS_DATA = 19,
	NXDN_BS_VOICE = 20,
	INV_NXDN_BS_VOICE = 21,
	DSTAR_HD = 22,
	INV_DSTAR_HD = 23,
	DMR_DM_TS1_DATA = 24,
	DMR_DM_TS1_VOICE = 25,
	DMR_DM_TS2_DATA = 26,
	DMR_DM_TS2_VOICE = 27,
	YSF = 28,
	INV_YSF = 29,
	DPMR_FS1 = 30,
	DPMR_FS2 = 31,
	DPMR_FS3 = 32,
	DPMR_FS4 = 33,
	/** NXDN48 (found by its own 2400 symbols/s receiver, nxdn/) and NXDN96 frame syncs with a LICH other than DSD's. */
	NXDN48 = 50,
	NXDN96 = 51,
	INV_NXDN96 = 52,
}

export interface SyncPattern {
	pattern: string;
	type: SyncType;
	len: number;
}
