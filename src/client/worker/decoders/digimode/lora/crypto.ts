// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/mesh/mesh_crypto.cpp (AES-128/256 per FIPS 197 with ECB and CTR
// per SP 800-38A, SHA-256 per FIPS 180-4, HMAC-SHA256 per RFC 2104, base64 and hex text helpers) and
// mesh_crypto_tables.cpp (S-box and SHA-256 constants), https://github.com/adswill/OnAir; see third_party/onair. Changes:
// the tables are hex strings decoded at load; one-shot functions on Uint8Arrays. Only public keys ever reach this code
// (the Meshtastic default channel key and the MeshCore Public channel secret).

const hexTable = (hex: string, bytes: number): number[] => {
	const out: number[] = [];
	for (let i = 0; i < hex.length; i += 2 * bytes) out.push(parseInt(hex.slice(i, i + 2 * bytes), 16));
	return out;
};

/** FIPS 197 S-box. */
const SBOX = Uint8Array.from(
	hexTable(
		'637c777bf26b6fc53001672bfed7ab76ca82c97dfa5947f0add4a2af9ca472c0b7fd9326363ff7cc34a5e5f171d8311504c723c31896059a071280e2eb27b2' +
			'7509832c1a1b6e5aa0523bd6b329e32f8453d100ed20fcb15b6acbbe394a4c58cfd0efaafb434d338545f9027f503c9fa851a3408f929d38f5bcb6da2110ff' +
			'f3d2cd0c13ec5f974417c4a77e3d645d197360814fdc222a908846eeb814de5e0bdbe0323a0a4906245cc2d3ac629195e479e7c8376d8dd54ea96c56f4ea65' +
			'7aae08ba78252e1ca6b4c6e8dd741f4bbd8b8a703eb5664803f60e613557b986c11d9ee1f8981169d98e949b1e87e9ce5528df8ca1890dbfe6426841992d0f' +
			'b054bb16',
		1,
	),
);
const INV_SBOX = (() => {
	const t = new Uint8Array(256);
	for (let i = 0; i < 256; i++) t[SBOX[i]] = i;
	return t;
})();

/** FIPS 180-4 SHA-256 round constants and initial hash. */
const SHA256_K = Uint32Array.from(
	hexTable(
		'428a2f9871374491b5c0fbcfe9b5dba53956c25b59f111f1923f82a4ab1c5ed5d807aa9812835b01243185be550c7dc372be5d7480deb1fe9bdc06a7c19bf174' +
			'e49b69c1efbe47860fc19dc6240ca1cc2de92c6f4a7484aa5cb0a9dc76f988da983e5152a831c66db00327c8bf597fc7c6e00bf3d5a7914706ca635114292967' +
			'27b70a852e1b21384d2c6dfc53380d13650a7354766a0abb81c2c92e92722c85a2bfe8a1a81a664bc24b8b70c76c51a3d192e819d6990624f40e3585106aa070' +
			'19a4c1161e376c082748774c34b0bcb5391c0cb34ed8aa4a5b9cca4f682e6ff3748f82ee78a5636f84c878148cc7020890befffaa4506cebbef9a3f7c67178f2',
		4,
	),
);
const SHA256_H0 = Uint32Array.from(hexTable('6a09e667bb67ae853c6ef372a54ff53a510e527f9b05688c1f83d9ab5be0cd19', 4));

const xtime = (a: number): number => ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;
function gmul(a: number, b: number): number {
	let r = 0;
	for (; b; b >>= 1) {
		if (b & 1) r ^= a;
		a = xtime(a);
	}
	return r;
}

/** AES with a 16 or 32 byte key (FIPS 197). */
export class Aes {
	private readonly rk = new Uint8Array(15 * 16);
	private readonly rounds: number;
	private readonly s = new Uint8Array(16);
	private readonly t = new Uint8Array(16);

