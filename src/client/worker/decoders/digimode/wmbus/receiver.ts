// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/wmbus/wmbus_live.cpp (Biquad, the channel filter, FM discriminator,
// carrier and level trackers, and the chip demodulator: clock recovery, sync search, T / C format marker, Manchester,
// 3-out-of-6 and NRZ symbols, byte assembly), https://github.com/adswill/OnAir; see third_party/onair. Changes: BrowSDR's
// DDC mixes and decimates the channel to OnAir's 400 kHz working rate (in place of OnAir's per-channel mixer and boxcar);
// the T1 / C1 and S1 demodulators share that channel's filter and discriminator, each group keeping its own carrier and
// level trackers; no noise-floor tracker, discriminator trace or narrow-channel arbitration (R2 and N are not ported);
// fixed buffers in place of growing vectors.

import { airLength, decode36, encode36, phySpec } from './proto';
import type { WmbusCoding, WmbusPhy, WmbusTelegram } from './types';

/** A frame longer than this is a false sync. */
const MAX_BYTES = 300;

function popcount(value: number): number {
	let x = value - ((value >>> 1) & 0x55555555);
	x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
	return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

export const toDb = (p: number): number => (p > 1e-20 ? 10 * Math.log10(p) : -200);

/** The channel filter (two biquad low-passes: a 4th-order Butterworth) and the FM discriminator. */
export class WmbusFront {
	/** b0 b1 b2 a1 a2 of each stage. */
	private readonly coef = new Float64Array(10);
	/** z1 z2 of I, then of Q, for each stage. */
	private readonly z = new Float64Array(8);
	private prevRe = 0;
	private prevIm = 0;
	private havePrev = false;
	/** Power of the last filtered sample. */
	power = 0;

	constructor(fs: number, cutoffHz: number) {
		[0.5412, 1.3066].forEach((q, stage) => {
			const w = (2 * Math.PI * cutoffHz) / fs;
			const c = Math.cos(w);
			const al = Math.sin(w) / (2 * q);
			const a0 = 1 + al;
			this.coef.set([(1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0, (-2 * c) / a0, (1 - al) / a0], 5 * stage);
		});
	}

	/** One working-rate sample through the filter; returns the phase step, radians per sample. */
	step(re: number, im: number): number {
		const k = this.coef;
		const z = this.z;
		let ar = re;
		let ai = im;
		for (let stage = 0, c = 0, o = 0; stage < 2; stage++, c += 5, o += 4) {
			const yr = k[c] * ar + z[o];
			z[o] = k[c + 1] * ar - k[c + 3] * yr + z[o + 1];
			z[o + 1] = k[c + 2] * ar - k[c + 4] * yr;
			const yi = k[c] * ai + z[o + 2];
			z[o + 2] = k[c + 1] * ai - k[c + 3] * yi + z[o + 3];
			z[o + 3] = k[c + 2] * ai - k[c + 4] * yi;
			ar = yr;
			ai = yi;
		}
		this.power = ar * ar + ai * ai;
		const d = this.havePrev ? Math.atan2(ai * this.prevRe - ar * this.prevIm, ar * this.prevRe + ai * this.prevIm) : 0;
		this.prevRe = ar;
		this.prevIm = ai;
		this.havePrev = true;
		return d;
	}

	reset(): void {
		this.z.fill(0);
		this.prevRe = this.prevIm = this.power = 0;
		this.havePrev = false;
	}
}

/** One chip demodulator: clock recovery, sync search and byte assembly for one mode (T1 and C1 share one). */
class ChipDemod {
	private readonly step: number;
	private readonly sync: number;
	private phase = 0;
	private accSum = 0;
	private accN = 0;
	private prevSlice = false;
	/** The last 16 chips (the sync window) and the 32 before them (the preamble). */
	private win = 0;
	private pre = 0;
	private seen = 0;
	collecting = false;
	private invert = false;
	private coding: WmbusCoding = 'nrz';
	private formatB = false;
	/** T / C: the first chips after the sync, until the format marker is known. */
	private readonly pend = new Uint8Array(16);
	private readonly pendSoft = new Float32Array(16);
	private pendN = 0;
	private decided = false;
	private chipIdx = 0;
	private symAcc = 0;
	private nib = -1;
	private manPrev = -1;
	private manPrevSoft = 0;
	private readonly symSoft = new Float32Array(6);
	/** Symbols of this frame, and how many needed a soft decision (hard: not a code word). */
	private symN = 0;
	private badSym = 0;
	private readonly bytes = new Uint8Array(MAX_BYTES);
	private nBytes = 0;
	private need = 0;
	private levelDb = -200;
	private cfoHz = 0;

	constructor(
		private readonly channel: WmbusChannel,
		private readonly phy: WmbusPhy,
		/** T1 and C1 share the sync word: the format marker tells them apart. */
		private readonly tc: boolean,
		private readonly onFrame: (telegram: WmbusTelegram) => void,
	) {
		const spec = phySpec(tc ? 'T1' : phy);
		this.step = spec.chipRate / channel.fsOut;
		this.sync = spec.sync;
	}

	reset(): void {
		this.phase = this.accSum = this.accN = 0;
		this.prevSlice = false;
		this.win = this.pre = this.seen = 0;
		this.collecting = false;
	}

	/** One discriminator sample, carrier removed; `norm` scales it to the nominal deviation. */
	sample(dn: number, norm: number): void {
		const s = dn > 0;
		if (s !== this.prevSlice) {
			const err = this.phase < 0.5 ? this.phase : this.phase - 1;
			this.phase -= 0.12 * err;
			this.prevSlice = s;
		}
		this.phase += this.step;
		// the chip value: the discriminator averaged over 80 % of the chip
		if (this.phase >= 0.1 && this.phase < 0.9) {
			this.accSum += dn;
			this.accN++;
		}
		if (this.phase >= 1) {
			this.phase -= 1;
			const avg = this.accN ? this.accSum / this.accN : dn;
			this.accSum = 0;
			this.accN = 0;
			this.onChip(avg > 0 ? 1 : 0, avg * norm);
		}
	}

	private onChip(bit: number, soft: number): void {
		this.pre = ((this.pre << 1) | (this.win >>> 15)) >>> 0;
		this.win = ((this.win << 1) | bit) & 0xffff;
		if (this.seen < 64) this.seen++;
		if (!this.collecting) {
			this.searchSync();
			return;
		}
		const b = this.invert ? bit ^ 1 : bit;
		const sv = this.invert ? -soft : soft;
		if (this.tc && !this.decided) this.formatMarker(b, sv);
		else this.symbolChip(b, sv);
	}

	/** The sync word (at most one chip wrong, either polarity) after 32 chips of alternating preamble. */
	private searchSync(): void {
		if (this.seen < 48) return;
		const w = this.win;
		const e = popcount(w ^ this.sync);
		const ei = popcount((~w & 0xffff) ^ this.sync);
		if (e > 1 && ei > 1) return;
		const inv = ei < e;
		const pre = inv ? ~this.pre >>> 0 : this.pre;
		if (popcount((pre ^ (pre >>> 1)) & 0x7fffffff) < 26) return;
		const channel = this.channel;
		this.collecting = true;
		this.invert = inv;
		channel.nColl++;
		this.formatB = false;
		this.decided = !this.tc;
		this.coding = this.tc ? 'nrz' : phySpec(this.phy).coding;
		this.pendN = this.nBytes = this.need = this.chipIdx = this.symAcc = this.symN = this.badSym = 0;
		this.nib = this.manPrev = -1;
		this.levelDb = toDb(channel.pFast);
		this.cfoHz = (channel.dc * channel.fsOut) / (2 * Math.PI);
	}

	/** Mode C sends 0x54 then 0xCD (format A) or 0x3D (format B); 010101 is not a 3-of-6 word, so T1 never starts with 0x54. */
	private formatMarker(bit: number, soft: number): void {
		this.pend[this.pendN] = bit;
		this.pendSoft[this.pendN] = soft;
		this.pendN++;
		if (this.pendN < 8) return;
		let v = 0;
		for (let i = 0; i < this.pendN; i++) v = (v << 1) | this.pend[i];
		if (this.pendN === 8 && v === 0x54) return;
		if (this.pendN > 8 && this.pendN < 16) return;
		this.decided = true;
		if (this.pendN === 16 && ((v & 0xff) === 0xcd || (v & 0xff) === 0x3d)) {
			this.coding = 'nrz';
			this.formatB = (v & 0xff) === 0x3d;
			return;
		}
		this.coding = 'threeOfSix';
		for (let i = 0; i < this.pendN; i++) {
			if (!this.collecting) return;
			this.symbolChip(this.pend[i], this.pendSoft[i]);
		}
	}

	private symbolChip(bit: number, soft: number): void {
		if (this.coding === 'nrz') {
			this.symAcc = (this.symAcc << 1) | bit;
			if (++this.chipIdx === 8) this.byteDone();
		} else if (this.coding === 'manchester') this.manchesterChip(bit, soft);
		else this.threeOfSixChip(bit, soft);
	}

	private byteDone(): void {
		const b = this.symAcc & 0xff;
		this.chipIdx = 0;
		this.symAcc = 0;
		this.addByte(b);
	}

	private manchesterChip(bit: number, soft: number): void {
		if (this.manPrev < 0) {
			this.manPrev = bit;
			this.manPrevSoft = soft;
			return;
		}
		this.symN++;
		let b = this.manPrev;
		if (this.manPrev === bit) {
			// 00 or 11: the chip pair says which of 10 / 01 is nearer
			if (!this.softSymbol()) return;
			b = this.manPrevSoft - soft > 0 ? 1 : 0;
		}
		this.symAcc = (this.symAcc << 1) | b;
		this.manPrev = -1;
		if (++this.chipIdx === 8) this.byteDone();
	}

	private threeOfSixChip(bit: number, soft: number): void {
		this.symSoft[this.chipIdx] = soft;
		this.symAcc = (this.symAcc << 1) | bit;
		if (++this.chipIdx < 6) return;
		let n = decode36(this.symAcc);
		this.chipIdx = 0;
		this.symAcc = 0;
		this.symN++;
		if (n < 0) {
			// the code word nearest to the soft chips (largest correlation)
			if (!this.softSymbol()) return;
			let best = -1e30;
			for (let k = 0; k < 16; k++) {
				const w = encode36(k);
				let m = 0;
				for (let i = 0; i < 6; i++) m += (w >> (5 - i)) & 1 ? this.symSoft[i] : -this.symSoft[i];
				if (m > best) {
					best = m;
					n = k;
				}
			}
		}
		if (this.nib < 0) this.nib = n;
		else {
			const b = (this.nib << 4) | n;
			this.nib = -1;
			this.addByte(b);
		}
	}

	/** A coded symbol that was not a code word: decided by the soft values; a frame with too many of them is noise. */
	private softSymbol(): boolean {
		this.badSym++;
		if (this.badSym * 4 > this.symN + 8) {
			this.abortFrame();
			return false;
		}
		return true;
	}

	private addByte(b: number): void {
		this.bytes[this.nBytes++] = b;
		if (this.nBytes === 1) {
			if (b < 9) {
				this.abortFrame();
				return;
			}
			this.need = airLength(b, this.formatB);
			if (this.need > MAX_BYTES) {
				this.abortFrame();
				return;
			}
		}
		if (this.need && this.nBytes >= this.need) this.finish();
	}

	private finish(): void {
		const phy: WmbusPhy = this.tc ? (this.formatB ? 'C1B' : this.coding === 'threeOfSix' ? 'T1' : 'C1A') : this.phy;
		const telegram = { phy, formatB: this.formatB, bytes: this.bytes.slice(0, this.nBytes), levelDb: this.levelDb, cfoHz: this.cfoHz };
		this.abortFrame();
		this.onFrame(telegram);
	}

	private abortFrame(): void {
		if (this.collecting) this.channel.nColl--;
		this.collecting = false;
		this.seen = 0;
	}
}

/**
 * The demodulators of one OnAir channel on the shared filter and discriminator: the carrier (discriminator mean,
 * frozen during a frame) and the level trackers, timed by the slowest chip rate of its modes.
 */
export class WmbusChannel {
	readonly chips: ChipDemod[] = [];
	dc = 0;
	pFast = 0;
	nColl = 0;
	private readonly dcAlpha: number;
	private readonly fastAlpha: number;
	private readonly norm: number;

	constructor(
		phys: WmbusPhy[],
		readonly fsOut: number,
		onFrame: (telegram: WmbusTelegram) => void,
	) {
		const slowest = Math.min(...phys.map((phy) => phySpec(phy).chipRate));
		this.dcAlpha = 1 / ((8 * fsOut) / slowest);
		this.fastAlpha = 1 / ((16 * fsOut) / slowest);
		this.norm = 1 / ((2 * Math.PI * phySpec(phys[0]).devHz) / fsOut);
		let tcDone = false;
		for (const phy of phys) {
			const tc = phy === 'T1' || phy === 'C1A';
			if (tc && tcDone) continue;
			tcDone ||= tc;
			this.chips.push(new ChipDemod(this, tc ? 'T1' : phy, tc, onFrame));
		}
	}

	/** One discriminator sample (radians per sample) and the power of the filtered sample. */
	sample(d: number, p: number): void {
		this.pFast += (p - this.pFast) * this.fastAlpha;
		if (this.nColl === 0) this.dc += (d - this.dc) * this.dcAlpha;
		const dn = d - this.dc;
		const chips = this.chips;
		for (let i = 0; i < chips.length; i++) chips[i].sample(dn, this.norm);
	}

	reset(): void {
		this.dc = this.pFast = this.nColl = 0;
		for (const chip of this.chips) chip.reset();
	}
}
