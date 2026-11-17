// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/p25p2/p25p2_rx.cpp (P25p2Receiver: processBurst after the ISCH,
// applySystem, setSystem, setListenSlot, resetState, report) and core/include/dect2/p25p2/p25p2_rx.h,
// https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the receiver runs beside the 4800 symbols/s chain of BrowSDR's DSD decoder on the complex channel at 48 kHz and
// rests while another protocol holds the decoder's lock; it reports to the decoder (P25p2Events) on every sync word on
// the grid of its lock and hands the voice of the played slot to the decoder's mbelib, resetting mbelib at call
// boundaries; a scrambled SACCH / FACCH that does not decode is used to solve the descrambler seed (seed.ts) unless one
// was set; the bursts of the two "not scrambled" DUIDs are read as sent, as in OnAir.
//
// APCO Project 25 Phase 2 receiver (TIA-102.BBAB / BBAC): TDMA, two time slots, 6000 symbols/s differential QPSK in
// 12.5 kHz. Receive only. Per burst: the ISCH (demod.ts), the DUID, the descrambling, then 4V / 2V voice bursts (AMBE+2
// half-rate frames and the encryption sync, ESS) or SACCH / FACCH MAC PDUs (Reed-Solomon + CRC: PTT, END_PTT, ACTIVE,
// IDLE and the TSBK-equivalent messages).
import type { DSDMode } from '@/worker/decoders/dsd/types';
import { isMbelibReady, resetMbe } from '@/worker/decoders/mbelib-init';
import { P25p2Calls } from './calls';
import { P25p2Demod } from './demod';
import { P25p2MacLayer } from './mac';
import {
	DUID_2V,
	DUID_4V,
	DUID_FACCH,
	DUID_FACCH_CLEAR,
	DUID_LCCH,
	DUID_SACCH,
	DUID_SACCH_CLEAR,
	FACCH_AIR_BYTES,
	P25P2_BURST_DIBITS,
	P25P2_VOICE_OFFSETS,
	SACCH_AIR_BYTES,
	SLOTS_PER_SUPERFRAME,
	macDecodeAir,
	p25p2AmbeFrame,
	p25p2Descramble,
	p25p2Duid,
	p25p2Scramble,
	payloadGet,
} from './protocol';
import { P25p2SeedSolver } from './seed';
import type { P25p2BurstSink, P25p2Counters, P25p2Events, P25p2MacPdu, P25p2Seed, P25p2SeedSource, P25p2Status } from './types';

function newCounters(): P25p2Counters {
	return {
		syncs: 0,
		slots: 0,
		slotsBad: 0,
		ischBad: 0,
		ischExact: 0,
		ischCorrected: 0,
		slotsSkipped: 0,
		unlocks: 0,
		realigns: 0,
		duidBad: 0,
		v4: 0,
		v2: 0,
		sacch: 0,
		facch: 0,
		macOk: 0,
		macBad: 0,
		rsCorrected: 0,
		essOk: 0,
		essBad: 0,
		essReused: 0,
		voiceFrames: 0,
		voiceDecoded: 0,
		encryptedSkipped: 0,
		unknownSkipped: 0,
		seedsRecovered: 0,
	};
}

/** P25 Phase 2 voice channel receiver of BrowSDR's DSD decoder. */
export class P25p2Receiver implements P25p2BurstSink {
	readonly counters = newCounters();
	private demod = new P25p2Demod(this, this.counters);
	private calls: P25p2Calls;
	private mac: P25p2MacLayer;
	/** The descrambler: dibit i of the burst in slot s is XORed with seq[s * 180 + i] (all 0: not descrambled). */
	private seq: Uint8Array = new Uint8Array(10 + SLOTS_PER_SUPERFRAME * P25P2_BURST_DIBITS);
	private seed: P25p2Seed = { wacn: 0, sysId: 0, nac: 0 };
	private seedSource: P25p2SeedSource = 'none';
	private solver = new P25p2SeedSolver();
	private resting = false;
	private voiced = false;

	constructor(private events: P25p2Events) {
		const clock = () => this.demod.seconds;
		// a call boundary on the played slot: the voice so far goes to the codec, then the codec starts afresh
		this.calls = new P25p2Calls(this.counters, clock, () => {
			this.flushVoice();
			if (isMbelibReady()) resetMbe();
		});
		this.mac = new P25p2MacLayer(this.calls, clock);
	}

	/** Tests: every voice frame as received (slot 1 or 2, the 72 bits in code word order, whether the call is known to be clear). */
	set tap(cb: ((slot: number, bits: Uint8Array, clear: boolean) => void) | undefined) {
		this.calls.tap = cb;
	}

	/** 0 the first slot heard (default), 1 or 2: only that logical channel is played. */
	setListenSlot(slot: number): void {
		this.calls.listen = slot < 0 || slot > 2 ? 0 : slot;
	}

	/**
	 * The descrambler seed (TIA-102.BBAC 7.2.5): the WACN, system ID and colour code (NAC) of the system. All 0: bursts are
	 * taken as sent. A seed set here is kept; otherwise the receiver solves it from the MAC bursts.
	 */
	setSystem(wacn: number, sysId: number, nac: number): void {
		this.applySeed({ wacn: wacn & 0xfffff, sysId: sysId & 0xfff, nac: nac & 0xfff }, 'set');
	}

