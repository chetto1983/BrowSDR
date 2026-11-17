/*
 * DMR (Digital Mobile Radio) frame processor for DSD.
 * Ported from SDR++ Brown dsd_dmr.cpp.
 *
 * DMR uses 2-slot TDMA with AMBE 3600x2450 codec.
 * Voice superframe: 6 bursts, each containing 3 AMBE frames.
 *
 * Every burst of a frame is also handed, in air order, to the DMR link layer in dmr/ (embedded LC, talker alias,
 * CSBKs, data messages, trunking; ported from OnAir, GPL-3.0-or-later, see third_party/onair).
 */

import { DMR_W, DMR_X, DMR_Y, DMR_Z, SYNC_WORDS } from './constants';
import type { DSDStatus } from './types';
import { decodeDmrLinkControl, DMR_IDLE, slotType } from './dmr-lc';
import { SYNC_BS_DATA, SYNC_BS_VOICE } from './dmr/burst';
import { DmrLink } from './dmr/link';
import type { DmrFrame } from './dmr/types';
import { decodeAmbe, getMbeErrors } from '@/worker/decoders/mbelib-init';

// ── DMR burst type detection ─────────────────────────────────────────

/** DMR burst types */
const _BURST_TYPES = [
	'PI Header',
	'Voice Header',
	'TLC',
	'CSBK',
	'MBC Header',
	'MBC Cont',
	'Data Header',
	'Rate 1/2 Data',
	'Rate 3/4 Data',
	'Idle',
	'Rate 1 Data',
	'Unknown Data',
] as const;

/**
 * Extract color code from a DMR CACH (Common Annex Channel).
 * The CACH is 12 dibits (24 bits) between the two slot halves.
 *
 * @param cachDibits 12 dibits of CACH data
 * @returns Color code (0-15) or -1 if invalid
 */
function extractColorCode(cachDibits: Uint8Array, offset: number): number {
	// CACH format: TACT (7 bits) + payload
	// Color code is in bits 0-3 of the TACT
	let tact = 0;
	for (let i = 0; i < 4; i++) {
		const dibit = cachDibits[offset + i] & 3;
		tact = (tact << 2) | dibit;
	}
	// Color code from bits 4-7 (first 4 bits of TACT after hamming)
	return (tact >> 4) & 0xf;
}

/**
 * Process a DMR voice burst and extract AMBE frames.
 *
 * A DMR voice superframe consists of 6 bursts. Each burst:
 *   - 54 dibits: first half of voice payload
 *   - 12 dibits: CACH (inter-slot signaling)
 *   - 54 dibits: second half of voice payload
 *   Total payload: 108 dibits = 216 bits
 *   This encodes 3 AMBE frames of 36 dibits each (108 total).
 *
 * @param dibitBuf Dibit buffer
 * @param dibitPos Position at start of burst payload (after sync)
 * @param burstIndex Which burst (0-5) in the superframe
 * @param status DSD status to update
 * @returns Array of up to 3 AMBE frames as Int8Array[4][24] (96 bytes flat)
 */
export function processDMRVoiceBurst(dibitBuf: Uint8Array, dibitPos: number, _burstIndex: number, _status: DSDStatus): Int8Array[] {
	const frames: Int8Array[] = [];

	// Extract 3 AMBE frames from this burst
	// Each AMBE frame uses 36 dibits with interleaving
	for (let frameIdx = 0; frameIdx < 3; frameIdx++) {
		const ambe_fr = new Int8Array(96); // 4x24 flat

		for (let i = 0; i < 36; i++) {
			// Calculate position in the burst
			// Burst layout: 54 dibits | 12 CACH | 54 dibits
			let pos: number;
			const linearPos = frameIdx * 36 + i;

			if (linearPos < 54) {
				pos = dibitPos + linearPos;
			} else {
				// Skip the 12 CACH dibits
				pos = dibitPos + linearPos + 12;
			}

			const dibit = dibitBuf[pos] & 3;
			const bit1 = (dibit >> 1) & 1;
			const bit0 = dibit & 1;

			// Deinterleave using DMR schedule
			const w = DMR_W[i];
			const x = DMR_X[i];
			const y = DMR_Y[i];
			const z = DMR_Z[i];

			ambe_fr[w * 24 + x] = bit1;
			ambe_fr[y * 24 + z] = bit0;
		}

		frames.push(ambe_fr);
	}

	return frames;
}

