import type { DSDMode, DSDStatus, DpmrStatus, DsdChain, DsdSink } from './types';
/*
 * Main DSD (Digital Speech Decoder) state machine.
 * Handles frame sync detection and dispatches to mode-specific processors.
 * Ported from SDR++ Brown dsd.h / dsd_demod.cpp.
 *
 * Yaesu System Fusion frames are handed to ysf/, and dPMR runs beside the 4800 symbols/s chain in dpmr/
 * (both ported from OnAir, GPL-3.0-or-later, see third_party/onair). P25 Phase 2 runs on the complex channel in p25p2/
 * (ported from OnAir as well).
 */

import { FIRFilter, ClockRecovery, FourFSKSlicer, rrcTaps } from './dsd-dsp';
import { DSD_IF_RATE, DSD_SYMBOL_RATE, RRC_ALPHA, RRC_NUM_TAPS } from './constants';
import { SyncType } from './types';
import { syncTypeToMode, syncTypeLabel, isVoiceSync, matchSync, lastMatchErrors } from './sync';
import { DmrFrames } from './dsd-dmr';
import { DSTAR_FRAME_DIBITS } from './dsd-dstar';
import { DstarCalls } from './dstar/call';
import { NxdnReceiver } from './nxdn/receiver';
import { NXDN96_READ } from './nxdn/proto';
import { processP25Frame, P25_NID_DIBITS, P25_LDU_BODY_DIBITS } from './dsd-p25';
import { readYsfFrame } from './ysf/frame';
import { YSF_FRAME_DIBITS, YSF_SYNC_DIBITS } from './ysf/proto';
import { YsfCall, decodeYsfVoice } from './ysf/receiver';
import { DpmrReceiver } from './dpmr/receiver';
import { M17Receiver } from './m17/receiver';
import type { M17Frame } from './m17/types';
import { decodeM17Voice, ensureM17Codec2, m17Codec2Ready, resetM17Voice } from './m17/codec2';
import { P25p2Receiver } from './p25p2/receiver';
import { ambeFrame } from './ambe';
import { decodeAmbe, decodeImbe, ensureMbelibInitialized, getMbeErrors, resetMbe } from '@/worker/decoders/mbelib-init';

/** Nominal slicer levels of the four dibits, for dibits fed without their symbol value. */
const DIBIT_LEVELS = [1, 3, -1, -3];
const BUF_MASK = 0xffff;

// ── Main DSD Decoder ─────────────────────────────────────────────────

/**
 * DSD Decoder class.
 * Processes FM-demodulated audio at DSD_IF_RATE and outputs decoded voice.
 */
export class DSDDecoder {
	// DSP chain
	private rrcFilter: FIRFilter;
	private clockRecovery: ClockRecovery;
	private slicer: FourFSKSlicer;
	/** Converts a symbol value (discriminator radians through the RRC filter) to Hz. */
	private hzPerUnit: number;

	// State
	private dibitHistory: string = '';
	private dibitBuf = new Uint8Array(BUF_MASK + 1);
	/** Symbol values beside dibitBuf, for protocols that fit their own levels (Fusion, D-STAR, NXDN96, P25). */
	private symbolBuf = new Float32Array(BUF_MASK + 1);
	/** The RRC filter output and each dibit's time in it, for frames that are re-sampled (NXDN96, P25). */
	private timeBuf = new Float64Array(BUF_MASK + 1);
	private rrcBuf = new Float32Array(BUF_MASK + 1);
	private rrcN = 0;
	private chain: DsdChain = { dibits: this.dibitBuf, symbols: this.symbolBuf, times: this.timeBuf, samples: this.rrcBuf, mask: BUF_MASK };
	/** D-STAR, NXDN and P25 Phase 1 frames (ported from OnAir, see dstar/, nxdn/, p25/). */
	private dstar = new DstarCalls(this.sink('dstar', decodeAmbe));
	/** NXDN48 runs beside the chain at 2400 symbols/s, like dPMR; NXDN96 frames come from the chain. */
	private nxdn = new NxdnReceiver(this.sink('nxdn', decodeAmbe));
	private dibitBufPos = 0;
	private currentSync: SyncType = SyncType.NONE;
	private synced = false;
	private mbelibReady = false;
	private samplesSinceSync = 0;
	private candidateMode: DSDMode = 'unknown';
	private candidatePosition = -1;
	private ysf = new YsfCall();
	/** dPMR at 2400 symbols/s on the same discriminator output, and its voice frames of the current chunk. */
	private dpmr: DpmrReceiver;
	private dpmrVoice: Uint8Array[] = [];
	private dpmrResting = false;
	private m17: M17Receiver;
	private m17CodecPending = false;
	/** P25 Phase 2 (H-DQPSK at 6000 symbols/s) on the complex channel, beside the 4800 symbols/s chain. */
	private p25p2 = new P25p2Receiver({
		status: () => this.status,
		synced: () => this.announceSync('p25p2', SyncType.P25P2),
		voice: (frames) => this.decodeVoice(frames, decodeAmbe),
	});

