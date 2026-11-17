// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir core/src/avroad/avroad_air.cpp (ognParity),
// core/src/avroad/ogn_ldpc.inc (kParityGen_n208k160) and tests/avroad/test_avroad_air.cpp (ognPacket, ognChips,
// ognScene) with tests/avroad/avroad_gen.h (appendFsk, mix, addNoise), https://github.com/adswill/OnAir; see
// third_party/onair. As credited there: the LDPC (208,160) tables of the OGN tracker radio protocol are taken from
// OGN-Tracker (Pawel Jalocha) as carried in SoftRF libraries/OGN/ldpc.cpp (GPL-3.0). Changes: the FSK is made into a
// Float32Array of interleaved I/Q; the noise comes from BrowSDR's seeded generator (OnAir: mt19937).

import { gauss } from '../ftx/fixtures';
import { ognWhiten } from '@/worker/decoders/digimode/flarm/ogn-proto';

/** The LDPC generator: 48 parity bits from the 160 data bits, 5 little-endian words per row. */
// prettier-ignore
const PARITY_GEN = new Uint32Array([
	0x40a90281, 0x9159d249, 0xce9d516b, 0x2fdeed0b, 0xd9267cd4,
	0xccbc0fc3, 0xcc4fa4bc, 0x811ec3d0, 0xb07ec1b3, 0xa3b8e8d8,
	0x66418d56, 0x3b85adff, 0xd2a6532e, 0x48cf52e4, 0x6a16586d,
	0x44c71240, 0x2c94631f, 0x15f15a4a, 0x7459d901, 0x037863cc,
	0x7386d718, 0x7f6c9623, 0x738e2e0c, 0xd2351593, 0xef358669,
	0x7bf87232, 0x9e4ccd68, 0xbb82590e, 0x9c9292ea, 0x4ce2aeb9,
	0xaa8436bc, 0x94a61c4d, 0x1da89b11, 0x72eaf204, 0x34d3a041,
	0xbce77760, 0x229935b2, 0xaaf85ce3, 0xffe7b602, 0xf26bcc64,
	0xd0c371d0, 0xa553d12f, 0xa0685bf2, 0x5c553c81, 0x0218eb48,
	0x8d29034d, 0xeb20a394, 0x1a8c82a3, 0x41b4da0c, 0x8632f81e,
	0x15a50876, 0x9bc10f59, 0xf979d1e0, 0xcff6bd88, 0x88fe5895,
	0x037a9ed5, 0xfa5db837, 0x61395aca, 0xe65b5839, 0x9a2d9d02,
	0xee70d18f, 0x8ae909c6, 0x8af5beca, 0x66968559, 0x1bd9b5e7,
	0xc56397ac, 0xd8ff6a30, 0x8e165af3, 0xc01686b9, 0xec26bedc,
	0xb2d63859, 0xfaca8cfd, 0x7ee85eb7, 0x19bfda46, 0xc8c1ca52,
	0xd7eb4d94, 0x426104da, 0x124fbd54, 0xbf610a1d, 0x0e615094,
	0x68efe180, 0x15a1549c, 0x18d20289, 0xbd28ad44, 0x8daddaec,
	0xd7eb4d18, 0x426548da, 0x12cdfd50, 0xbf61081d, 0x0e615094,
	0xc92e426e, 0x648641b5, 0xc16a07b9, 0xa52d48ac, 0x842364ab,
	0xb71dab61, 0x2b15995c, 0x6be7e0c1, 0x97ece351, 0xdf622a04,
	0x55cd7406, 0x5e0f3507, 0x23f6c372, 0x7ecafe84, 0x7e68a8df,
	0x97db831c, 0xd46d648f, 0x14fa22b3, 0x4f875648, 0x94c23936,
	0x60d940ec, 0xfcc18797, 0xd0de7383, 0xf38f22e5, 0x2e7a733e,
	0xd8c22d55, 0x8d45eb4e, 0xac695ff3, 0xded59211, 0x8851288a,
	0xce9d11a1, 0xd8e8f438, 0xaf3102ee, 0xcb2fe547, 0xc11845bd,
	0x61d940ec, 0xacc18f17, 0xd0de7311, 0xe7cf22e5, 0x2e7a6b7e,
	0x66ad8025, 0x493d883c, 0x538e9261, 0x5f0e116b, 0xb17492fa,
	0x747c4c9e, 0x3780804e, 0x29a7b2f1, 0x2838df6d, 0xa68c11eb,
	0x7e33e90f, 0x2fb3d8e9, 0x2a9de538, 0x3ac1abdc, 0x59c14eaf,
	0x16b6095e, 0x4883d57e, 0xf765ff4b, 0x431c6ef3, 0xf2c45f6c,
	0x3f04d4f4, 0xeea73108, 0x567ecf38, 0x15200560, 0x56ab6942,
	0x1e5ecffe, 0x29426f53, 0x17057060, 0xa774ed7f, 0x4fe7eacb,
	0xf9f02a12, 0xfadebee2, 0xbe67eb8b, 0x5506f594, 0xc5037599,
	0x7bf87632, 0x960cc528, 0xbb825d0e, 0x9c929a7a, 0x4ce22fbb,
	0x6e2be90f, 0x2fb3daed, 0x2a9dcd38, 0x1a81a3dc, 0x59c14eaf,
	0x16b6a97a, 0x4883d57e, 0xf765fb49, 0x4bbc7ef3, 0xf2c41f7c,
	0x260c82a4, 0xd8645af5, 0x9913d30a, 0x7158dc67, 0x68526e0a,
	0x5dad3406, 0x5e1f6607, 0xf7f2d35a, 0x5acafea4, 0x3e48a8d7,
	0xaf04d4e4, 0x67232129, 0x567ece20, 0x1d280560, 0x56a96942,
	0xba8536b8, 0x94ae1c4d, 0x5ea81b11, 0x62eaf604, 0xb4d3a141,
	0xdf522858, 0x25ce2c46, 0x6c1e93ba, 0xdb9fbf4e, 0x9f8aacf9,
	0xc92e4e6b, 0x6cd659d5, 0xcd6a03b8, 0x872d423c, 0x0623af69,
	0xd8c20e55, 0x8945eb4e, 0x0c615ff3, 0xfed5d211, 0x8853a88a,
	0x11ec2fbb, 0xe98188fa, 0x6d02584a, 0x7bf87ebd, 0x0c324421,
	0xe1ab0619, 0x62864c22, 0xbc029b88, 0xdc501da2, 0x3db63518,
	0x85657508, 0xe76ce85b, 0x35a012ab, 0xd7719d8d, 0xc1ce9294,
	0x7e33eb0f, 0x2fb3d9f9, 0x2e9de438, 0x3ac1abdc, 0x71814aaf,
	0x55cd3406, 0x5e1f7407, 0x63f2d35a, 0x5acafea4, 0x7e48a8df,
]);

