// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir core/src/aero/aero_demod.cpp (AeroModulator) and
// core/src/aero/aero_gen.cpp (AeroSynth: six aircraft over the Gulf and the Indian Ocean, the script of uplinks, the
// position reports, the schedule of system table, log-ons, messages and positions per frame, the interpolator to the
// output rate), https://github.com/adswill/OnAir; see third_party/onair. Changes: the channels, their offsets and the
// output rate are options (OnAir: 10500 bit/s at -50 kHz, 1200 at +150 kHz, 600 at +100 kHz of a wide capture); the
// system table cycle also sends the satellite id and P/R channel control SUs; seeded xorshift numbers and Box-Muller
// noise in place of std::mt19937 and OnAir's noise source.

import { aeroHeader, AeroFrameEncoder, aeroFrameFormat, aeroSuSetCrc, infoBytes, totalBits } from '@/worker/decoders/digimode/aero/phy';
import { aeroRrc } from '@/worker/decoders/digimode/aero/demod';
import { aeroBlockBytes } from '@/worker/decoders/digimode/aero/su';
import { gaussian, xorshift } from '../inmarsat-c/fixtures';
import {
	adscBasicGroup,
	adscEarthRefGroup,
	adscFlightIdGroup,
	adscMeteoGroup,
	adscPredictedRouteGroup,
	aeroAcarsToSus,
	aeroBuildAdscText,
	aeroBuildBlock,
	aeroLogonSu,
	aeroSystemTableSu,
} from './fixtures';

/** Channel bits to complex baseband at `fs` (unit power, carrier at 0 Hz); the bit clock may run off by `clockPpm`. */
export class AeroModulator {
	constructor(rate, fs, clockPpm = 0) {
		this.msk = rate !== 10500;
		this.du = (rate * (1 + clockPpm * 1e-6)) / fs;
		this.u = 0;
		this.sym = [];
		this.base = 0;
		this.lastA = 0;
		if (!this.msk) this.rrcTab = Float64Array.from({ length: 16 * 64 + 2 }, (_, i) => aeroRrc((i / 64 - 8) / 2, 1) / Math.SQRT2);
	}
	s(i) {
		return i < this.base || i >= this.base + this.sym.length ? 0 : this.sym[i - this.base];
	}
	rrc(t) {
		const x = (t + 8) * 64;
		const i = Math.floor(x);
		if (i < 0 || i + 1 >= this.rrcTab.length) return 0;
		return this.rrcTab[i] + (x - i) * (this.rrcTab[i + 1] - this.rrcTab[i]);
	}
	pushBits(bits) {
		for (const b of bits) {
			const idx = this.base + this.sym.length;
			if (this.msk) {
				// bit 1: the arm value changes sign on even (Q) positions and keeps it on odd (I) positions, as a +-90 degree step does
				if (!this.lastA) this.lastA = 1;
				if (((b & 1) !== 0) === (idx % 2 === 0)) this.lastA = -this.lastA;
				this.sym.push(this.lastA);
			} else this.sym.push(b & 1 ? 1 : -1);
		}
	}
	get queuedBits() {
		const end = this.base + this.sym.length;
		return end > this.u ? end - this.u : 0;
	}
	/** `n` samples into out (interleaved) from `at`. */
	generate(out, at, n) {
		for (let j = 0; j < n; j++) {
			let I = 0,
				Q = 0;
			const u = this.u;
			if (this.msk) {
				const ke = 2 * Math.round(u / 2);
				const te = u - ke;
				if (Math.abs(te) < 1) Q = this.s(ke) * Math.cos((Math.PI * te) / 2);
				const ko = 2 * Math.floor(u / 2) + 1;
				I = this.s(ko) * Math.cos((Math.PI * (u - ko)) / 2);
			} else
				for (let i = Math.ceil(u - 8); i <= Math.floor(u + 8); i++) {
					const v = this.s(i);
					if (!v) continue;
					const h = v * this.rrc(u - i);
					if (i & 1) I += h;
					else Q += h;
				}
			out[2 * (at + j)] = I;
			out[2 * (at + j) + 1] = Q;
			this.u += this.du;
		}
		const keepFrom = Math.floor(this.u) - 10;
		if (keepFrom > this.base + 4096) {
			this.sym.splice(0, keepFrom - this.base);
			this.base = keepFrom;
		}
	}
}

// ---------------------------------------------------------------- the test channels' content (AeroSynth)