	/** Count of consecutive syncs for the current mode — used for mode locking */
	private modeLockCount = 0;
	/** Locked mode: once we see 3+ consecutive syncs of the same mode, lock to it */
	private lockedMode: DSDMode = 'unknown';

	/** Last DMR DATA sync position — used for TDMA timing validation of voice syncs */
	private dmrLastDataSyncPos = -1;
	/** DMR frames: call line, voice superframes and the link layer (dsd-dmr.ts, dmr/). */
	private dmr = new DmrFrames();

	// Audio output accumulator
	private audioAccum: Float32Array;
	private audioAccumLen = 0;

	// Callbacks
	private onAudio: (samples: Float32Array) => void;
	private onStatus: (status: DSDStatus) => void;

	// Status
	private status: DSDStatus = {
		mode: 'unknown',
		synced: false,
		mbelibLoaded: false,
		voiceFrameCount: 0,
	};

	// Resampler: 8000 → 48000 Hz (handled externally, but we provide 8kHz)
	private mbeInitPromise: Promise<void> | null = null;

	constructor(onAudio: (samples: Float32Array) => void, onStatus: (status: DSDStatus) => void) {
		this.onAudio = onAudio;
		this.onStatus = onStatus;

		// Build RRC filter taps
		const taps = rrcTaps(RRC_NUM_TAPS, DSD_IF_RATE, DSD_SYMBOL_RATE, RRC_ALPHA);
		this.rrcFilter = new FIRFilter(taps);
		this.hzPerUnit = DSD_IF_RATE / (2 * Math.PI * taps.reduce((sum, tap) => sum + tap, 0));

		// Clock recovery: 48000 Hz → 4800 sym/s
		this.clockRecovery = new ClockRecovery(DSD_IF_RATE, DSD_SYMBOL_RATE);

		// 4-FSK slicer
		this.slicer = new FourFSKSlicer();

		// Audio accumulator
		this.audioAccum = new Float32Array(8000); // 1 second at 8 kHz

		this.dpmr = new DpmrReceiver({
			update: (status, sync) => this.onDpmr(status, sync),
			callStart: () => {
				this.flushDpmrVoice();
				if (this.mbelibReady) resetMbe();
			},
			voice: (bits) => {
				if (this.acceptsDpmr()) this.dpmrVoice.push(bits);
			},
		});
		this.m17 = new M17Receiver((frame) => this.onM17Frame(frame));

		// Start mbelib initialization
		this.mbeInitPromise = ensureMbelibInitialized()
			.then(() => {
				this.mbelibReady = true;
				this.status.mbelibLoaded = true;
				this.onStatus({ ...this.status });
				console.log('DSD: mbelib WASM loaded — voice decoding enabled');
			})
			.catch((err) => {
				this.status.mbelibLoaded = false;
				this.status.mbelibError = 'Voice decoder unavailable';
				this.onStatus({ ...this.status });
				console.warn('DSD: mbelib WASM not available — run wasm/mbelib/build.sh to enable voice decoding. Error:', err);
			});
	}

	/**
	 * Process a chunk of FM-demodulated audio at DSD_IF_RATE (48000 Hz).
	 * Decoded voice audio (8 kHz) is emitted via the onAudio callback.
	 */
	private _dbgProcessCalls = 0;
	private _dbgSyncCount = 0;
	private _dbgFrameCount = 0;
	private _dbgAudioEmits = 0;
	private _dbgLastLog = 0;

