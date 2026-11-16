// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/hfdig/hfdig_ftx.cpp (the soft bits and the decoding stages of
// SlotDecoder::tryCandidate, coherentLlr: non-coherent likelihoods, WSJT-X's two- and three-symbol coherent metrics,
// ordered statistics, a-priori CQ decoding, soft bits added across slots, a-priori calls of the conversations heard),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: OnAir's HFDIG_FTX_* measuring switches are fixed
// at their defaults; the stages are methods of their own; the a-priori calls of the conversations heard are tried on the
// first 16 candidates of a slot that reach that stage (OnAir tries every one: in a busy band that is most of the slot's
// decoding time, for a decode now and then).

import { checkCrc, ldpcDecode, osdDecode } from './ldpc';
import { logI0 } from './layout';
import type { XMem } from './memory';
import { type CallHash, pack77 } from './pack';
import { FT4_RVEC, FT8_GRAY, FT4_GRAY, LDPC_N } from './tables';
import type { FtxDeepCandidate, FtxLayout, FtxMode, OsdStats } from './types';
import { unpack77 } from './unpack';
import { FT8, spec } from './wave';

const OSD_PAIRS = 40;
const OSD_MIN_SCORE = 2.5;
const OSD_MAX_DIST = 1;
const OSD_MIN_MARGIN = 0;
const AP_QSO_MIN_SCORE = 2.6;
/** Candidates of a slot the a-priori calls are tried on, at most (OnAir: all; each costs dozens of decoder runs). */
const AP_QSO_MAX = 16;
/** Least share of the unknown bits' reliability the a-priori result must agree with. */
const AP_QSO_AGREE = 0.7;
/** The same signal in another slot: frequency and DT apart at most. */
const X_HZ = 3;
const X_DT = 0.4;

const CQ_BITS = (() => {
	const b = new Uint8Array(77);
	pack77('CQ K1ABC FN42', b);
	return b;
})();

/** Soft bits of the data symbols (non-coherent likelihoods of the tones, Gray mapped). llr > 0 means 1. */
export function plainLlr(L: FtxLayout, amp: Float64Array, kx: number, out: Float64Array): void {
	const gray = L.nt === 8 ? FT8_GRAY : FT4_GRAY;
	const li = new Float64Array(8);
	let bi = 0;
	for (const k of L.data) {
		for (let t = 0; t < L.nt; t++) li[t] = logI0(kx * amp[k * L.nt + t]);
		for (let b = 0; b < L.bits; b++) {
			let m1 = -1e300;
			let m0 = -1e300;
			for (let v = 0; v < L.nt; v++) {
				const l = li[gray[v]];
				const one = (v >> (L.bits - 1 - b)) & 1;
				const m = one ? m1 : m0;
				const r = m > l ? m + Math.log1p(Math.exp(l - m)) : l + Math.log1p(Math.exp(m - l));
				if (one) m1 = r;
				else m0 = r;
			}
			out[bi++] = Math.max(-25, Math.min(25, m1 - m0));
		}
	}
}

/**
 * Soft bits from groups of n neighbouring data symbols whose tone correlations are added as complex numbers (WSJT-X's
 * nsym 2 / 3 metrics: max |sum| over the tone sequences with the bit 1 minus that with the bit 0), scaled to WSJT-X's
 * spread.
 */
export function coherentLlr(L: FtxLayout, zr: Float64Array, zi: Float64Array, n: number, out: Float64Array): void {
	const gray = L.nt === 8 ? FT8_GRAY : FT4_GRAY;
	const nd = L.data.length;
	const m1 = new Float64Array(12);
	const m0 = new Float64Array(12);
	let bi = 0;
	let sum = 0;
	let sum2 = 0;
	for (let i = 0; i < nd;) {
		let g = 1;
		while (g < n && i + g < nd && L.data[i + g] === L.data[i + g - 1] + 1) g++;
		const nb = g * L.bits;
		m1.fill(-1e300);
		m0.fill(-1e300);
		for (let cmb = 0; cmb < 1 << nb; cmb++) {
			let ar = 0;
			let ai = 0;
			for (let q = 0; q < g; q++) {
				const j = L.data[i + q] * L.nt + gray[(cmb >> ((g - 1 - q) * L.bits)) & (L.nt - 1)];
				ar += zr[j];
				ai += zi[j];
			}
			const m = Math.sqrt(ar * ar + ai * ai);
			for (let b = 0; b < nb; b++) {
				const r = (cmb >> (nb - 1 - b)) & 1 ? m1 : m0;
				if (m > r[b]) r[b] = m;
			}
		}
		for (let b = 0; b < nb; b++) {
			const l = m1[b] - m0[b];
			out[bi++] = l;
			sum += l;
			sum2 += l * l;
		}
		i += g;
	}
	const mean = sum / bi;
	const sd = Math.sqrt(Math.max(1e-30, sum2 / bi - mean * mean));
	for (let i = 0; i < bi; i++) out[i] = Math.max(-25, Math.min(25, (2.83 * out[i]) / sd));
}