	/** Throws on a key that is not 16 or 32 bytes. */
	constructor(key: Uint8Array) {
		if (key.length !== 16 && key.length !== 32) throw new Error('AES key must be 16 or 32 bytes');
		const nk = key.length / 4;
		this.rounds = nk + 6;
		const rk = this.rk;
		rk.set(key);
		let rcon = 1;
		const t = new Uint8Array(4);
		for (let i = nk; i < 4 * (this.rounds + 1); i++) {
			t.set(rk.subarray(4 * (i - 1), 4 * i));
			if (i % nk === 0) {
				const f = t[0];
				t[0] = SBOX[t[1]] ^ rcon;
				t[1] = SBOX[t[2]];
				t[2] = SBOX[t[3]];
				t[3] = SBOX[f];
				rcon = xtime(rcon);
			} else if (nk > 6 && i % nk === 4) for (let k = 0; k < 4; k++) t[k] = SBOX[t[k]];
			for (let k = 0; k < 4; k++) rk[4 * i + k] = rk[4 * (i - nk) + k] ^ t[k];
		}
	}

	encryptBlock(input: Uint8Array, out: Uint8Array): void {
		const { s, t, rk, rounds } = this;
		for (let i = 0; i < 16; i++) s[i] = input[i] ^ rk[i];
		for (let r = 1; r <= rounds; r++) {
			for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]];
			// ShiftRows: row k moves left by k
			for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) t[k + 4 * c] = s[k + 4 * ((c + k) & 3)];
			if (r < rounds)
				for (let c = 0; c < 4; c++) {
					const a0 = t[4 * c],
						a1 = t[4 * c + 1],
						a2 = t[4 * c + 2],
						a3 = t[4 * c + 3];
					s[4 * c] = xtime(a0) ^ xtime(a1) ^ a1 ^ a2 ^ a3;
					s[4 * c + 1] = a0 ^ xtime(a1) ^ xtime(a2) ^ a2 ^ a3;
					s[4 * c + 2] = a0 ^ a1 ^ xtime(a2) ^ xtime(a3) ^ a3;
					s[4 * c + 3] = xtime(a0) ^ a0 ^ a1 ^ a2 ^ xtime(a3);
				}
			else s.set(t);
			for (let i = 0; i < 16; i++) s[i] ^= rk[16 * r + i];
		}
		out.set(s);
	}

	decryptBlock(input: Uint8Array, out: Uint8Array): void {
		const { s, t, rk, rounds } = this;
		for (let i = 0; i < 16; i++) s[i] = input[i] ^ rk[16 * rounds + i];
		for (let r = rounds - 1; r >= 0; r--) {
			// InvShiftRows: row k moves right by k
			for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) t[k + 4 * ((c + k) & 3)] = s[k + 4 * c];
			for (let i = 0; i < 16; i++) t[i] = INV_SBOX[t[i]] ^ rk[16 * r + i];
			if (r > 0)
				for (let c = 0; c < 4; c++) {
					const a0 = t[4 * c],
						a1 = t[4 * c + 1],
						a2 = t[4 * c + 2],
						a3 = t[4 * c + 3];
					s[4 * c] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9);
					s[4 * c + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13);
					s[4 * c + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11);
					s[4 * c + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14);
				}
			else s.set(t);
		}
		out.set(s);
	}
}

/** ECB: encrypt zero-pads the last partial block (as MeshCore does). */
export function aesEcbEncrypt(key: Uint8Array, input: Uint8Array): Uint8Array {
	const a = new Aes(key);
	const out = new Uint8Array(Math.ceil(input.length / 16) * 16);
	const blk = new Uint8Array(16);
	for (let o = 0; o < out.length; o += 16) {
		blk.fill(0);
		blk.set(input.subarray(o, o + 16));
		a.encryptBlock(blk, out.subarray(o, o + 16));
	}
	return out;
}

/** ECB: decrypt ignores a partial tail. */
export function aesEcbDecrypt(key: Uint8Array, input: Uint8Array): Uint8Array {
	const a = new Aes(key);
	const out = new Uint8Array(Math.floor(input.length / 16) * 16);
	for (let o = 0; o < out.length; o += 16) a.decryptBlock(input.subarray(o, o + 16), out.subarray(o, o + 16));
	return out;
}