	/** iq: the complex channel at DSD_IF_RATE (interleaved), for P25 Phase 2. */
	process(fmAudio: Float32Array, iq?: Float32Array): void {
		this._dbgProcessCalls++;
		this.samplesSinceSync += fmAudio.length;
		if (this.status.synced && this.samplesSinceSync > DSD_IF_RATE) this.expireSync();

		// dPMR and NXDN48 (2400 symbols/s) have their own symbol filters and sync searches; they rest while another protocol holds the lock
		if (!this.acceptsDpmr()) this.dpmrResting = true;
		else {
			if (this.dpmrResting) this.dpmr.reset();
			this.dpmrResting = false;
			this.dpmr.process(fmAudio);
		}
		this.nxdn.process(fmAudio, this.acceptsDpmr());
		if (this.flushDpmrVoice()) this.onStatus({ ...this.status });
		if (this.p25p2.process(iq, this.lockedMode)) this.onStatus({ ...this.status });

		// Step 1: RRC filter
		const filtered = new Float32Array(fmAudio.length);
		this.rrcFilter.process(fmAudio, filtered);
		for (const v of filtered) this.rrcBuf[this.rrcN++ & BUF_MASK] = v;

		// Step 2: Clock recovery (extract symbols at 4800 sym/s)
		this.clockRecovery.process(filtered);
		const numSymbols = this.clockRecovery.symbolCount;
		if (numSymbols === 0) return;

		// Step 3: Slice to dibits
		const dibits = new Uint8Array(numSymbols);
		this.slicer.process(this.clockRecovery.symbolBuf, dibits, numSymbols);

		// Step 4: Feed dibits to frame sync + decoder
		for (let i = 0; i < numSymbols; i++) {
			const symbol = this.clockRecovery.symbolBuf[i] * this.hzPerUnit;
			this.timeBuf[this.dibitBufPos & BUF_MASK] = this.clockRecovery.timeBuf[i];
			this.m17.feed(symbol);
			if (!this.m17.locked) this.feedDibit(dibits[i], symbol);
		}

		// Emit accumulated audio
		if (this.audioAccumLen > 0) {
			this._dbgAudioEmits++;
			this.onAudio(this.audioAccum.subarray(0, this.audioAccumLen).slice());
			this.audioAccumLen = 0;
		}

		// Periodic debug summary every 2 seconds
		const now = performance.now();
		if (import.meta.env.DEV && now - this._dbgLastLog > 2000) {
			console.log(
				`[DSD-dec] stats: process() calls=${this._dbgProcessCalls}, syncs=${this._dbgSyncCount}, frames=${this._dbgFrameCount}, audioEmits=${this._dbgAudioEmits}, synced=${this.synced}, mode=${this.status.mode}, mbelib=${this.mbelibReady}, fmIn=${fmAudio.length}, symbols=${numSymbols}`,
			);
			this._dbgLastLog = now;
		}
	}

	/** No sync for a second: the carrier has gone. */
	private expireSync(): void {
		this.synced = false;
		this.lockedMode = 'unknown';
		this.modeLockCount = 0;
		this.dmrLastDataSyncPos = -1;
		this.dmr.restart();
		this.candidateMode = 'unknown';
		this.candidatePosition = -1;
		this.frameDataRemaining = 0;
		this.audioAccumLen = 0;
		this.ysf.reset();
		this.m17.reset();
		this.status = {
			mode: 'unknown',
			synced: false,
			mbelibLoaded: this.mbelibReady,
			mbelibError: this.status.mbelibError,
			voiceFrameCount: this.status.voiceFrameCount,
			mbeDecoding: false,
			dmr: this.status.dmr,
			dstar: this.status.dstar,
			nxdn: this.status.nxdn,
		};
		this.status.syncCount = this._dbgSyncCount;
		this.status.lastSyncName = this.lastSyncName;
		if (this.mbelibReady) resetMbe();
		this.onStatus({ ...this.status });
	}

	/**
	 * Feed a single dibit into the decoder state machine.
	 * @param symbol the symbol's value in Hz (nominal levels when only dibits are known)
	 */
	private feedDibit(dibit: number, symbol = DIBIT_LEVELS[dibit & 3] * 900): void {
		// Store in circular dibit buffer
		this.dibitBuf[this.dibitBufPos & BUF_MASK] = dibit;
		this.symbolBuf[this.dibitBufPos & BUF_MASK] = symbol;
		this.dibitBufPos++;

		// Build history string for sync matching
		this.dibitHistory += dibit.toString();

		// Keep history at reasonable length
		if (this.dibitHistory.length > 48) {
			this.dibitHistory = this.dibitHistory.slice(-48);
		}

		if (this.synced) {
			// Already synced: process frame data
			this.processFrameData();
		} else {
			// Searching for sync
			this.searchFrameSync();
		}
	}

