import type { TetraSymbolSink } from './types';

export const TETRA_RATE = 72000;
export const SYMBOL_RATE = 18000;
const SPS = TETRA_RATE / SYMBOL_RATE;
/** Symbols per timing decision: one timeslot. */
const BLOCK = 255;
const QUALITY_LOCK = 0.35;

function rootRaisedCosine(span: number, alpha: number, sps: number): Float32Array {
	const length = span * sps + 1;
	const middle = (length - 1) / 2;
	const taps = new Float32Array(length);
	let energy = 0;
	for (let i = 0; i < length; i++) {
		const t = (i - middle) / sps;
		let value: number;
		if (Math.abs(t) < 1e-9) value = 1 - alpha + (4 * alpha) / Math.PI;
		else if (Math.abs(Math.abs(t) - 1 / (4 * alpha)) < 1e-9)
			value =
				(alpha / Math.SQRT2) * ((1 + 2 / Math.PI) * Math.sin(Math.PI / (4 * alpha)) + (1 - 2 / Math.PI) * Math.cos(Math.PI / (4 * alpha)));
		else
			value =
				(Math.sin(Math.PI * t * (1 - alpha)) + 4 * alpha * t * Math.cos(Math.PI * t * (1 + alpha))) /
				(Math.PI * t * (1 - (4 * alpha * t) ** 2));
		taps[i] = value;
		energy += value * value;
	}
	return taps.map((value) => value / Math.sqrt(energy));
}

const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

/**
 * Non-coherent pi/4-DQPSK receiver for a 72 kS/s complex channel: root-raised-cosine matched filter,
 * per-timeslot symbol timing chosen by the fourth-power constellation metric, and a frequency
 * offset tracked from the same metric. Emits two soft bits per symbol (+ means one).
 */
export class TetraDemodulator {
	quality = 0;
	freqOffsetHz = 0;
	private readonly taps = rootRaisedCosine(8, 0.35, SPS);
	private readonly delayI: Float32Array;
	private readonly delayQ: Float32Array;
	private delayPos = 0;
	private re = new Float32Array(8192);
	private im = new Float32Array(8192);
	private length = 0;
	private next = 2 * SPS;
	private locked = false;
	private rotation = 0;
	private fourthI = 0;
	private fourthQ = 0;

	constructor(private readonly sink: TetraSymbolSink) {
		this.delayI = new Float32Array(this.taps.length);
		this.delayQ = new Float32Array(this.taps.length);
	}

	/** Interleaved I/Q samples at TETRA_RATE. */
	process(iq: Float32Array): void {
		for (let i = 0; i + 1 < iq.length; i += 2) {
			this.filter(iq[i], iq[i + 1]);
			if (this.length >= this.next + (BLOCK + 2) * SPS + 2) this.block();
		}
	}

	reset(): void {
		this.delayI.fill(0);
		this.delayQ.fill(0);
		this.length = this.delayPos = 0;
		this.next = 2 * SPS;
		this.locked = false;
		this.rotation = this.fourthI = this.fourthQ = this.quality = this.freqOffsetHz = 0;
	}

	private filter(i: number, q: number): void {
		const taps = this.taps;
		this.delayI[this.delayPos] = i;
		this.delayQ[this.delayPos] = q;
		let si = 0,
			sq = 0;
		for (let t = 0, k = this.delayPos; t < taps.length; t++) {
			si += this.delayI[k] * taps[t];
			sq += this.delayQ[k] * taps[t];
			k = k === 0 ? taps.length - 1 : k - 1;
		}
		this.delayPos = (this.delayPos + 1) % taps.length;
		if (this.length === this.re.length) this.grow();
		this.re[this.length] = si;
		this.im[this.length++] = sq;
	}

	private grow(): void {
		const re = new Float32Array(this.re.length * 2);
		const im = new Float32Array(this.im.length * 2);
		re.set(this.re);
		im.set(this.im);
		this.re = re;
		this.im = im;
	}

	/** Choose the timing for one timeslot, update the frequency estimate, then emit its symbols. */
	private block(): void {
		const [from, to, step] = this.locked ? [-1, 1, 0.125] : [0, SPS - 0.125, 0.125];
		let best = -1,
			bestShift = 0,
			bestI = 0,
			bestQ = 0;
		for (let shift = from; shift <= to + 1e-9; shift += step) {
			const start = Math.max(1, this.next + shift);
			const [sumI, sumQ] = this.fourthPower(start);
			const metric = Math.hypot(sumI, sumQ);
			if (metric > best) [best, bestShift, bestI, bestQ] = [metric, shift, sumI, sumQ];
		}
		this.quality = best / BLOCK;
		this.locked = this.quality >= QUALITY_LOCK;
		this.fourthI = this.fourthI * 0.7 + (bestI / BLOCK) * 0.3;
		this.fourthQ = this.fourthQ * 0.7 + (bestQ / BLOCK) * 0.3;
		this.rotation = wrap(Math.atan2(this.fourthQ, this.fourthI) - Math.PI) / 4;
		this.freqOffsetHz = (this.rotation * SYMBOL_RATE) / (2 * Math.PI);
		const start = Math.max(1, this.next + bestShift);
		this.emit(start);
		this.next = start + BLOCK * SPS;
		this.discard();
	}

	/** Sum of the normalised fourth power of the symbol-to-symbol phase steps across one block. */
	private fourthPower(start: number): [number, number] {
		let [pi, pq] = this.sample(start - SPS);
		let sumI = 0,
			sumQ = 0;
		for (let s = 0; s < BLOCK; s++) {
			const [ci, cq] = this.sample(start + s * SPS);
			const di = ci * pi + cq * pq;
			const dq = cq * pi - ci * pq;
			const si = di * di - dq * dq;
			const sq = 2 * di * dq;
			const magnitude = si * si + sq * sq;
			if (magnitude > 0) {
				sumI += (si * si - sq * sq) / magnitude;
				sumQ += (2 * si * sq) / magnitude;
			}
			pi = ci;
			pq = cq;
		}
		return [sumI, sumQ];
	}

	private emit(start: number): void {
		let [pi, pq] = this.sample(start - SPS);
		const cos = Math.cos(-this.rotation);
		const sin = Math.sin(-this.rotation);
		for (let s = 0; s < BLOCK; s++) {
			const [ci, cq] = this.sample(start + s * SPS);
			const di = ci * pi + cq * pq;
			const dq = cq * pi - ci * pq;
			const ri = di * cos - dq * sin;
			const rq = di * sin + dq * cos;
			const magnitude = Math.hypot(ri, rq) || 1;
			// 00 -> +pi/4, 01 -> +3pi/4, 11 -> -3pi/4, 10 -> -pi/4 (§5.5.2)
			this.sink((-rq / magnitude) * Math.SQRT2, (-ri / magnitude) * Math.SQRT2);
			pi = ci;
			pq = cq;
		}
	}

	private sample(position: number): [number, number] {
		const index = Math.floor(position);
		const fraction = position - index;
		return [
			this.re[index] + (this.re[index + 1] - this.re[index]) * fraction,
			this.im[index] + (this.im[index + 1] - this.im[index]) * fraction,
		];
	}

	/** Keep two symbols before the next block for the differential reference and the timing search. */
	private discard(): void {
		const drop = Math.floor(this.next) - 2 * SPS - 2;
		if (drop <= 0) return;
		this.re.copyWithin(0, drop, this.length);
		this.im.copyWithin(0, drop, this.length);
		this.length -= drop;
		this.next -= drop;
	}
}
