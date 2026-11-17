/*
 * DSD (Digital Speech Decoder) status and sync types.
 * Ported from SDR++ Brown ch_extravhf_decoder.
 *
 * Original DSD source: https://github.com/szechyjs/dsd
 * Copyright (C) 2010 DSD Author (ISC License)
 *
 * The Yaesu System Fusion status (YsfStatus) describes what BrowSDR shows of OnAir's FusionTelemetry
 * (core/include/dect2/fusion/fusion_rx.h, GPL-3.0-or-later, see third_party/onair); the decoding is in ysf/.
 */

// ── Detected DSD mode ────────────────────────────────────────────────
export type DSDMode = 'dmr' | 'dstar' | 'p25' | 'nxdn' | 'ysf' | 'unknown';

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

	// ── D-STAR ──
	/** D-STAR callsign (if decoded from header) */
	callsign?: string;

	// ── NXDN ──
	/** NXDN type description */
	nxdnType?: string;

	// ── Yaesu System Fusion ──
	ysf?: YsfStatus;
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
}

// ── Frame sync state ─────────────────────────────────────────────────
export const enum SyncType {
	NONE = -1,
	P25P1 = 0,
	INV_P25P1 = 1,
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
}

export interface SyncPattern {
	pattern: string;
	type: SyncType;
	len: number;
}
