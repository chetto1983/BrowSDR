import { rgbToYuv } from '@/worker/decoders/digimode/sstv/modes';

/** Eight vertical colour bars: white, yellow, cyan, green, magenta, red, blue, black. */
export const BARS = [
	[255, 255, 255],
	[255, 255, 0],
	[0, 255, 255],
	[0, 255, 0],
	[255, 0, 255],
	[255, 0, 0],
	[0, 0, 255],
	[0, 0, 0],
];
export const barAt = (x, width) => BARS[Math.min(7, Math.floor((x * 8) / width))];

const toneOf = (value) => 1500 + (value * 800) / 255;

/** Tone segments [ms, Hz] of one transmitted line, porches at 1500 Hz filling the gaps (published mode timings). */
function lineSegments(spec, k) {
	const width = spec.width;
	const pixel = (comp, x) => {
		const yRow = spec.kind === 'pd' ? 2 * k + (comp === 'y2' ? 1 : 0) : k;
		const [r, g, b] = barAt(x, width);
		const [y, ry, by] = rgbToYuv(r, g, b);
		void yRow; // the bars are the same on every row
		return { r, g, b, y, y2: y, ry, by }[comp];
	};
	const parts = [[spec.syncOffMs, spec.syncMs, 1200]];
	for (const scan of spec.scans) {
		const comp = spec.kind === 'robot36' && scan.comp === 'ry' && k % 2 === 1 ? 'by' : scan.comp;
		const step = width / scan.px; // chroma scans cover two pixels each
		for (let i = 0; i < scan.px; i++)
			parts.push([scan.startMs + (i * scan.lenMs) / scan.px, scan.lenMs / scan.px, toneOf(pixel(comp, Math.floor(i * step + step / 2)))]);
	}
	for (const fixed of spec.fixed) parts.push([fixed.startMs, fixed.lenMs, fixed.hz < 0 ? (k % 2 ? 2300 : 1500) : fixed.hz]);
	return parts.sort((a, b) => a[0] - b[0]);
}

/** Leader, break, VIS (7 bits LSB first, 1100 = 1, 1300 = 0, even parity), stop bit. */
function visSegments(code) {
	const bits = Array.from({ length: 7 }, (_, i) => (code >> i) & 1);
	const parity = bits.reduce((a, b) => a + b, 0) % 2;
	return [[300, 1900], [10, 1200], [300, 1900], [30, 1200], ...[...bits, parity].map((bit) => [30, bit ? 1100 : 1300]), [30, 1200]];
}

/**
 * The phase (radians) of an SSTV transmission of the colour bars, sample by sample at `rate`, so that the caller
 * can make audio (cos), an analytic USB channel or FM. `lines` limits the picture; `vis` false leaves the header out.
 */
export function sstvPhase(spec, { rate = 8000, lines = spec.totalLines, vis = true, toneOffsetHz = 0 } = {}) {
	const tones = []; // [durationMs, Hz]
	tones.push([500, 0]);
	if (vis) tones.push(...visSegments(spec.vis));
	for (let k = 0; k < lines; k++) {
		let t = 0;
		for (const [start, len, hz] of lineSegments(spec, k)) {
			if (start > t) tones.push([start - t, 1500]);
			tones.push([len, hz]);
			t = start + len;
		}
		if (spec.lineMs > t) tones.push([spec.lineMs - t, 1500]);
	}
	tones.push([500, 0]);
	const total = Math.ceil((tones.reduce((sum, [ms]) => sum + ms, 0) * rate) / 1000);
	const phase = new Float64Array(total);
	let [n, edge, p] = [0, 0, 0];
	for (const [ms, hz] of tones) {
		edge += (ms * rate) / 1000;
		for (; n < Math.min(total, Math.round(edge)); n++) {
			p += (2 * Math.PI * (hz ? hz + toneOffsetHz : 0)) / rate;
			phase[n] = p;
		}
	}
	return phase;
}