function popcount(value) {
	let x = value - ((value >>> 1) & 0x55555555);
	x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
	return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

/** Writes bytes 20 .. 25 (the parity) from bytes 0 .. 19 (avroad_air.cpp ognParity). */
export function ognParity(p) {
	p.fill(0, 20, 26);
	for (let r = 0; r < 48; r++) {
		let c = 0;
		for (let b = 0; b < 20; b++) c += popcount(p[b] & ((PARITY_GEN[r * 5 + (b >> 2)] >>> ((b & 3) * 8)) & 0xff));
		if (c & 1) p[20 + (r >> 3)] |= 1 << (r % 8);
	}
}

/** An OGN position packet (test_avroad_air.cpp ognPacket): address type OGN, speed 12.3 m/s, heading 180°. */
export function ognPacket(addr, acft, lat, lon, altM, { stealth = false, encrypted = false } = {}) {
	const p = new Uint8Array(26);
	let h = (addr | (3 << 24) | (encrypted ? 1 << 30 : 0)) >>> 0;
	if (popcount(h & 0x0fffffff) & 1) h = (h ^ 0x08000000) >>> 0;
	const la = Math.round(lat * 600000) >> 3;
	const lo = Math.round(lon * 600000) >> 4;
	const w = [
		h,
		((la & 0xffffff) | (12 << 24)) >>> 0,
		lo & 0xffffff,
		(altM | (123 << 14)) >>> 0,
		(512 | (acft << 20) | (stealth ? 1 << 19 : 0)) >>> 0,
	];
	w.forEach((v, i) => {
		for (let k = 0; k < 4; k++) p[4 * i + k] = v >>> (8 * k);
	});
	if (!encrypted) ognWhiten(p);
	ognParity(p);
	return p;
}

/** Manchester chips (a 1 is chips 01) of a preamble, the sync word 0x0AF3656C and the packet. */
export function ognChips(p, preamble = 8) {
	const c = [];
	const man = (b) => c.push(b ^ 1, b);
	for (let i = 0; i < preamble; i++) man(i & 1);
	for (let i = 31; i >= 0; i--) man((0x0af3656c >>> i) & 1);
	for (const v of p) for (let i = 7; i >= 0; i--) man((v >> i) & 1);
	return c;
}

/** Plain 2-FSK ±50 kHz at 100 kchip/s (avroad_gen.h appendFsk) for every packet, a gap after each, mixed to `chanHz`. */
export function ognScene(rate, chanHz, packets, { ppm = 0, gap = 0.02, amp = 1 } = {}) {
	const out = [];
	const spc = (rate / 100000) * (1 + ppm * 1e-6);
	let ph = 0;
	const silence = (sec) => {
		for (let i = Math.floor(rate * sec); i > 0; i--) out.push(0, 0);
	};
	silence(0.01);
	for (const p of packets) {
		const chips = ognChips(p);
		let acc = 0;
		for (let i = 0; i < chips.length;) {
			ph += (2 * Math.PI * (chips[i] ? 50000 : -50000)) / rate;
			out.push(amp * Math.cos(ph), amp * Math.sin(ph));
			if (++acc >= spc) {
				acc -= spc;
				i++;
			}
		}
		silence(gap);
	}
	const iq = Float32Array.from(out);
	const d = (2 * Math.PI * chanHz) / rate;
	for (let n = 0; n < iq.length >> 1; n++) {
		const [c, s] = [Math.cos(d * n), Math.sin(d * n)];
		const [re, im] = [iq[2 * n], iq[2 * n + 1]];
		iq[2 * n] = re * c - im * s;
		iq[2 * n + 1] = re * s + im * c;
	}
	return iq;
}

/** Complex white noise for an SNR of a unit signal over the whole band (avroad_gen.h addNoise). */
export function addNoise(iq, snrDb, seed) {
	const sigma = Math.sqrt(1 / 10 ** (snrDb / 10) / 2);
	const g = gauss(seed);
	for (let i = 0; i < iq.length; i++) iq[i] += sigma * g();
	return iq;
}