	/** After a retune: the calls and counters start afresh; the seed, the site and the channel identifiers stay. */
	reset(): void {
		this.demod.reset();
		this.calls.reset();
		this.mac.reset();
		Object.assign(this.counters, newCounters());
		this.voiced = false;
	}

	/**
	 * A chunk of the complex channel (interleaved I/Q at 48 kHz). The receiver rests while another protocol holds the DSD
	 * decoder's lock (not under NXDN's short sync: its own syncs take that lock over) and starts afresh after. True when
	 * voice reached the codec.
	 */
	process(iq: Float32Array | undefined, lockedMode: DSDMode): boolean {
		if (!iq || (lockedMode !== 'unknown' && lockedMode !== 'p25p2' && lockedMode !== 'nxdn')) {
			this.resting = true;
			return false;
		}
		if (this.resting) this.reset();
		this.resting = false;
		this.voiced = false;
		this.demod.process(iq);
		this.calls.expire();
		return this.voiced;
	}

	/** A sync word on the grid of the lock. */
	synced(): void {
		this.events.status().p25p2 = this.status();
		this.events.synced();
	}

	burst(buf: Uint8Array, slot: number, ch: number): void {
		const c = this.counters;
		const d = p25p2Descramble(buf, this.seq, slot);
		const duid = p25p2Duid(buf);
		switch (duid) {
			case DUID_4V:
				c.v4++;
				this.calls.essB(ch, d);
				for (let k = 0; k < 4; k++) this.calls.voiceFrame(ch, p25p2AmbeFrame(d, P25P2_VOICE_OFFSETS[k]));
				break;
			case DUID_2V:
				c.v2++;
				this.calls.essA(ch, d);
				for (let k = 0; k < 2; k++) this.calls.voiceFrame(ch, p25p2AmbeFrame(d, P25P2_VOICE_OFFSETS[k]));
				break;
			case DUID_SACCH:
			case DUID_FACCH:
			case DUID_SACCH_CLEAR:
			case DUID_FACCH_CLEAR:
				this.signalling(duid, buf, d, slot, ch);
				break;
			case DUID_LCCH:
				break;
			default:
				c.slotsBad++;
				c.duidBad++;
				break;
		}
		this.flushVoice();
	}

	/** buf: the burst as received, d: descrambled. */
	private signalling(duid: number, buf: Uint8Array, d: Uint8Array, slot: number, ch: number): void {
		const c = this.counters;
		const facch = duid === DUID_FACCH || duid === DUID_FACCH_CLEAR;
		if (facch) c.facch++;
		else c.sacch++;
		if (facch) this.calls.facch(ch); // a call boundary: the codec starts afresh
		const clear = duid === DUID_SACCH_CLEAR || duid === DUID_FACCH_CLEAR;
		let r = macDecodeAir(facch, payloadGet(clear ? buf : d));
		if (!r && !clear && this.seedSource !== 'set') r = this.recoverSeed(facch, buf, slot);
		if (!r) {
			c.macBad++;
			return;
		}
		c.macOk++;
		c.rsCorrected += r.corrected;
		this.mac.pdu(ch, r.mac, facch ? FACCH_AIR_BYTES : SACCH_AIR_BYTES);
	}

	/** The seed that this scrambled burst decodes with (seed.ts): taken when the burst then passes RS and CRC. */
	private recoverSeed(facch: boolean, buf: Uint8Array, slot: number): P25p2MacPdu | null {
		const seed = this.solver.solve(slot, facch, payloadGet(buf));
		if (!seed) return null;
		const r = macDecodeAir(facch, payloadGet(p25p2Descramble(buf, p25p2Scramble(seed.wacn, seed.sysId, seed.nac), slot)));
		if (!r) return null;
		this.counters.seedsRecovered++;
		this.applySeed(seed, 'recovered');
		return r;
	}

	private applySeed(seed: P25p2Seed, source: P25p2SeedSource): void {
		this.seed = seed;
		this.seedSource = seed.wacn || seed.sysId || seed.nac ? source : 'none';
		this.seq = p25p2Scramble(seed.wacn, seed.sysId, seed.nac);
		this.calls.forgetHeld();
	}

	private flushVoice(): void {
		if (!this.calls.out.length) return;
		this.events.voice(this.calls.out.splice(0));
		this.voiced = true;
	}

	status(): P25p2Status {
		const c = this.counters;
		const { site, grant } = this.mac;
		return {
			slots: this.calls.now.map((s) => ({ ...s })),
			audioSlot: this.calls.audioSlot,
			slotNow: this.demod.slotNow,
			...this.seed,
			seed: this.seedSource,
			endNac: this.mac.endNac,
			site: site && { ...site },
			grant: grant && { ...grant },
			cfoHz: this.demod.cfoHz,
			snrDb: this.demod.snrDb,
			macOk: c.macOk,
			macBad: c.macBad,
			essOk: c.essOk,
			essBad: c.essBad,
			voiceFrames: c.voiceFrames,
			encryptedSkipped: c.encryptedSkipped,
		};
	}

	/** Tests and diagnostics: the lock of the demodulator. */
	get locked(): boolean {
		return this.demod.locked;
	}
}