	/**
	 * Search for frame sync pattern in recent dibit history.
	 */
	private _lastSyncTime = 0;
	private lastSyncName: string | undefined;

	private searchFrameSync(): void {
		if (this.dibitHistory.length < 18) return; // Need at least NXDN sync length

		// Unlock mode if no sync found for 2 seconds (signal may have changed)
		if (this.lockedMode !== 'unknown') {
			const now = performance.now();
			if (now - this._lastSyncTime > 2000) {
				console.log(`[DSD-dec] mode unlock: ${this.lockedMode} → unknown (no sync for 2s)`);
				this.lockedMode = 'unknown';
				this.modeLockCount = 0;
				this.dmrLastDataSyncPos = -1;
				this.dmr.restart();
			}
		}

		// Use locked mode to suppress false positives from other protocols
		const effectiveMode = this.lockedMode !== 'unknown' ? this.lockedMode : this.status.mode;
		const syncType = matchSync(this.dibitHistory, effectiveMode);
		if (syncType === SyncType.NONE) return;
		const mode = syncTypeToMode(syncType);
		if (!this.validateProtocolSync(mode, syncType)) return;
		// A Fusion sync is announced once the FICH that follows it checks (processYSFFrame), an NXDN96 sync with a LICH
		// other than DSD's once a channel of its frame checks (nxdn/).
		if (mode !== 'ysf' && syncType !== SyncType.NXDN96 && syncType !== SyncType.INV_NXDN96) this.announceSync(mode, syncType);

		// Reset dibit position for frame processing
		this.frameDataRemaining = this.getFrameLength(syncType);
		this.frameDataRead = 0;
		this.frameStart = this.dibitBufPos;

		this.dibitHistory = '';
	}

	/** A confirmed sync: count it, lock the mode and publish the status. */
	private announceSync(mode: DSDMode, syncType: SyncType): void {
		this._dbgSyncCount++;
		this._lastSyncTime = performance.now();
		this.samplesSinceSync = 0;
		if (mode === this.status.mode) {
			this.modeLockCount++;
		} else {
			this.modeLockCount = 1;
		}
		// Lock after 3 consecutive syncs of the same mode
		if (this.modeLockCount >= 3) {
			this.lockedMode = mode;
		}

		// Track DMR DATA sync positions for TDMA timing reference
		if (mode === 'dmr' && !isVoiceSync(syncType)) {
			this.dmrLastDataSyncPos = this.dibitBufPos;
		}

		this.status.mode = mode;
		this.status.synced = true;
		this.status.syncName = syncTypeLabel(syncType);
		this.lastSyncName = this.status.syncName;
		this.status.lastSyncName = this.lastSyncName;
		this.status.syncCount = this._dbgSyncCount;
		this.status.mbelibLoaded = this.mbelibReady;
		this.status.mbeDecoding = false;
		this.status.mbeErrors = undefined;
		if (mode === 'dmr') {
			this.status.slot =
				syncType === SyncType.DMR_DM_TS1_DATA || syncType === SyncType.DMR_DM_TS1_VOICE
					? 0
					: syncType === SyncType.DMR_DM_TS2_DATA || syncType === SyncType.DMR_DM_TS2_VOICE
						? 1
						: (this.dibitBuf[(this.dibitBufPos - 88) & BUF_MASK] >> 1) & 1;
			const burst = isVoiceSync(syncType) ? 'VOICE' : 'DATA';
			if (this.status.slot === 0) this.status.slot0Burst = burst;
			else this.status.slot1Burst = burst;
		}
		this.onStatus({ ...this.status });
	}

	private frameDataRemaining = 0;
	private frameDataRead = 0;
	private frameStart = 0;

	/**
	 * Process dibits that are part of a frame (after sync was found).
	 */
	private processFrameData(): void {
		this.frameDataRead++;
		if (--this.frameDataRemaining > 0) return;
		// Frame complete: process it; D-STAR and P25 may ask for more before the next sync
		this.frameDataRemaining = this.processCompleteFrame();
		if (this.frameDataRemaining > 0) return;
		this.synced = false;
		this.dibitHistory = '';
	}