/**
 * Process a complete DMR voice superframe (6 bursts = 18 AMBE frames).
 *
 * @param dibitBuf Dibit buffer
 * @param dibitPos Position at start of first burst
 * @param status DSD status to update
 * @returns Array of all AMBE frames extracted
 */
export function processDMRVoice(dibitBuf: Uint8Array, dibitPos: number, status: DSDStatus): Int8Array[] {
	const allFrames: Int8Array[] = [];
	let pos = dibitPos;

	// The first burst is special - sync word was already consumed
	// Subsequent bursts: 54 + 12(CACH) + 54 + 24(sync) = 144 dibits each

	for (let burst = 0; burst < 6; burst++) {
		const frames = processDMRVoiceBurst(dibitBuf, pos, burst, status);
		allFrames.push(...frames);

		// Skip to next burst: 54 + 12 + 54 = 120 payload dibits + 24 sync dibits
		pos += 120 + 24;
	}

	return allFrames;
}

/**
 * Process a single DMR voice burst.
 * Called per-burst from the main decoder state machine.
 *
 * @param dibitBuf Dibit buffer
 * @param dibitPos Start of the 108 payload dibits (after sync consumed)
 * @param status DSD status to update
 * @returns Array of 3 AMBE frames
 */
export function processDMRSingleBurst(dibitBuf: Uint8Array, dibitPos: number, _status: DSDStatus): Int8Array[] {
	const frames: Int8Array[] = [];

	for (let frameIdx = 0; frameIdx < 3; frameIdx++) {
		const ambe_fr = new Int8Array(96); // 4x24 flat

		for (let i = 0; i < 36; i++) {
			const linearPos = frameIdx * 36 + i;
			const pos = dibitPos + linearPos;
			const dibit = dibitBuf[pos] & 3;
			const bit1 = (dibit >> 1) & 1;
			const bit0 = dibit & 1;

			ambe_fr[DMR_W[i] * 24 + DMR_X[i]] = bit1;
			ambe_fr[DMR_Y[i] * 24 + DMR_Z[i]] = bit0;
		}

		frames.push(ambe_fr);
	}

	return frames;
}

/**
 * Process DMR data burst (non-voice).
 * Data bursts don't produce audio.
 *
 * @param dibitBuf Dibit buffer
 * @param dibitPos Position at start of burst
 * @param status DSD status to update
 * @param slotIndex Which slot (0 or 1)
 */
export function processDMRData(dibitBuf: Uint8Array, dibitPos: number, status: DSDStatus, slotIndex: number): void {
	if (slotIndex === 0) {
		status.slot0Burst = 'Data';
	} else {
		status.slot1Burst = 'Data';
	}
}

/**
 * Try to detect color code from sync area.
 * @param dibitBuf Dibit buffer
 * @param syncPos Position of sync word start
 * @returns Color code (0-15) or -1
 */
export function detectDMRColorCode(dibitBuf: Uint8Array, syncPos: number): number {
	// Color code is embedded in the EMB (Embedded signaling)
	// For simplicity, extract from the CACH that precedes the sync
	// The CACH is 12 dibits before the burst sync
	const cachStart = syncPos - 12;
	if (cachStart < 0) return -1;
	return extractColorCode(dibitBuf, cachStart);
}

/** Number of dibits in a full DMR burst (payload only, no sync) */
export const DMR_BURST_DIBITS = 120; // 54 + 12(CACH) + 54

/** Number of dibits for sync word */
export const DMR_SYNC_DIBITS = 24;

/**
 * Check the sync/EMB word within a DMR voice superframe burst to detect
 * whether this burst carries voice or data. SDR++ Brown does this per-burst
 * and mutes audio for data bursts.
 *
 * The sync/EMB is 24 dibits. We collapse each dibit's polarity (positive → '1',
 * negative → '3') and compare against known sync patterns, matching the
 * SDR++ Brown convention: `(dibit | 1) + 48`.
 *
 * @param dibitBuf  Circular dibit buffer
 * @param syncPos   Position of the 24-dibit sync/EMB word in the buffer
 * @param mask      Circular buffer mask (0xFFFF)
 * @returns true if this burst is DATA (should mute), false if VOICE (decode)
 */