/** Six aircraft: ICAO addresses in their countries' blocks, registrations and flights of airlines over the Gulf. */
export const PLANES = [
	[0x896411, 'A6-EUA', 'EK0501'],
	[0x8963a2, 'A6-ETA', 'EY0234'],
	[0x06a1c3, 'A7-BAB', 'QR0960'],
	[0x800b21, 'VT-ANA', 'AI0995'],
	[0x76cc45, '9V-SMF', 'SQ0495'],
	[0x70c072, 'A4O-SA', 'WY0601'],
].map(([aes, reg, flight]) => ({ aes, reg, flight }));
const SCRIPT = [
	[0, 'H1', 'WX OMDB 071300Z 32012KT CAVOK 35/17 Q1008 NOSIG'],
	[2, '5Z', '/DOH OPS GATE C12 STAND 214 ETA 1415Z PAX CONX 38'],
	[4, 'SA', '0EV142652V'],
	[3, '_d', ''],
	[5, 'H1', 'ATIS OOMS INFO D 1350Z RWY 08 ILS EXP 04012KT 9999 FEW030 33/21 Q1006'],
	[1, 'H1', 'WX VOMM 071330Z 09008KT 6000 HZ SCT020 31/26 Q1004 VABB 071330Z 27010KT 3000 HZ NSC 30/24 Q1005'],
	[0, '5Z', '/EK OPS PLS ADVISE FUEL REMAINING ON ARR DXB'],
	[4, 'H1', 'FREE TEXT CREW REST AREA RESET DONE NO FURTHER ACTION MX CONTROL SIN'],
	[2, 'SA', '0LS1405K2'],
	[3, 'H1', 'ROUTE AMDT AFTER RASKI DCT PRA L301 THEN AS FILED TO VOMM'],
	[1, '5Z', '/AUH OPS NEW STAND 63 ARR BELT 4'],
	[5, '_d', ''],
];
const GES = 5;
/** Where they fly (ADS-C from five, a text POS report from VT-ANA), 20 times faster than real. */
const ROUTES = [
	[25.6, 56.8, 105, 480, 37000, 'BOMCAYA'],
	[24.1, 60.2, 95, 470, 39000, 'BOMCAYA'],
	[23.2, 64.1, 125, 490, 35000, 'MCTCAYA'],
	[20.5, 66.2, 300, 460, 33000, ''],
	[14.8, 71.9, 290, 485, 38000, 'MCTCAYA'],
	[22.3, 59.6, 140, 450, 36000, 'BOMCAYA'],
].map(([lat, lon, trackDeg, kt, altFt, ground]) => ({ lat, lon, trackDeg, kt, altFt, ground }));
const TIME_SCALE = 20;
const START_SEC = 12 * 3600 + 50 * 60;

export function routeAt(i, t) {
	const r = ROUTES[i];
	const nm = (r.kt * t * TIME_SCALE) / 3600,
		a = (r.trackDeg * Math.PI) / 180;
	const lat = r.lat + (nm * Math.cos(a)) / 60;
	return [lat, r.lon + (nm * Math.sin(a)) / (60 * Math.cos((lat * Math.PI) / 180))];
}

const pad = (v, n) => String(v).padStart(n, '0');

/** The downlink a simulated aircraft sends at stream time t (report number n). */
export function positionReport(i, t, n) {
	const p = PLANES[i],
		r = ROUTES[i];
	const [lat, lon] = routeAt(i, t);
	const m = {
		aesId: p.aes,
		gesId: GES,
		uplink: false,
		mode: '2',
		registration: p.reg,
		flight: p.flight,
		msgNo: `M${pad(n % 100, 2)}${String.fromCharCode(65 + (n % 26))}`,
		blockId: String.fromCharCode(0x31 + (n % 9)),
	};
	const sim = START_SEC + t * TIME_SCALE;
	if (!r.ground) {
		const la = Math.abs(lat),
			lo = Math.abs(lon);
		const laD = Math.floor(la),
			loD = Math.floor(lo);
		const laM = Math.min(599, Math.round((la - laD) * 600)),
			loM = Math.min(599, Math.round((lo - loD) * 600));
		const hms = (s) => `${pad(Math.floor(s / 3600), 2)}${pad(Math.floor(s / 60) % 60, 2)}${pad(s % 60, 2)}`;
		const s = Math.floor(sim % 86400),
			s2 = Math.floor((sim + 900) % 86400);
		const text = `#M1BPOS${lat < 0 ? 'S' : 'N'}${pad(laD, 2)}${pad(laM, 3)}${lon < 0 ? 'W' : 'E'}${pad(loD, 3)}${pad(loM, 3)},PARAR,${hms(s)},${pad(r.altFt / 100, 3)},TOTOX,${hms(s2)},ORMAR,M47,28030,450`;
		return { ...m, label: 'H1', text };
	}
	let g = [...adscBasicGroup(lat, lon, r.altFt, sim % 3600, 6), ...adscFlightIdGroup(p.flight), ...adscEarthRefGroup(r.trackDeg, r.kt, 0)];
	if (n % 2 === 0) {
		const [aLat, aLon] = routeAt(i, t + 900 / TIME_SCALE),
			[bLat, bLon] = routeAt(i, t + 1800 / TIME_SCALE);
		g = [
			...g,
			...adscPredictedRouteGroup({ lat: aLat, lon: aLon, altFt: r.altFt, etaSec: 900 }, { lat: bLat, lon: bLon, altFt: r.altFt }),
			...adscMeteoGroup(35 + i * 4, 250 + i * 10, -52 + i),
		];
	}
	const app = aeroBuildAdscText(r.ground, p.reg, g);
	// SQ sends it as H1 with the sublabel and MFI in front, the others as label B6
	return i === 4 ? { ...m, label: 'H1', text: `#M1B/B6 ${app.slice(1)}` } : { ...m, label: 'B6', text: app };
}