	/**
	 * Process a complete frame based on the sync type.
	 */
	private processCompleteFrame(): number {
		this._dbgFrameCount++;
		const syncType = this.currentSync;
		const mode = syncTypeToMode(syncType);
		const startPos = this.frameStart & BUF_MASK;
		let more = 0;

		switch (mode) {
			case 'dmr':
				this.dmr.process(
					{
						dibits: this.dibitBuf,
						symbols: this.symbolBuf,
						mask: BUF_MASK,
						afterSync: this.frameStart,
						voice: isVoiceSync(syncType),
						bs: syncType === SyncType.DMR_BS_DATA || syncType === SyncType.DMR_BS_VOICE,
						slot: this.status.slot ?? 0,
						mbelibReady: this.mbelibReady,
						audio: (samples) => this.appendAudio(samples),
					},
					this.status,
				);
				break;
			case 'p25':
				processP25Frame(this.dibitBuf, startPos, this.status, this.sink('p25', decodeImbe));
				break;
			case 'dstar':
				more = this.dstar.frame(this.chain, syncType, this.frameStart, this.frameDataRead);
				break;
			case 'nxdn':
				this.nxdn.frame96(this.chain, this.frameStart, syncType);
				break;
			case 'ysf':
				this.processYSFFrame(syncType);
				break;
		}

		this.onStatus({ ...this.status });
		return more;
	}

	// ── Mode-specific frame processing ─────────────────────────────

	/** The decoder's side of D-STAR, NXDN and P25 Phase 1: the status, voice, codec reset and a sync to count. */
	private sink(mode: DSDMode, decode: (frame: Int8Array) => Float32Array): DsdSink {
		return {
			status: () => this.status,
			voice: (frames) => this.decodeVoice(frames, decode),
			reset: () => this.mbelibReady && resetMbe(),
			synced: (sync) => this.announceSync(mode, sync),
		};
	}

	/** Decode voice frames through mbelib into the audio output and the error bar. */
	private decodeVoice<T>(frames: readonly T[], decode: (frame: T) => Float32Array): void {
		if (!this.mbelibReady) {
			this.status.mbeDecoding = false;
			this.status.mbeErrors = '(mbelib not loaded)';
			return;
		}
		this.status.mbeDecoding = true;
		let errBar = '';
		for (const frame of frames) {
			try {
				this.appendAudio(decode(frame));
				this.status.voiceFrameCount = (this.status.voiceFrameCount || 0) + 1;
				errBar += getMbeErrors() > 0 ? 'E' : '=';
			} catch (_e) {
				errBar += 'X';
			}
		}
		this.status.mbeErrors = errBar;
	}

	/** A Fusion frame: levels fitted from its sync, FICH checked, then callsigns, data and voice (ysf/). */
	private processYSFFrame(syncType: SyncType): void {
		const values = new Float32Array(YSF_FRAME_DIBITS);
		const first = this.frameStart - YSF_SYNC_DIBITS;
		for (let i = 0; i < YSF_FRAME_DIBITS; i++) values[i] = this.symbolBuf[(first + i) & BUF_MASK];
		const read = readYsfFrame(values, !(this.status.synced && this.status.mode === 'ysf'));
		if (!read) return;
		this.announceSync('ysf', syncType);
		const voice = this.ysf.onFrame(read);
		this.status.ysf = this.ysf.status;
		if (voice.length) this.decodeVoice(voice, decodeYsfVoice);
		if (read.content.fich.fi === 2 && this.mbelibReady) resetMbe();
	}

	/** dPMR results count unless a 4800 symbols/s protocol holds the lock (NXDN's short sync gives way). */
	private acceptsDpmr(): boolean {
		return this.lockedMode === 'unknown' || this.lockedMode === 'dpmr' || this.lockedMode === 'nxdn';
	}

	/** A dPMR block that checked, or the end of a dPMR transmission. */
	private onDpmr(status: DpmrStatus, sync: SyncType): void {
		if (!this.acceptsDpmr()) return;
		if (this.lockedMode === 'nxdn') this.lockedMode = 'unknown';
		this.status.dpmr = status;
		this.flushDpmrVoice();
		if (status.ended && this.mbelibReady) resetMbe();
		this.announceSync('dpmr', sync);
	}