export function checkDMRBurstSync(dibitBuf: Uint8Array, syncPos: number, mask: number): boolean {
	// Build collapsed sync string: dibits 0,1 → '1'; dibits 2,3 → '3'
	let sync = '';
	for (let i = 0; i < 24; i++) {
		const d = dibitBuf[(syncPos + i) & mask] & 3;
		sync += String.fromCharCode((d | 1) + 48);
	}

	// Data sync patterns (any of these → mute this slot)
	if (
		sync === SYNC_WORDS.DMR_BS_DATA ||
		sync === SYNC_WORDS.DMR_MS_DATA ||
		sync === SYNC_WORDS.DMR_DM_TS1_DATA ||
		sync === SYNC_WORDS.DMR_DM_TS2_DATA
	) {
		return true; // DATA → mute
	}

	// Voice sync patterns or unrecognized EMB → don't mute
	return false;
}

/**
 * The DMR frames of the DSD stream: Voice LC headers and terminators for the call line (dmr-lc.ts), voice superframes
 * through mbelib, and every burst for the link layer (dmr/link.ts).
 */
export class DmrFrames {
	readonly link = new DmrLink();
	/** True until the first voice superframe is decoded after sync acquisition.
	 *  SDR++ Brown skips burst 0 frames 1+2 only for the very first superframe
	 *  because its history buffer uses 2-level data. Our buffer has full 4-level
	 *  data, so we only skip on the first frame to match the reference behavior. */
	private firstVoice = true;

	/** The signal was lost: the next voice superframe is a first one again, and calls in progress end. */
	restart(): void {
		this.firstVoice = true;
		this.link.lostSignal();
	}

	reset(): void {
		this.firstVoice = true;
		this.link.reset();
	}

	/** A complete DMR frame whose sync ended at f.afterSync. */
	process(f: DmrFrame, status: DSDStatus): void {
		if (f.voice) this.voiceFrame(f, status);
		else this.dataFrame(f, status);
		const late = this.link.lateCall;
		if (late) {
			this.link.lateCall = null;
			status.dmrCall = { ...late, colourCode: late.colourCode >= 0 ? late.colourCode : (status.colorCode ?? -1) };
		}
		if (this.link.info.events.length || Object.keys(this.link.info).length > 1) status.dmr = this.link.info;
	}

	/** Slot of the burst at `start`: the CACH of a base station when its TACT is clean, else what the sync search found. */
	private slotOf(f: DmrFrame, start: number, bs: boolean): number {
		const tc = bs ? this.link.cach(f.dibits, f.mask, start - 12) : -1;
		return tc >= 0 ? tc : f.slot;
	}

	private dataFrame(f: DmrFrame, status: DSDStatus): void {
		status.mbeDecoding = false;
		const startPos = f.afterSync & f.mask;
		const lc = decodeDmrLinkControl(f.dibits, startPos, f.mask);
		if (lc) {
			status.colorCode = lc.colourCode;
			status.dmrCall = { ...lc, slot: status.slot ?? 0, at: Date.now() };
		} else {
			const slot = slotType(f.dibits, startPos - 78, f.mask);
			if (slot.dataType === DMR_IDLE) status.colorCode = slot.colourCode;
		}
		const start = f.afterSync - 78;
		this.link.burst(f.dibits, f.symbols, f.mask, start, this.slotOf(f, start, f.bs), SYNC_BS_DATA);
	}

	/**
	 * The bursts of a voice superframe in air order for the link layer: ours (A..F) and the other slot's between them.
	 * Each burst: [12 CACH][54 first half][24 SYNC/EMB][54 second half] = 144 dibits; ours every 288.
	 */
	private linkSuperframe(f: DmrFrame): void {
		const start = f.afterSync - 78; // first dibit of burst A
		const slot = this.slotOf(f, start, f.bs);
		this.link.burst(f.dibits, f.symbols, f.mask, start, slot, SYNC_BS_VOICE);
		for (let n = 1; n <= 5; n++) {
			const other = start + 144 + (n - 1) * 288;
			if (f.bs) this.link.cach(f.dibits, f.mask, other - 12);
			this.link.burst(f.dibits, f.symbols, f.mask, other, slot ^ 1);
			if (f.bs) this.link.cach(f.dibits, f.mask, start + n * 288 - 12);
			this.link.burst(f.dibits, f.symbols, f.mask, start + n * 288, slot);
		}
	}