/** CTR (SP 800-38A F.5): the 16 byte counter block is incremented as a big-endian number; in place, both ways. */
export function aesCtr(key: Uint8Array, iv: Uint8Array, data: Uint8Array): void {
	const a = new Aes(key);
	const ctr = Uint8Array.from(iv.subarray(0, 16));
	const ks = new Uint8Array(16);
	for (let o = 0; o < data.length; o += 16) {
		a.encryptBlock(ctr, ks);
		const m = Math.min(16, data.length - o);
		for (let i = 0; i < m; i++) data[o + i] ^= ks[i];
		for (let i = 15; i >= 0; i--) {
			ctr[i] = (ctr[i] + 1) & 0xff;
			if (ctr[i] !== 0) break;
		}
	}
}

const ror = (x: number, s: number): number => (x >>> s) | (x << (32 - s));

/** SHA-256 (FIPS 180-4 6.2), one shot. */
export function sha256(msg: Uint8Array): Uint8Array {
	const total = msg.length;
	const padded = new Uint8Array(Math.ceil((total + 9) / 64) * 64);
	padded.set(msg);
	padded[total] = 0x80;
	const bits = total * 8;
	const dv = new DataView(padded.buffer);
	dv.setUint32(padded.length - 8, Math.floor(bits / 2 ** 32));
	dv.setUint32(padded.length - 4, bits >>> 0);
	const h = Uint32Array.from(SHA256_H0);
	const w = new Uint32Array(64);
	for (let o = 0; o < padded.length; o += 64) {
		for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + 4 * i);
		for (let i = 16; i < 64; i++) {
			const s0 = ror(w[i - 15], 7) ^ ror(w[i - 15], 18) ^ (w[i - 15] >>> 3);
			const s1 = ror(w[i - 2], 17) ^ ror(w[i - 2], 19) ^ (w[i - 2] >>> 10);
			w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
		}
		let [a, b, c, d, e, f, g, hh] = h;
		for (let i = 0; i < 64; i++) {
			const S1 = ror(e, 6) ^ ror(e, 11) ^ ror(e, 25);
			const ch = (e & f) ^ (~e & g);
			const t1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
			const S0 = ror(a, 2) ^ ror(a, 13) ^ ror(a, 22);
			const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
			hh = g;
			g = f;
			f = e;
			e = (d + t1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (t1 + t2) >>> 0;
		}
		[a, b, c, d, e, f, g, hh].forEach((v, i) => (h[i] = (h[i] + v) >>> 0));
	}
	const out = new Uint8Array(32);
	const ov = new DataView(out.buffer);
	for (let i = 0; i < 8; i++) ov.setUint32(4 * i, h[i]);
	return out;
}

/** RFC 2104 / RFC 4231. */
export function hmacSha256(key: Uint8Array, msg: Uint8Array): Uint8Array {
	const k = new Uint8Array(64);
	k.set(key.length > 64 ? sha256(key) : key);
	const inner = new Uint8Array(64 + msg.length);
	for (let i = 0; i < 64; i++) inner[i] = k[i] ^ 0x36;
	inner.set(msg, 64);
	const outer = new Uint8Array(64 + 32);
	for (let i = 0; i < 64; i++) outer[i] = k[i] ^ 0x5c;
	outer.set(sha256(inner), 64);
	return sha256(outer);
}

/** Standard alphabet (and the URL-safe spelling), padding optional, blanks ignored; undefined when not base64. */
export function base64Decode(s: string): Uint8Array | undefined {
	const out: number[] = [];
	let acc = 0,
		bits = 0,
		pad = 0;
	for (const ch of s) {
		if (' \n\r\t'.includes(ch)) continue;
		if (ch === '=') {
			pad++;
			continue;
		}
		if (pad) return;
		const v = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(ch === '-' ? '+' : ch === '_' ? '/' : ch);
		if (v < 0) return;
		acc = ((acc << 6) | v) & 0xffffff;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			out.push((acc >> bits) & 0xff);
		}
	}
	return Uint8Array.from(out);
}

/** Two hex digits per byte, `sep` between them. */
export function hexEncode(p: ArrayLike<number>, upper = false, sep = ''): string {
	let s = '';
	for (let i = 0; i < p.length; i++) s += (i && sep ? sep : '') + p[i].toString(16).padStart(2, '0');
	return upper ? s.toUpperCase() : s;
}