	/** Decode the dPMR voice frames received so far; true when there were any. */
	private flushDpmrVoice(): boolean {
		if (!this.dpmrVoice.length) return false;
		this.decodeVoice(this.dpmrVoice.splice(0), (bits) => decodeAmbe(ambeFrame(bits)));
		return true;
	}

	private onM17Frame(frame: M17Frame): void {
		if (!this.m17CodecPending && !m17Codec2Ready()) {
			this.m17CodecPending = true;
			void ensureM17Codec2()
				.then(() => {
					this.m17.setCodecReady(true);
					if (this.status.mode === 'm17' && this.status.m17) {
						this.status.m17.codecReady = true;
						this.onStatus({ ...this.status });
					}
				})
				.catch((error) => console.warn('M17 Codec2 unavailable:', error))
				.finally(() => {
					this.m17CodecPending = false;
				});
		}
		this.lockedMode = frame.status.ended ? 'unknown' : 'm17';
		this.frameDataRemaining = 0;
		this.status.mode = 'm17';
		this.status.synced = !frame.status.ended;
		this.synced = !frame.status.ended;
		this.status.syncName = 'M17 ' + frame.status.kind;
		this.status.lastSyncName = this.status.syncName;
		this.status.m17 = frame.status;
		this.status.mbeDecoding = false;
		this.status.mbeErrors = undefined;
		this.status.syncCount = (this.status.syncCount || 0) + 1;
		this.status.voiceFrameCount = frame.status.voiceFrames;
		this.samplesSinceSync = 0;
		if (frame.status.ended) resetM17Voice();
		if (frame.voice && m17Codec2Ready()) {
			try {
				this.appendAudio(decodeM17Voice(frame.voice.payload, frame.voice.rate));
				this.status.mbeDecoding = true;
			} catch (error) {
				console.warn('M17 voice frame failed:', error);
			}
		}
		this.onStatus({ ...this.status });
	}

	// ── Audio output ────────────────────────────────────────────────

	/**
	 * Append decoded MBE audio (160 samples @ 8 kHz) to the accumulator.
	 */
	private appendAudio(audio: Float32Array): void {
		if (this.audioAccumLen + audio.length > this.audioAccum.length) {
			// Flush current accumulator
			this.onAudio(this.audioAccum.subarray(0, this.audioAccumLen).slice());
			this.audioAccumLen = 0;
		}
		this.audioAccum.set(audio, this.audioAccumLen);
		this.audioAccumLen += audio.length;
	}

	// ── Frame length calculation ────────────────────────────────────

	/**
	 * Get the expected frame length in dibits for the given sync type.
	 */
	private getFrameLength(syncType: SyncType): number {
		const mode = syncTypeToMode(syncType);
		switch (mode) {
			case 'dmr':
				if (isVoiceSync(syncType)) {
					// DMR voice superframe = 6 bursts. Only burst 0 has the full sync word.
					// Bursts 1-5 use EMB instead — we must read them at known positions.
					// Layout after sync detection point (= right after sync word):
					//   Burst 0 2nd half: 54 dibits
					//   Then 5 × (144 other-slot + 144 our-slot) = 1440 dibits
					// Total: 54 + 1440 = 1494 dibits
					return 1494;
				}
				// DATA burst: skip 2nd half (54) + other slot CACH (12) + other slot 1st half (54)
				// Matches SDR++ Brown's skipDibit(120) after data — avoids false syncs in other slot's data
				return 120;
			case 'p25':
				return P25_NID_DIBITS + P25_LDU_BODY_DIBITS; // ~752 dibits
			case 'dstar':
				return isVoiceSync(syncType)
					? DSTAR_FRAME_DIBITS // 72 voice + 24 slow-data GMSK symbols
					: 660; // Header: 660 one-bit GMSK symbols
			case 'nxdn':
				return NXDN96_READ; // SACCH / CAC and the two halves after the FSW and LICH
			case 'ysf':
				return YSF_FRAME_DIBITS - YSF_SYNC_DIBITS; // FICH 100 + payload 360 dibits
			default:
				return 120;
		}
	}