	private voiceFrame(f: DmrFrame, status: DSDStatus): void {
		this.linkSuperframe(f);
		if (!f.mbelibReady) {
			status.mbeDecoding = false;
			status.mbeErrors = '(mbelib not loaded)';
			return;
		}

		// ── DMR voice superframe extraction ──────────────────────────
		//
		// DMR is 2-slot TDMA. A voice superframe = 6 bursts on our slot.
		// Only burst 0 has the full sync word; bursts 1-5 use EMB.
		// We must read all 6 bursts at known positions.
		//
		// Each burst: [12 CACH][54 voice 1st half][24 SYNC/EMB][54 voice 2nd half] = 144 dibits
		// Between our-slot bursts: 144 dibits of the other slot (skip).
		//
		// startPos = right after the 24-dibit sync word of burst 0.
		//
		// Burst 0:
		//   1st half: startPos - 78 .. startPos - 25  (54 dibits, before sync)
		//   2nd half: startPos + 0  .. startPos + 53  (54 dibits, after sync)
		//   sync/EMB: startPos - 24 .. startPos - 1   (24 dibits, = the detected sync)
		//
		// Burst n (n=1..5):
		//   burstBase = startPos + 54 + 144 + (n-1)*288  = startPos + 198 + (n-1)*288
		//   CACH:      burstBase + 0  .. burstBase + 11   (12 dibits, skip)
		//   1st half:  burstBase + 12 .. burstBase + 65   (54 dibits)
		//   EMB:       burstBase + 66 .. burstBase + 89   (24 dibits, check for mute)
		//   2nd half:  burstBase + 90 .. burstBase + 143  (54 dibits)

		const mask = f.mask;
		const startPos = f.afterSync & mask;
		status.mbeDecoding = true;
		let errBar = '';

		// Helper: extract 108 voice dibits from a burst and decode 3 AMBE frames
		const decodeBurst = (v1Start: number, v2Start: number, skipFrames12: boolean) => {
			const voiceBuf = new Uint8Array(108);
			for (let i = 0; i < 54; i++) {
				voiceBuf[i] = f.dibits[(v1Start + i) & mask];
				voiceBuf[54 + i] = f.dibits[(v2Start + i) & mask];
			}

			const ambeFrames = processDMRSingleBurst(voiceBuf, 0, status);
			for (let fi = 0; fi < ambeFrames.length; fi++) {
				// SDR++ Brown: skip frames 1+2 of the first burst (firstframe logic)
				// because data before the initial sync detection may be invalid
				if (skipFrames12 && fi < 2) {
					errBar += 's'; // skipped
					continue;
				}
				try {
					f.audio(decodeAmbe(ambeFrames[fi]));
					status.voiceFrameCount = (status.voiceFrameCount || 0) + 1;
					errBar += getMbeErrors() > 0 ? 'E' : '=';
				} catch (_e) {
					errBar += 'X';
				}
			}
		};

		// Burst 0: voice data straddles the sync word.
		// SDR++ Brown skips frames 1+2 only on the very first superframe after
		// carrier detect (firstframe flag), because its history buffer uses 2-level
		// quantized data. Our dibit buffer has full 4-level data, so we only need
		// to skip on the actual first frame after acquisition.
		const skipBurst0 = this.firstVoice;
		this.firstVoice = false;
		decodeBurst(startPos - 78, startPos, skipBurst0);

		// Bursts 1-5: at known offsets after burst 0
		for (let n = 1; n <= 5; n++) {
			const burstBase = startPos + 54 + 144 + (n - 1) * 288; // = startPos + 198 + (n-1)*288
			const v1Start = burstBase + 12; // skip 12 CACH
			const embPos = burstBase + 66; // EMB/sync position
			const v2Start = burstBase + 90; // skip 12 CACH + 54 voice1 + 24 EMB

			// SDR++ Brown: check the EMB/sync word for each burst.
			// If it indicates DATA, mute this burst's audio output.
			const isMuted = checkDMRBurstSync(f.dibits, embPos, mask);
			if (isMuted) {
				errBar += 'MMM'; // 3 muted frames
				continue;
			}

			decodeBurst(v1Start, v2Start, /* skipFrames12 */ false);
		}

		status.mbeErrors = errBar;
	}
}