/** The decoding stages beyond plain belief propagation for one slot of FT8 / FT4. */
export class DeepStages {
	readonly cw = new Uint8Array(LDPC_N);
	/** 0 this slot alone, 1 soft bits added across slots, 2 a-priori calls. */
	how = 0;
	private readonly os: OsdStats = { hardErrors: 0, dist: 0, margin: 0 };
	private readonly a = new Float64Array(LDPC_N);
	private apQsoLeft = AP_QSO_MAX;

	constructor(
		private readonly mode: FtxMode,
		private readonly slotUtc: number,
		private readonly hash: CallHash,
		private readonly mem: XMem,
	) {}

	private scramble(i: number): number {
		return this.mode === FT8 ? 0 : FT4_RVEC[i];
	}

	private bits77(w: Uint8Array): Uint8Array {
		return Uint8Array.from({ length: 77 }, (_, i) => w[i] ^ this.scramble(i));
	}

	private bp(llr: ArrayLike<number>): boolean {
		return ldpcDecode(llr, 40, this.cw) === 0 && checkCrc(this.cw);
	}

	/** OSD with its distance and margin limits and a plausible message. */
	private osd(llr: ArrayLike<number>): boolean {
		return (
			osdDecode(llr, OSD_PAIRS, this.cw, this.os) &&
			this.os.dist <= OSD_MAX_DIST &&
			this.os.margin >= OSD_MIN_MARGIN &&
			this.plausible(false)
		);
	}

	/**
	 * A codeword found by OSD or with a-priori bits: OSD finds some codeword in noise now and then, so keep only the plain
	 * QSO message types with no unknown hashed call (and with the CQ bits assumed, a CQ).
	 */
	private plausible(cq: boolean): boolean {
		const b = this.bits77(this.cw);
		const i3 = (b[74] << 2) | (b[75] << 1) | b[76];
		if (!(i3 === 1 || i3 === 2 || i3 === 4)) return false;
		const m = unpack77(b, this.hash);
		return !!m && !m.includes('<...>') && (!cq || m.startsWith('CQ '));
	}

	/**
	 * What a noise candidate decoded with the CQ bits assumed looks like, and a calling station never sends: "CQ <call> R
	 * <grid>", a rover's /R, a report or RR73 where the grid goes, a call that starts with 0, 1 or Q, or with a /.
	 */
	private cqShapeOk(): boolean {
		const b = this.bits77(this.cw);
		if (b[57] || b[58]) return false;
		let g15 = 0;
		for (let i = 59; i < 74; i++) g15 = (g15 << 1) | b[i];
		if (g15 >= 32400) return false;
		const m = unpack77(b, this.hash);
		if (m.length < 4) return false;
		const sp = m.indexOf(' ', 3);
		const call = m.slice(3, sp < 0 ? undefined : sp);
		return !!call && call[0] !== '0' && call[0] !== '1' && call[0] !== 'Q' && !call.includes('/');
	}

	/** The soft bits with the bits of `known` forced to a magnitude just above the largest. */
	private withKnown(llr: Float64Array, bits: Uint8Array, known: (i: number) => boolean): Float64Array {
		this.a.set(llr);
		let mx = 0;
		for (let i = 0; i < LDPC_N; i++) mx = Math.max(mx, Math.abs(llr[i]));
		const mag = 1.01 * mx;
		for (let i = 0; i < 77; i++) if (known(i)) this.a[i] = bits[i] ^ this.scramble(i) ? mag : -mag;
		return this.a;
	}

	/** Ordered statistics on the strongest candidates only, at the fitted frequency. */
	private osdStage(sets: Float64Array[], c: FtxDeepCandidate, nudge: number): boolean {
		if (c.score < OSD_MIN_SCORE || nudge !== 0) return false;
		return sets.some((s) => this.osd(s));
	}