	/**
	 * Reset the decoder state.
	 */
	reset(): void {
		this.rrcFilter.reset();
		this.clockRecovery.reset();
		this.rrcN = 0;
		this.slicer.reset();
		this.dibitHistory = '';
		this.dibitBufPos = 0;
		this.dibitBuf.fill(0);
		this.symbolBuf.fill(0);
		this.synced = false;
		this.candidateMode = 'unknown';
		this.candidatePosition = -1;
		this.samplesSinceSync = 0;
		this.currentSync = SyncType.NONE;
		this.frameDataRemaining = 0;
		this.frameDataRead = 0;
		this.audioAccumLen = 0;
		this.ysf.reset();
		this.m17.reset();
		this.dpmr.reset();
		this.dpmrVoice.length = 0;
		this.p25p2.reset();
		this.dstar.reset();
		this.nxdn.reset();
		this.status = {
			mode: 'unknown',
			synced: false,
			mbelibLoaded: this.mbelibReady,
			mbelibError: this.status.mbelibError,
			voiceFrameCount: 0,
		};
		this._dbgSyncCount = 0;
		this._dbgFrameCount = 0;
		this._dbgAudioEmits = 0;
		this.lastSyncName = undefined;
		this.lockedMode = 'unknown';
		this.modeLockCount = 0;
		this._lastSyncTime = 0;
		this.dmrLastDataSyncPos = -1;
		this.dmr.reset();
		if (this.mbelibReady) resetMbe();
		this.onStatus(this.status);
	}

	private validateProtocolSync(mode: DSDMode, syncType: SyncType): boolean {
		// A single polarity match in noise is insufficient for acquisition.
		// Confirm DMR on its TDMA grid (including the 6-burst voice cycle),
		// and NXDN on its 192-dibit frame grid before decoding any speech.
		if (!this.status.synced && (mode === 'dmr' || mode === 'nxdn')) {
			const spacing = mode === 'dmr' ? 144 : 192;
			const distance = this.dibitBufPos - this.candidatePosition;
			const frames = Math.round(distance / spacing);
			const confirmed =
				this.candidateMode === mode && frames >= 1 && frames <= (mode === 'dmr' ? 12 : 2) && Math.abs(distance - frames * spacing) <= 2;
			if (!confirmed) {
				this.candidateMode = mode;
				this.candidatePosition = this.dibitBufPos;
				return false;
			}
		}

		// Mode locking: if we've locked to a mode, reject syncs from other protocols
		if (this.lockedMode !== 'unknown' && mode !== this.lockedMode) {
			// Exception: 24-dibit syncs (DMR, P25, D-STAR) and Fusion syncs (checked by their FICH)
			// override NXDN (18-dibit) locks. NXDN's shorter sync word is far more prone to false
			// positives on DMR idle channels, so a longer match is inherently more trustworthy.
			if (this.lockedMode === 'nxdn' && mode !== 'nxdn') {
				console.log(`[DSD-dec] NXDN lock overridden by ${mode} (24-dibit sync is more reliable)`);
				this.lockedMode = 'unknown';
				this.modeLockCount = 0;
			} else {
				// Reject — this is likely a false positive
				return false;
			}
		}

		// DMR VOICE TDMA validation: reject voice syncs that don't align with
		// the established TDMA frame timing. False voice matches at random
		// positions trigger 1494-dibit superframe reads producing garbled audio.
		// Threshold scales with distance to tolerate clock drift (~1-2 dibits per timeslot).
		if (mode === 'dmr' && isVoiceSync(syncType) && this.dmrLastDataSyncPos >= 0 && this.modeLockCount >= 5) {
			const dist = this.dibitBufPos - this.dmrLastDataSyncPos;
			const timeslots = Math.round(dist / 144);
			if (timeslots > 0) {
				const expected = timeslots * 144;
				const residual = Math.abs(dist - expected);
				// Allow 2 dibits of clock drift per timeslot, minimum 12
				const threshold = Math.max(12, timeslots * 2);
				if (residual > threshold) {
					console.log(
						`[DSD-dec] DMR VOICE rejected: TDMA misaligned (dist=${dist}, expected=${expected}, residual=${residual}, threshold=${threshold}, errors=${lastMatchErrors()})`,
					);
					return false;
				}
			}
		}

		// Read the frame; announceSync counts it once it is confirmed.
		this.currentSync = syncType;
		this.synced = true;
		return true;
	}
}
