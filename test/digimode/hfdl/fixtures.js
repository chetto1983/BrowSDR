// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir core/src/hfdl/hfdl_gen.cpp (pulse, hfdlMakeWave, hfdlRender,
// hfdlBurstSeconds, HfdlTraffic, the noise of HfdlSynth), core/src/hfdl/hfdl_proto.cpp (hfdlBurst and the PDU builders:
// hfdlSpdu, hfdlLpdu, hfdlLogonRequest, hfdlLogonConfirm, hfdlUnnumbered, hfdlPerfData, hfdlFreqData, hfdlAcarsHfnpdu,
// hfdlMpduDown, hfdlMpduUp) and the play() helpers of tests/hfdl/test_hfdl_rx.cpp, https://github.com/adswill/OnAir;
// see third_party/onair. Changes: a seeded generator of BrowSDR's (OnAir's PortableRng is not ported, so the noise and
// fading differ from OnAir's runs); the signal is made at the decoder's channel rate (7200 Hz around the carrier) or at
// any capture rate with the carrier where the test puts it; the traffic of one channel only.
//
// HFDL test signal: PSK bursts (root raised cosine, roll-off 0.35, 1800 baud) with the real burst structure (prekey, A1,
// A2, M1, M2, training, data blocks with probes, scrambled, interleaved, K = 7 coded). Synthetic content: flights,
// registrations and texts are made up.

import { rrc } from '@/worker/decoders/digimode/hfdl/front';
import {
	BLOCK_LEN,
	DATA_LEN,
	HFDL_BAUD,
	PREKEY,
	T_SEQ,
	burstSeconds,
	burstSyms,
	codedBits,
	convEncode,
	hfdlFcs,
	hfdlRate,
	interleave,
	payloadOctets,
	preambleRef,
	scramblerSigns,
	pskIm,
	pskRe,
} from '@/worker/decoders/digimode/hfdl/phy';
import { hfdlStation } from '@/worker/decoders/digimode/hfdl/stations';
import { acarsBuildFrame } from '../vdl2-fixtures';

export { burstSeconds };
export const RATE = 7200;

// ---------------------------------------------------------------- random numbers

/** A seeded generator: uniform in [0, 1) and Gaussian (Box-Muller). */
export function rng(seed) {
	let x = (seed * 2654435761 + 0x9e3779b9) >>> 0 || 1;
	const uniform = () => {
		x ^= x << 13;
		x >>>= 0;
		x ^= x >>> 17;
		x ^= x << 5;
		x >>>= 0;
		return x / 2 ** 32;
	};
	let spare = null;
	const gauss = (sigma = 1) => {
		if (spare !== null) {
			const v = spare;
			spare = null;
			return v * sigma;
		}
		const u = Math.max(1e-12, uniform());
		const v = uniform();
		const r = Math.sqrt(-2 * Math.log(u));
		spare = r * Math.sin(2 * Math.PI * v);
		return r * Math.cos(2 * Math.PI * v) * sigma;
	};
	return { uniform, gauss };
}

// ---------------------------------------------------------------- PDU builders (hfdl_proto.cpp)

const crc = (bytes) => hfdlFcs(Uint8Array.from(bytes));

/** A squitter: { gsId, utc, frameIndex, changeNote, version, mask, systable, other: [{ id, utc, mask }, { id, utc, mask }] }. */
export function spdu({ gsId = 1, utc = true, frameIndex = 0, changeNote = 0, version = 0, mask = 0, systable = 50, other = [] } = {}) {
	const b = new Array(66).fill(0);
	const a = other[0] ?? { id: 0, utc: true, mask: 0 };
	const c = other[1] ?? { id: 0, utc: true, mask: 0 };
	b[0] = ((version & 3) << 2) | 0x20 | ((changeNote & 3) << 6);
	b[1] = (gsId & 0x7f) | (utc ? 0x80 : 0);
	b[2] = frameIndex & 0xff;
	b[3] = (frameIndex >> 8) & 0xf;
	b[53] = systable & 0xff;
	b[54] = ((systable >> 8) & 0xf) | ((mask & 0xf) << 4);
	b[55] = (mask >> 4) & 0xff;
	b[56] = (mask >> 12) & 0xff;
	b[57] = (a.id & 0x7f) | (a.utc ? 0x80 : 0);
	b[58] = a.mask & 0xff;
	b[59] = (a.mask >> 8) & 0xff;
	b[60] = ((a.mask >> 16) & 0xf) | ((c.id & 0xf) << 4);
	b[61] = ((c.id >> 4) & 7) | (c.utc ? 8 : 0) | ((c.mask & 0xf) << 4);
	b[62] = (c.mask >> 4) & 0xff;
	b[63] = (c.mask >> 12) & 0xff;
	const f = crc(b.slice(0, 64));
	b[64] = f & 0xff;
	b[65] = f >> 8;
	return b;
}