/** One P channel of the test signal: what it sends, frame by frame. */
class SynthChannel {
	constructor(idx, def, seed) {
		this.idx = idx;
		this.rate = def.bitRate;
		this.fmt = aeroFrameFormat(this.rate);
		this.enc = new AeroFrameEncoder(this.rate);
		this.frameSecs = totalBits(this.fmt) / this.rate;
		this.frameNo = 0;
		this.queue = [];
		this.script = idx * 5;
		this.tablePart = 0;
		this.nextLogon = idx * 3;
		this.nextLogonAt = 1;
		this.nextCycleAt = 600;
		this.nextMsg = 3 + idx;
		this.nextPos = 4.5 + idx;
		this.posNo = idx * 2;
		this.rng = xorshift(seed * 1000 + this.rate);
		this.sent = { frames: [], messages: [], logons: [] };
		this.positions = def.positions ?? true;
	}
	schedule() {
		const t = this.frameNo * this.frameSecs;
		if (this.rate === 10500 || this.frameNo % 4 === 0) {
			this.queue.push(aeroSystemTableSu(GES, this.tablePart));
			this.tablePart = (this.tablePart + 1) % 6;
		}
		if (this.nextLogon < 6 + this.idx * 3 && t >= this.nextLogonAt) {
			this.logon(PLANES[this.nextLogon % 6].aes, true, t);
			this.nextLogon++;
			this.nextLogonAt = t + 2.5;
		} else if (t >= this.nextCycleAt) {
			const p = PLANES[Math.floor(t / 600) % 6];
			this.logon(p.aes, false, t);
			this.logon(p.aes, true, t);
			this.nextCycleAt = t + 600;
		}
		if (t >= this.nextMsg) {
			const [plane, label, text] = SCRIPT[this.script % SCRIPT.length];
			this.script++;
			const p = PLANES[plane];
			this.send(
				{
					aesId: p.aes,
					gesId: GES,
					uplink: true,
					mode: '2',
					registration: p.reg,
					flight: p.flight,
					label,
					blockId: String.fromCharCode(65 + (this.script % 26)),
					text,
				},
				t,
			);
			this.nextMsg = t + (this.rate === 10500 ? 6 : this.rate === 1200 ? 12 : 20);
		}
		if (this.positions && t >= this.nextPos) {
			this.send(positionReport(this.posNo % 6, t, Math.floor(this.posNo / 6)), t);
			this.posNo++;
			this.nextPos = t + (this.rate === 10500 ? 4 : this.rate === 1200 ? 9 : 16);
		}
	}
	send(m, t) {
		this.queue.push(...aeroAcarsToSus(m));
		this.sent.messages.push({ t, msg: m });
	}
	logon(aes, on, t) {
		this.queue.push(aeroLogonSu(aes, GES, on));
		this.sent.logons.push({ t, aes, logon: on });
	}
	/** The next frame's channel bits. */
	nextFrame() {
		this.schedule();
		const bb = aeroBlockBytes(this.rate);
		const info = new Uint8Array(infoBytes(this.fmt));
		for (let done = 0; done < info.length; done += bb) info.set(aeroBuildBlock(this.queue.splice(0, bb / 12), this.rate), done);
		this.sent.frames.push(info);
		const bits = this.enc.frame(info, aeroHeader(1, 0, this.frameNo >> 4, this.frameNo));
		this.frameNo++;
		return bits;
	}
}

/** SUs of random bytes with a valid check (what the frame tests send). */
export function randomInfo(rng, rate) {
	const b = new Uint8Array(infoBytes(aeroFrameFormat(rate)));
	for (let k = 0; k + 12 <= b.length; k += 12) {
		for (let i = 0; i < 10; i++) b[k + i] = rng() & 0xff;
		aeroSuSetCrc(b, k);
	}
	return b;
}

