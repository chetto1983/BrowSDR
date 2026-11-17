// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Adapted from OnAir core/src/orbcomm/orbcomm_gen.cpp; deterministic test transmitter.
const RATE = 48000;
const BAUD = 4800;

function checksum(packet) {
	let first = 0;
	let second = 0;
	for (let i = 0; i < 10; i++) {
		first = (first + packet[i]) & 255;
		second = (second + first) & 255;
	}
	packet[10] = (512 - ((first + second) & 255)) & 255;
	packet[11] = second;
	return packet;
}

function packet(code, body = []) {
	const result = new Uint8Array(12);
	result[0] = code;
	result.set(body, 1);
	return checksum(result);
}

function ephemeris() {
	const values = [7000 * 64, 0, 1000 * 64, 1234];
	const widths = [20, 20, 20, 12];
	const bits = [];
	for (let i = 0; i < values.length; i++) for (let b = 0; b < widths[i]; b++) bits.push((values[i] >>> b) & 1);
	const result = packet(0x1f);
	for (let i = 0; i < bits.length; i++) result[1 + (i >> 3)] |= bits[i] << (i & 7);
	return checksum(result);
}

export function frame(number, satellite = 23, breakPacket = false) {
	const packets = Array.from({ length: 50 }, () => packet(0x1e));
	packets[0] = packet(0x65, [0xa8, 0xf9, satellite, number]);
	packets[1] = ephemeris();
	packets[2] = packet(0x1c, [2, 100, 0, 115, 0]);
	packets[3] = packet(0x1b, [1, 200, 0]);
	packets[4] = packet(0x1d, [7, 0x81]);
	packets[5] = packet(0x22, [satellite, 0x94, 0x11, 0xd0, 0x07, 0xa0, 0x0f, 0x74, 0x27]);
	packets[6] = packet(0x1a, [42, 0, ...Array.from('HELLO W', (c) => c.charCodeAt(0))]);
	packets[7] = packet(0x1a, [42, 0x81, ...Array.from('ORLD   ', (c) => c.charCodeAt(0))]);
	if (breakPacket) packets[8][3] ^= 0x40;
	return packets;
}

function pulse(t) {
	const a = 0.4;
	if (Math.abs(t) < 1e-9) return 1 - a + (4 * a) / Math.PI;
	if (Math.abs(Math.abs(t) - 1 / (4 * a)) < 1e-9)
		return (a / Math.SQRT2) * ((1 + 2 / Math.PI) * Math.sin(Math.PI / (4 * a)) + (1 - 2 / Math.PI) * Math.cos(Math.PI / (4 * a)));
	return (Math.sin(Math.PI * t * (1 - a)) + 4 * a * t * Math.cos(Math.PI * t * (1 + a))) / (Math.PI * t * (1 - 16 * a * a * t * t));
}

/** Independent pulse-shaped SDPSK transmitter, with a carrier offset and clock error. */
export function signal({ seconds = 3, satellite = 23, offsetHz = 1200, clockPpm = 0, breakPacket = false, rate = RATE } = {}) {
	const frames = Array.from({ length: Math.ceil(seconds) + 2 }, (_, i) => frame(i, satellite, breakPacket));
	const symbols = [];
	let re = 1;
	let im = 0;
	for (const packets of frames)
		for (const bytes of packets)
			for (const byte of bytes)
				for (let bit = 0; bit < 8; bit++) {
					const one = (byte >> bit) & 1;
					const nextRe = one ? -im : im;
					im = one ? re : -re;
					re = nextRe;
					symbols.push([re, im]);
				}
	const samples = Math.round(seconds * rate);
	const iq = new Float32Array(samples * 2);
	const speed = (BAUD * (1 + clockPpm / 1e6)) / rate;
	for (let n = 0; n < samples; n++) {
		const symbolTime = n * speed;
		const base = Math.floor(symbolTime);
		let i = 0;
		let q = 0;
		for (let k = Math.max(0, base - 5); k <= Math.min(symbols.length - 1, base + 6); k++) {
			const weight = pulse(symbolTime - k);
			i += symbols[k][0] * weight;
			q += symbols[k][1] * weight;
		}
		const phase = (2 * Math.PI * offsetHz * n) / rate;
		iq[2 * n] = i * Math.cos(phase) - q * Math.sin(phase);
		iq[2 * n + 1] = i * Math.sin(phase) + q * Math.cos(phase);
	}
	return iq;
}