/** An LPDU: type, body, FCS. */
export function lpdu(type, body) {
	const o = [type, ...body];
	const f = crc(o);
	return [...o, f & 0xff, f >> 8];
}

const rev8 = (x) => {
	let v = ((x >> 4) | (x << 4)) & 0xff;
	v = ((v & 0xcc) >> 2) | ((v & 0x33) << 2);
	return ((v & 0xaa) >> 1) | ((v & 0x55) << 1);
};
/** On air the three ICAO octets are bit-reversed (the octet order kept). */
const icaoWire = (icao) => [rev8((icao >> 16) & 0xff), rev8((icao >> 8) & 0xff), rev8(icao & 0xff)];

export const logonRequest = (icao) => lpdu(0x8f, icaoWire(icao));
export const logonConfirm = (icao, acId) => lpdu(0x9f, [...icaoWire(icao), acId & 0xff, 0, 0, 0]);
export const logoff = (icao, reason = 0) => lpdu(0x3f, [...icaoWire(icao), reason]);
export const unnumbered = (h) => lpdu(0x0d, h);

const coordRaw = (deg) => Math.max(-524288, Math.min(524287, Math.round((deg * 524288) / 180))) & 0xfffff;
function putPosTime(o, flight, lat, lon, utcSec) {
	for (let i = 0; i < 6; i++) o.push(i < flight.length ? flight.charCodeAt(i) : 0x20);
	const la = coordRaw(lat);
	const lo = coordRaw(lon);
	o.push(la & 0xff, (la >> 8) & 0xff, ((la >> 16) & 0xf) | ((lo & 0xf) << 4), (lo >> 4) & 0xff, (lo >> 12) & 0xff);
	const t2 = Math.trunc(Math.max(0, utcSec) / 2);
	o.push(t2 & 0xff, (t2 >> 8) & 0xff);
}

/** Performance data (HFNPDU 0xD1, 47 octets). */
export function perfData(flight, lat, lon, utcSec, gsId, freqId) {
	const o = [0xff, 0xd1];
	putPosTime(o, flight, lat, lon, utcSec);
	o.push(2, 1, gsId & 0x7f, freqId);
	while (o.length < 47) o.push(0);
	o[27] = 3;
	o[35] = 12;
	return o;
}

/** Frequency data (HFNPDU 0xD5): heard = [{ id, mask }]. */
export function freqData(flight, lat, lon, utcSec, heard) {
	const o = [0xff, 0xd5];
	putPosTime(o, flight, lat, lon, utcSec);
	for (const { id, mask } of heard.slice(0, 6))
		o.push(id & 0x7f, mask & 0xff, (mask >> 8) & 0xff, ((mask >> 16) & 0xf) | ((mask & 0xf) << 4), (mask >> 4) & 0xff, (mask >> 12) & 0xff);
	return o;
}

/** An ACARS block as an HFNPDU: FF FF, then SOH, the block, check bytes, DEL. */
export const acarsHfnpdu = (reg, label, blockId, text) => [0xff, 0xff, ...acarsBuildFrame({ reg, label, blockId, text }).slice(2)];

/** A downlink MPDU of one aircraft. */
export function mpduDown(gsId, acId, lpdus) {
	const o = [0x03 | ((lpdus.length & 0xf) << 2), gsId & 0x7f, acId & 0xff, 0, 0, 0, ...lpdus.map((x) => x.length - 1)];
	const f = crc(o);
	return [...o, f & 0xff, f >> 8, ...lpdus.flat()];
}

/** An uplink MPDU to one aircraft. */
export function mpduUp(gsId, acId, lpdus) {
	const o = [0x01, gsId & 0x7f, acId & 0xff, (lpdus.length & 0xf) << 4, ...lpdus.map((x) => x.length - 1)];
	const f = crc(o);
	return [...o, f & 0xff, f >> 8, ...lpdus.flat()];
}

// ---------------------------------------------------------------- the burst (hfdlBurst)