/** Interpolation from the modulator rate to the output rate: windowed sinc, 8 taps, 1024 phases. */
const TAPS = 8,
	PHASES = 1024;
const INTERP = (() => {
	const tab = new Float64Array(TAPS * PHASES);
	for (let p = 0; p < PHASES; p++) {
		let sum = 0;
		for (let k = 0; k < TAPS; k++) {
			const x = k - 3 - p / PHASES;
			const s = Math.abs(x) < 1e-12 ? 0.7 : Math.sin(0.7 * Math.PI * x) / (Math.PI * x);
			const w = Math.abs(x) >= 4 ? 0 : 0.42 + 0.5 * Math.cos((Math.PI * x) / 4) + 0.08 * Math.cos((2 * Math.PI * x) / 4);
			tab[p * TAPS + k] = s * w;
			sum += s * w;
		}
		for (let k = 0; k < TAPS; k++) tab[p * TAPS + k] /= sum;
	}
	return tab;
})();

/**
 * The test signal at `rate`: P channels `channels` ({ bitRate, offsetHz, cfoHz, driftHzS, positions }), Eb/N0 per channel
 * bit `ebn0Db` against white noise over the sampled band (none when `noiseless`), bit clocks off by `clockPpm`.
 */
export class AeroSignal {
	constructor({ rate = 48000, channels, ebn0Db = 12, seed = 1, clockPpm = 0, noiseless = false }) {
		this.rate = rate;
		this.noise = gaussian(seed * 7919 + 13);
		const ebn0 = 10 ** (ebn0Db / 10);
		this.chans = channels.map((def, idx) => {
			const fsG = def.bitRate === 10500 ? 8 * def.bitRate : 16 * def.bitRate;
			return {
				def,
				fsG,
				src: new SynthChannel(idx, def, seed),
				mod: new AeroModulator(def.bitRate, fsG, clockPpm),
				amp: Math.sqrt((ebn0 * def.bitRate * 2) / rate),
				buf: new Float32Array(0),
				bufBase: 0,
				pos: 3,
				phase: 0,
			};
		});
		const S = this.chans.reduce((a, k) => a + k.amp, 0);
		this.sigma = noiseless ? 0 : Math.min(0.12, 0.85 / (1.6 * S + 4));
		for (const k of this.chans) k.amp *= noiseless ? 0.85 / (1.6 * S) : this.sigma;
		this.t = 0;
	}
	/** What went out: frames, messages and log-ons per channel. */
	get sent() {
		return this.chans.map((k) => k.src.sent);
	}
	/** Modulator output up to input sample `need` of channel k. */
	fill(k, need) {
		while (k.bufBase + k.buf.length / 2 < need) {
			while (k.mod.queuedBits < 64 + 2048 / (k.fsG / k.def.bitRate)) k.mod.pushBits(k.src.nextFrame());
			const keep = Math.max(0, Math.floor(k.pos) - 8 - k.bufBase);
			const old = k.buf.subarray(2 * keep);
			const next = new Float32Array(old.length + 4096);
			next.set(old);
			k.mod.generate(next, old.length / 2, 2048);
			k.buf = next;
			k.bufBase += keep;
		}
	}
	/** The next `n` complex samples, interleaved. */
	generate(n) {
		const out = new Float32Array(2 * n);
		for (const k of this.chans) this.addChannel(k, out, n);
		if (this.sigma) for (let i = 0; i < 2 * n; i++) out[i] += this.sigma * this.noise();
		this.t += n / this.rate;
		return out;
	}
	addChannel(k, out, n) {
		const step = k.fsG / this.rate;
		const d = k.def;
		for (let j = 0; j < n; j++) {
			const i0 = Math.floor(k.pos);
			this.fill(k, i0 + 5);
			const ph = Math.min(PHASES - 1, Math.floor((k.pos - i0) * PHASES));
			let re = 0,
				im = 0;
			for (let q = 0; q < TAPS; q++) {
				const at = 2 * (i0 - 3 + q - k.bufBase);
				re += INTERP[ph * TAPS + q] * k.buf[at];
				im += INTERP[ph * TAPS + q] * k.buf[at + 1];
			}
			const c = Math.cos(k.phase),
				s = Math.sin(k.phase);
			out[2 * j] += (re * c - im * s) * k.amp;
			out[2 * j + 1] += (re * s + im * c) * k.amp;
			const f = d.offsetHz + (d.cfoHz ?? 0) + (d.driftHzS ?? 0) * (this.t + j / this.rate);
			k.phase = (k.phase + (2 * Math.PI * f) / this.rate) % (2 * Math.PI);
			k.pos += step;
		}
	}
}