	/** A-priori decoding (WSJT-X's AP type 1, "CQ ??? ???"): the 29 bits of CQ and the message type taken as known. */
	private apCq(sets: Float64Array[], c: FtxDeepCandidate): boolean {
		for (const s of sets) {
			const a = this.withKnown(s, CQ_BITS, (i) => i < 29 || i >= 74);
			let got = this.bp(a);
			if (!got && c.score >= OSD_MIN_SCORE) got = osdDecode(a, OSD_PAIRS, this.cw, this.os);
			if (got && this.plausible(true) && this.cqShapeOk()) return true;
		}
		return false;
	}

	/** The same signal heard in earlier slots (a station calling CQ or repeating its report): the soft bits added. */
	private crossSlot(sets: Float64Array[], c: FtxDeepCandidate): boolean {
		const P = spec(this.mode).period;
		const m = this.mem.st.filter(
			(e) => e.mir === c.mir && e.slotUtc < this.slotUtc - 0.5 * P && Math.abs(e.hz - c.hz) < X_HZ && Math.abs(e.dt - c.dt) < X_DT,
		);
		const s3 = sets.map(() => new Float64Array(LDPC_N));
		for (let g = 0; g <= m.length; g++) {
			if (g === m.length && m.length < 2) break;
			for (let q = 0; q < 3; q++)
				for (let i = 0; i < LDPC_N; i++) {
					let v = sets[q][i];
					if (g < m.length) v += m[g].l[q][i];
					else for (const e of m) v += e.l[q][i];
					s3[q][i] = v;
				}
			if (s3.some((s) => this.bp(s)) || (c.score >= OSD_MIN_SCORE && s3.some((s) => this.osd(s)))) return true;
		}
		return false;
	}

	/** The calls of a conversation heard on the band taken as known: "A B ..." (both orders) or an answer to a CQ ("X ..."). */
	private apQso(sets: Float64Array[]): boolean {
		for (const h of this.mem.hypotheses()) {
			const known = (i: number) => i < h.lo || (i >= 74 && i < 77);
			for (let q = 0; q < 2; q++) {
				const a = this.withKnown(sets[q], h.bits, known);
				let got = this.bp(a);
				if (!got && h.pair) got = osdDecode(a, OSD_PAIRS, this.cw, this.os);
				if (!got || !this.plausible(false)) continue;
				// the unknown bits must also fit what was heard
				let ag = 0;
				let tot = 0;
				for (let i = 0; i < 91; i++) {
					if (known(i)) continue;
					const w = Math.abs(sets[q][i]);
					tot += w;
					if (sets[q][i] > 0 === (this.cw[i] !== 0)) ag += w;
				}
				if (tot <= 0 || ag / tot >= AP_QSO_AGREE) return true;
			}
		}
		return false;
	}

	/**
	 * The deep stage of a candidate whose plain soft bits did not decode: the coherent metrics, OSD, a-priori CQ, the soft
	 * bits of earlier slots and the calls heard. `xOk`: the stages that use the memory may run. What does not decode is
	 * kept for the next slots. True when this.cw holds a codeword that passed its CRC.
	 */
	decode(L: FtxLayout, llr: Float64Array, zr: Float64Array, zi: Float64Array, c: FtxDeepCandidate, nudge: number, xOk: boolean): boolean {
		this.how = 0;
		const sets = [llr, new Float64Array(LDPC_N), new Float64Array(LDPC_N)];
		const groups = [2, L.nt === 8 ? 3 : 4];
		for (let q = 0; q < 2; q++) {
			coherentLlr(L, zr, zi, groups[q], sets[q + 1]);
			if (this.bp(sets[q + 1])) return true;
		}
		if (this.osdStage(sets, c, nudge)) return true;
		if (nudge === 0 && this.apCq(sets, c)) return true;
		if (xOk && this.crossSlot(sets, c)) {
			this.how = 1;
			return true;
		}
		if (xOk && c.score >= AP_QSO_MIN_SCORE && this.apQsoLeft-- > 0 && this.apQso(sets)) {
			this.how = 2;
			return true;
		}
		if (xOk) this.keep(sets, c);
		return false;
	}

	private keep(sets: Float64Array[], c: FtxDeepCandidate): void {
		const dup = this.mem.st.some(
			(e) => e.mir === c.mir && e.slotUtc === this.slotUtc && Math.abs(e.hz - c.hz) < X_HZ && Math.abs(e.dt - c.dt) < X_DT,
		);
		if (dup) return;
		this.mem.store({
			mir: c.mir,
			slotUtc: this.slotUtc,
			hz: c.hz,
			dt: c.dt,
			l: [Float32Array.from(sets[0]), Float32Array.from(sets[1]), Float32Array.from(sets[2])],
		});
	}
}