/** The complex symbols of one burst (prekey included), unit amplitude: { re, im }. */
export function burstSymbols(m1, pdu) {
	const r = hfdlRate(m1);
	const n = codedBits(m1);
	const info = n / (r.quarter ? 4 : 2);
	const bits = new Uint8Array(info);
	const octets = Math.min(pdu.length, payloadOctets(m1));
	for (let i = 0; i < octets; i++) for (let b = 0; b < 8; b++) bits[i * 8 + b] = (pdu[i] >> b) & 1;
	let c = convEncode(bits);
	if (r.quarter) c = Uint8Array.from({ length: 2 * c.length }, (_, k) => c[k >> 1]);
	const pos = interleave(m1);
	const chan = new Uint8Array(n);
	for (let j = 0; j < n; j++) chan[pos[j]] = c[j];
	const total = PREKEY + burstSyms(m1);
	const re = new Float64Array(total);
	const im = new Float64Array(total);
	let k = 0;
	for (let i = 0; i < PREKEY; i++) re[k++] = T_SEQ[i % 15];
	for (const v of preambleRef(m1)) re[k++] = v;
	const scr = scramblerSigns(r.blocks * DATA_LEN);
	let di = 0;
	for (let b = 0; b < r.blocks; b++) {
		for (let q = 0; q < DATA_LEN; q++, di++) {
			let v = 0;
			for (let s = 0; s < r.bitsPerSym; s++) v |= chan[di * r.bitsPerSym + s] << s;
			re[k] = pskRe(r.bitsPerSym, v) * scr[di];
			im[k++] = pskIm(r.bitsPerSym, v) * scr[di];
		}
		for (let q = 0; q < 15; q++) re[k++] = T_SEQ[q];
	}
	if (k !== PREKEY + burstSyms(m1) || BLOCK_LEN !== 45) throw new Error('burst length');
	return { re, im };
}

// ---------------------------------------------------------------- the waveform (hfdl_gen.cpp)

const SPS = 8;
const SPAN = 6;
const PULSE_RES = 128;
const PULSE = Float64Array.from({ length: 2 * SPAN * PULSE_RES + 2 }, (_, i) => rrc(i / PULSE_RES - SPAN, 0.35));
function pulseAt(t) {
	const u = (t + SPAN) * PULSE_RES;
	if (u < 0 || u >= 2 * SPAN * PULSE_RES) return 0;
	const i = Math.floor(u);
	const f = u - i;
	return PULSE[i] * (1 - f) + PULSE[i + 1] * f;
}
function cubic(x, pos) {
	const i = Math.floor(pos);
	const f = pos - i;
	const at = (k) => (k >= 0 && k < x.length ? x[k] : 0);
	const [a, b, c, d] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
	const c1 = 0.5 * (c - a);
	const c2 = a - 2.5 * b + 2 * c - 0.5 * d;
	const c3 = 0.5 * (d - a) + 1.5 * (b - c);
	return ((c3 * f + c2) * f + c1) * f + b;
}

/**
 * One burst as a waveform at 8 samples per symbol around 0 Hz: { re, im } with re[0] 6 symbols before the first
 * symbol. `paths` ({ delaySec, gainDb, spreadHz, shiftHz }): an HF channel, each path faded by a sum of 12 sinusoids
 * with Gaussian Doppler frequencies of the given two-sided spread.
 */
export function makeWave(m1, pdu, paths = [], seed = 1) {
	const s = burstSymbols(m1, pdu);
	const maxDelay = Math.max(0, ...paths.map((p) => p.delaySec));
	const extra = Math.ceil(maxDelay * HFDL_BAUD * SPS) + 2;
	const n = (s.re.length + 2 * SPAN) * SPS;
	const xr = new Float64Array(n + extra);
	const xi = new Float64Array(n + extra);
	for (let i = 0; i < n; i++) {
		const t = i / SPS - SPAN;
		const k0 = Math.floor(t);
		for (let k = Math.max(0, k0 - SPAN); k <= Math.min(s.re.length - 1, k0 + SPAN + 1); k++) {
			const p = pulseAt(t - k);
			xr[i] += s.re[k] * p;
			xi[i] += s.im[k] * p;
		}
	}
	if (!paths.length) return { re: xr, im: xi };
	const g = rng(seed * 7919 + 13);
	const re = new Float64Array(xr.length);
	const im = new Float64Array(xr.length);
	const fsb = HFDL_BAUD * SPS;
	for (const p of paths) {
		const fd = Array.from({ length: 12 }, () => (p.spreadHz > 0 ? g.gauss(p.spreadHz / 2) : 0));
		const ph = Array.from({ length: 12 }, () => g.uniform() * 2 * Math.PI);
		const gain = 10 ** (p.gainDb / 20);
		const dS = p.delaySec * fsb;
		for (let i = 0; i < re.length; i++) {
			const t = i / fsb;
			let hr = 1;
			let hi = 0;
			if (p.spreadHz > 0) {
				hr = hi = 0;
				for (let k = 0; k < 12; k++) {
					hr += Math.cos(2 * Math.PI * fd[k] * t + ph[k]);
					hi += Math.sin(2 * Math.PI * fd[k] * t + ph[k]);
				}
				hr /= Math.sqrt(12);
				hi /= Math.sqrt(12);
			}
			const sh = 2 * Math.PI * (p.shiftHz ?? 0) * t;
			const cr = gain * (hr * Math.cos(sh) - hi * Math.sin(sh));
			const ci = gain * (hr * Math.sin(sh) + hi * Math.cos(sh));
			const vr = cubic(xr, i - dS);
			const vi = cubic(xi, i - dS);
			re[i] += cr * vr - ci * vi;
			im[i] += cr * vi + ci * vr;
		}
	}
	return { re, im };
}

