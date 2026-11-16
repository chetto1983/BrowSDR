/*
 * Coarse carrier acquisition for QPSK: the fourth power of the signal strips the modulation and leaves
 * a spectral line at four times the carrier offset. One FFT of a short block puts the Costas loop
 * within a few hertz, instead of sweeping the whole Doppler range at upstream's slow sweep rate.
 */

const SIZE = 8192;
/** The line must stand this far above the average bin to count as a carrier. */
const MIN_PEAK_RATIO = 30;

function fftInPlace(re: Float64Array, im: Float64Array): void {
	const n = re.length;
	for (let i = 1, j = 0; i < n; i++) {
		let bit = n >> 1;
		for (; j & bit; bit >>= 1) j ^= bit;
		j ^= bit;
		if (i < j) {
			[re[i], re[j]] = [re[j], re[i]];
			[im[i], im[j]] = [im[j], im[i]];
		}
	}
	for (let width = 2; width <= n; width *= 2) {
		const step = (-2 * Math.PI) / width;
		for (let base = 0; base < n; base += width) {
			for (let k = 0; k < width / 2; k++) {
				const c = Math.cos(step * k);
				const s = Math.sin(step * k);
				const a = base + k;
				const b = a + width / 2;
				const tr = re[b] * c - im[b] * s;
				const ti = re[b] * s + im[b] * c;
				re[b] = re[a] - tr;
				im[b] = im[a] - ti;
				re[a] += tr;
				im[a] += ti;
			}
		}
	}
}

/** Collects input samples and estimates the carrier offset once a block is full. */
export class CarrierAcquisition {
	private readonly re = new Float64Array(SIZE);
	private readonly im = new Float64Array(SIZE);
	private fill = 0;

	constructor(
		private readonly sampleRate: number,
		private readonly maxOffsetHz: number,
	) {}

	/** Adds one input sample; returns the offset in Hz when a block yields a clear line, else null. */
	push(i: number, q: number): number | null {
		const i2 = i * i - q * q;
		const q2 = 2 * i * q;
		this.re[this.fill] = i2 * i2 - q2 * q2;
		this.im[this.fill] = 2 * i2 * q2;
		if (++this.fill < SIZE) return null;
		this.fill = 0;
		return this.estimate();
	}

	reset(): void {
		this.fill = 0;
	}

	private estimate(): number | null {
		fftInPlace(this.re, this.im);
		const binHz = this.sampleRate / SIZE;
		const maxBin = Math.min(SIZE / 2 - 1, Math.floor((4 * this.maxOffsetHz) / binHz));
		const power = (bin: number) => {
			const k = (bin + SIZE) % SIZE;
			return this.re[k] ** 2 + this.im[k] ** 2;
		};
		let best = 0;
		let bestPower = -1;
		let total = 0;
		for (let bin = -maxBin; bin <= maxBin; bin++) {
			const p = power(bin);
			total += p;
			if (p > bestPower) [best, bestPower] = [bin, p];
		}
		if (bestPower < (MIN_PEAK_RATIO * total) / (2 * maxBin + 1)) return null;
		// Parabolic interpolation on log power around the peak.
		const [a, b, c] = [power(best - 1), bestPower, power(best + 1)].map((p) => Math.log(p + 1e-30));
		const shift = a - 2 * b + c === 0 ? 0 : (0.5 * (a - c)) / (a - 2 * b + c);
		return ((best + shift) * binHz) / 4;
	}
}
