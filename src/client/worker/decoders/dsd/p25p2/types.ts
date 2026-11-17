// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/include/dect2/p25p2/p25p2_tel.h (P25p2Call, P25p2Telemetry),
// core/include/dect2/p25/p25_tel.h (P25Site, P25IdenRow) and core/src/p25p2/p25p2_rx.cpp (Ess),
// https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the telemetry keeps what BrowSDR's DSD panel shows (the two slots, the seed, the site, the last grant and the
// counters); the call log, talkgroup table, adjacent sites and event texts are left out. A recovered seed is BrowSDR's
// (seed.ts). The receiver's events for BrowSDR's DSD decoder are described here.

/** One call on a logical channel (time slot 1 or 2): the call on air, or the last one heard. */
export interface P25p2Slot {
	active: boolean;
	/** Unit ID; talkgroup (group) or unit (unit to unit); -1 not known yet. */
	src: number;
	dst: number;
	group: boolean;
	emergency: boolean;
	/** Reported only: nothing is decrypted, the voice of such a call never reaches the codec. */
	encrypted: boolean;
	/** False: joined late and no PTT or encryption sync (ESS) has said yet (voice is held back until one does). */
	cryptoKnown: boolean;
	/** Algorithm ID (0x80 clear) and key ID, from the PTT or the ESS. */
	algId: number;
	keyId: number;
	/** Message indicator (hex) of the PTT or the ESS, '' when none was received. Kept for the display, never used. */
	mi: string;
	/** Voice is flowing but no PTT or ESS has said whether it is encrypted for three superframes: skipped as "encryption unknown". */
	essMissing: boolean;
	lateEntry: boolean;
	/** Ended with an END_PTT (else the signal was lost). */
	endSeen: boolean;
	voiceFrames: number;
	clearFrames: number;
	/** AMBE+2 frames handed to the codec. */
	voice: boolean;
	/** Signal time of the start (s), and the duration. */
	startSec: number;
	durSec: number;
}

/** The site from NET_STS_BCST / RFSS_STS_BCST. */
export interface P25p2Site {
	wacn: number;
	sysId: number;
	rfss: number;
	site: number;
	channel: number;
	freqHz: number;
}

/** A channel identifier (IDEN_UP / IDEN_UP_VU): channel numbers to frequencies. */
export interface P25p2Iden {
	baseHz: number;
	spacingHz: number;
	bwHz: number;
	txOffsetHz: number;
	vu: boolean;
}

/** A voice channel grant heard in a MAC PDU. */
export interface P25p2Grant {
	/** Talkgroup (group) or target unit. */
	dst: number;
	src: number;
	group: boolean;
	channel: number;
	/** 0 when the channel identifier has not been heard. */
	freqHz: number;
	emergency: boolean;
	encrypted: boolean;
	/** Signal time (s). */
	at: number;
}

/** What BrowSDR's DSD panel shows of a P25 Phase 2 channel. */
export interface P25p2Status {
	/** Logical channels 1 and 2. */
	slots: P25p2Slot[];
	/** The slot whose voice is played (1 or 2), 0 none. */
	audioSlot: number;
	/** Slot of the superframe (0 to 11) of the last burst, -1 not known. */
	slotNow: number;
	/** The descrambler seed in use (all 0: the bursts are taken as sent). */
	wacn: number;
	sysId: number;
	nac: number;
	/** 'none': not descrambled; 'recovered': found from a MAC burst (seed.ts); 'set': given by setSystem. */
	seed: P25p2SeedSource;
	/** Colour code (NAC) of the last END_PTT, -1 none. */
	endNac: number;
	site?: P25p2Site;
	grant?: P25p2Grant;
	cfoHz: number;
	snrDb: number;
	macOk: number;
	macBad: number;
	essOk: number;
	essBad: number;
	voiceFrames: number;
	encryptedSkipped: number;
}

export type P25p2SeedSource = 'none' | 'recovered' | 'set';

/** What the P25 Phase 2 receiver reports to the DSD decoder. */
export interface P25p2Events {
	/** The DSD decoder's status, where the receiver puts its own (DSDStatus.p25p2) before each synced(). */
	status(): { p25p2?: P25p2Status };
	/** A sync word on the grid of the lock (the decoder's mode lock follows within three). */
	synced(): void;
	/** AMBE+2 frames of the played slot, in mbelib's ambe_fr[4][24] layout (96 bytes each). */
	voice(frames: Uint8Array[]): void;
}

/** The symbol clock and burst framing hand each burst on with the slot of the superframe and the logical channel. */
export interface P25p2BurstSink {
	burst(buf: Uint8Array, slot: number, channel: number): void;
	/** A sync word on the grid of the lock (the lock is confirmed). */
	synced(): void;
}

/** Receiver counters (P25p2Telemetry). */
export interface P25p2Counters {
	syncs: number;
	slots: number;
	slotsBad: number;
	ischBad: number;
	ischExact: number;
	ischCorrected: number;
	slotsSkipped: number;
	unlocks: number;
	realigns: number;
	duidBad: number;
	v4: number;
	v2: number;
	sacch: number;
	facch: number;
	macOk: number;
	macBad: number;
	rsCorrected: number;
	essOk: number;
	essBad: number;
	essReused: number;
	voiceFrames: number;
	voiceDecoded: number;
	encryptedSkipped: number;
	unknownSkipped: number;
	seedsRecovered: number;
}

/** The encryption sync of a slot as it arrives: ESS-B a quarter in each 4V burst, ESS-A in the 2V burst. */
export interface P25p2Ess {
	b: Uint8Array;
	a: Uint8Array;
	nb: number;
}

/** A decoded MAC PDU, and the hexbits Reed-Solomon corrected. */
export interface P25p2MacPdu {
	mac: Uint8Array;
	corrected: number;
}

/** A 44-bit descrambler seed: WACN (20 bits), system ID (12) and NAC (12). */
export interface P25p2Seed {
	wacn: number;
	sysId: number;
	nac: number;
}