/**
 * Adds the wave to out (interleaved I/Q, `n` samples from absolute sample `outStart`) at `rate`: its first symbol at
 * sample `start`, the carrier at `carHz`, amplitude `amp`, phase `phase`.
 */
export function render(w, { start, carHz, amp = 0.1, phase = 0 }, out, outStart, rate) {
	const n = out.length >> 1;
	const step = (SPS * HFDL_BAUD) / rate;
	const off = start - (SPAN * rate) / HFDL_BAUD;
	const i0 = Math.max(0, Math.ceil(off - outStart));
	const i1 = Math.min(n, Math.floor(off + w.re.length / step - outStart));
	const w0 = (2 * Math.PI * carHz) / rate;
	for (let i = i0; i < i1; i++) {
		const o = i + outStart;
		const pos = (o - off) * step;
		const ph = phase + w0 * o;
		const vr = amp * cubic(w.re, pos);
		const vi = amp * cubic(w.im, pos);
		out[2 * i] += vr * Math.cos(ph) - vi * Math.sin(ph);
		out[2 * i + 1] += vr * Math.sin(ph) + vi * Math.cos(ph);
	}
}

/** Noise sigma per component for an Es/N0 of `snrDb` for a burst of amplitude `amp` at `rate` (OnAir's formula). */
export const sigmaFor = (snrDb, amp, rate) => (snrDb >= 99 ? 0 : Math.sqrt(((amp * amp) / 10 ** (snrDb / 10)) * (rate / HFDL_BAUD) * 0.5));

/**
 * The bursts `tx` ({ m1, pdu, t (s), cfo (Hz), levelDb, paths, seed }) in noise at `snrDb`, as interleaved I/Q at
 * `rate`, `secs` long; the carrier at `carHz` + cfo (0 at the decoder's channel rate). Calls `each(block)` per
 * `chunk` samples, or returns the whole signal.
 */
export function play(tx, { snrDb = 30, secs, rate = RATE, carHz = 0, seed = 1, ppm = 0, chunk = 0, each } = {}) {
	const fsEff = rate * (1 + ppm * 1e-6);
	const waves = tx.map((b, i) => ({
		w: makeWave(b.m1, b.pdu, b.paths ?? [], b.seed ?? seed * 31 + i),
		at: { start: b.t * fsEff, carHz: carHz + (b.cfo ?? 0), amp: 0.1 * 10 ** ((b.levelDb ?? 0) / 20), phase: 0.3 + i },
	}));
	const sigma = sigmaFor(snrDb, 0.1, rate);
	const g = rng(seed);
	const total = Math.round(secs * rate);
	const size = chunk || total;
	const all = each ? null : new Float32Array(2 * total);
	for (let pos = 0; pos < total; pos += size) {
		const n = Math.min(size, total - pos);
		const out = new Float64Array(2 * n);
		if (sigma > 0) for (let i = 0; i < out.length; i++) out[i] = g.gauss(sigma);
		for (const { w, at } of waves) render(w, at, out, pos, fsEff);
		if (each) each(Float32Array.from(out));
		else all.set(out, 2 * pos);
	}
	return all;
}

// ---------------------------------------------------------------- traffic (HfdlTraffic, one channel)

const REGS = ['N123UA', 'G-VIIA', 'C-FIUA', 'EI-DUO', 'D-AIMA', 'A6-EUA'];
const FLIGHTS = ['UA0901', 'BA0117', 'AC0848', 'EI0105', 'LH0400', 'EK0201'];
const fullMask = (gs) => {
	const s = hfdlStation(gs);
	return s ? (1 << s.khz.length) - 1 : 1;
};
/** The lowest rate of the same slot count from m1 up that carries len octets. */
function fit(m1, len) {
	if (len <= payloadOctets(m1)) return m1;
	const two = m1 >= 4 ? 4 : 0;
	for (let r = m1 & 3; r < 4; r++) if (len <= payloadOctets(r + two)) return r + two;
	return 7;
}

/** The PDU of an aircraft's step: logon, confirm, performance data, ACARS both ways, frequency data. */
function stepPdu(a, gs, other, ut) {
	switch (a.step) {
		case 0:
			return [mpduDown(gs, 0, [logonRequest(a.icao)]), 0, true];
		case 1:
			return [mpduUp(gs, 0, [logonConfirm(a.icao, a.acId)]), 1, false];
		case 2:
			return [mpduDown(gs, a.acId, [unnumbered(perfData(a.flight, a.lat, a.lon, ut, gs, 0))]), 2, true];
		case 3:
			return [mpduDown(gs, a.acId, [unnumbered(acarsHfnpdu(a.reg, 'H1', '2', `#DFB REQ WX ${a.flight} FL350 M.84`))]), 7, true];
		case 4: {
			const heard = [
				{ id: gs, mask: fullMask(gs) },
				{ id: other, mask: 3 },
			];
			return [mpduDown(gs, a.acId, [unnumbered(freqData(a.flight, a.lat, a.lon, ut, heard))]), 5, true];
		}
		case 5:
			return [mpduUp(gs, a.acId, [unnumbered(acarsHfnpdu(a.reg, 'QA', 'A', 'WX OK. CONTINUE AS FILED'))]), 6, false];
		case 6:
			return [
				mpduDown(gs, a.acId, [unnumbered(acarsHfnpdu(a.reg, '5Z', '3', `/B6 POS N${Math.trunc(a.lat)} W${Math.trunc(-a.lon)}`))]),
				3,
				true,
			];
		default:
			return [mpduUp(gs, a.acId, [unnumbered(acarsHfnpdu(a.reg, 'C1', 'B', 'MSG RCVD'))]), 4, false];
	}
}

/**
 * The traffic of one channel for `frames` 32 s frames: the ground station's squitter in slot 0 of every frame, then
 * aircraft that log on and send performance and frequency data and ACARS (every rate is used), as bursts for play().
 */
export function traffic({ gs = 7, other = 3, aircraft = 3, frames = 3, perFrame = 3, seed = 1, cfoSpreadHz = 30 } = {}) {
	const g = rng(seed);
	const air = Array.from({ length: aircraft }, (_, i) => ({
		icao: 0xa00000 + Math.floor(g.uniform() * 0x5ffff) + i * 0x1000,
		reg: REGS[i % REGS.length],
		flight: FLIGHTS[i % FLIGHTS.length],
		acId: 10 + i,
		step: 0,
		lat: 35 + 25 * g.uniform(),
		lon: -60 + 50 * g.uniform(),
		dlat: (g.uniform() - 0.5) * 0.02,
		dlon: 0.03 + g.uniform() * 0.02,
		level: -10 * g.uniform(),
		cfo: (g.uniform() * 2 - 1) * cfoSpreadHz,
	}));
	const out = [];
	for (let frame = 0; frame < frames; frame++) {
		const t0 = frame * 32;
		const utc = (t0 % 86400) + 36000;
		const sq = spdu({
			gsId: gs,
			frameIndex: (utc / 32) & 0xfff,
			mask: fullMask(gs),
			other: [{ id: other, utc: true, mask: fullMask(other) }],
		});
		out.push({ t: t0 + 0.05, m1: 1, pdu: sq, cfo: 0, levelDb: 0 });
		let slot = 1;
		for (let k = 0, done = 0; k < air.length * perFrame && slot < 13 && done < perFrame; k++) {
			const a = air[(k + frame) % air.length];
			a.lat += a.dlat * 32;
			a.lon += a.dlon * 32;
			const [pdu, want, down] = stepPdu(a, gs, other, utc + slot * 2);
			a.step = a.step >= 7 ? 2 : a.step + 1;
			const m1 = fit(want, pdu.length);
			const need = m1 >= 4 ? 2 : 1;
			if (slot + need > 13) break;
			out.push({ t: t0 + (slot * 32) / 13 + 0.05, m1, pdu, cfo: down ? a.cfo : 0, levelDb: down ? a.level : 0 });
			slot += need;
			done++;
		}
	}
	return out;
}

// ---------------------------------------------------------------- a record's field

export const field = (record, label) => record.fields?.find(([k]) => k === label)?.[1];
