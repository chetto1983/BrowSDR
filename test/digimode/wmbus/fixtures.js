// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR tests from OnAir core/src/wmbus/wmbus_gen.cpp (simulated meters, GFSK bursts) and
// wmbus_proto.cpp (buildFrame, encodeChips), https://github.com/adswill/OnAir; see third_party/onair. Changes: the headers
// and deviations are those of EN 13757-4 (minimum preambles of 279 chip pairs for S1, 19 for T1 and 16 for C1, the
// 18-chip S1 sync word, ±45 kHz for C1) in place of OnAir's 20 pairs and 16-chip sync words and ±50 kHz throughout; the
// encrypted meter names its 2 encrypted blocks in the configuration word; one signal per call, bursts in sequence.

import { crc16, encode36, mfrStringToCode } from '@/worker/decoders/digimode/wmbus/proto';
import { noise } from '../fixtures';

function bcd(out, value, bytes) {
	let v = value;
	for (let i = 0; i < bytes; i++) {
		out.push(((Math.floor(v / 10) % 10) << 4) | (v % 10));
		v = Math.floor(v / 100);
	}
}

function le(out, value, bytes) {
	let v = value;
	for (let i = 0; i < bytes; i++) {
		out.push(v & 0xff);
		v = Math.floor(v / 256);
	}
}

/** The simulated meters of OnAir's 868 MHz test signal (the R2 heat cost allocator is not received here). */
export const METERS = [
	{ mfr: 'KAM', id: 12345678, version: 0x1b, type: 0x07, phy: 'S1', encrypted: false }, // water
	{ mfr: 'ELV', id: 40112233, version: 0x2a, type: 0x04, phy: 'T1', encrypted: false }, // heat
	{ mfr: 'EMH', id: 50667788, version: 0x01, type: 0x02, phy: 'T1', encrypted: true }, // electricity, encrypted
	{ mfr: 'GWF', id: 61000042, version: 0x03, type: 0x03, phy: 'C1A', encrypted: false }, // gas
	{ mfr: 'SEN', id: 72004711, version: 0x0c, type: 0x16, phy: 'C1B', encrypted: false }, // cold water, a long format B frame
];

/** The bytes as sent (with the CRCs) for the logical frame C M A CI data (given without L). */
export function buildFrame(body, formatB) {
	const out = [];
	const putCrc = (bytes) => {
		const crc = crc16(Uint8Array.from(bytes));
		out.push(...bytes, crc >> 8, crc & 0xff);
	};
	if (!formatB) {
		const plain = [body.length, ...body];
		putCrc(plain.slice(0, 10));
		for (let pos = 10; pos < plain.length; pos += 16) putCrc(plain.slice(pos, pos + 16));
	} else {
		const crcs = 1 + body.length + 2 <= 128 ? 1 : 2;
		const plain = [body.length + crcs * 2, ...body];
		if (crcs === 1) putCrc(plain);
		else {
			putCrc(plain.slice(0, 126));
			putCrc(plain.slice(126));
		}
	}
	return Uint8Array.from(out);
}

function readings(b, meter, count) {
	switch (meter.type) {
		case 0x07:
		case 0x16: // water: volume (litres, 8 digits), volume at the due date, due date, flow, error flags
			b.push(0x0c, 0x13);
			bcd(b, 123456 + 3 * count, 4);
			b.push(0x4c, 0x13);
			bcd(b, 120000, 4);
			b.push(0x42, 0x6c);
			le(b, 0x3a21, 2);
			b.push(0x02, 0x3b);
			le(b, 40 + (count % 17), 2);
			b.push(0x01, 0xfd, 0x17, 0x00);
			if (meter.phy === 'C1B') {
				// monthly values, so that the frame has two blocks
				for (let k = 1; k <= 24; k++) {
					b.push(0xcc, k & 15, 0x13);
					bcd(b, 100000 + 100 * k, 4);
				}
			}
			break;
		case 0x04: // heat: energy, volume, power, flow and return temperature
			b.push(0x0c, 0x06);
			bcd(b, 8123456 + count, 4);
			b.push(0x0c, 0x13);
			bcd(b, 450000 + 7 * count, 4);
			b.push(0x0b, 0x2d);
			bcd(b, 342 + (count % 9), 3);
			b.push(0x0a, 0x5a);
			bcd(b, 652 + (count % 5), 2);
			b.push(0x0a, 0x5e);
			bcd(b, 412, 2);
			break;
		default: // gas: volume in 0.1 m3, date
			b.push(0x0c, 0x15);
			bcd(b, 2345678 + count, 4);
			b.push(0x02, 0x6c);
			le(b, 0x3a21, 2);
	}
}

/** The frame bytes (with the CRCs) of simulated meter `index` at transmission `count`. */
export function meterFrame(index, count) {
	const meter = METERS[index];
	const b = [0x44]; // C: SND-NR
	le(b, mfrStringToCode(meter.mfr), 2);
	bcd(b, meter.id, 4);
	b.push(meter.version, meter.type, 0x7a, count & 0xff, 0x00); // CI: short header, access number, status
	if (meter.encrypted) {
		b.push(0x20, 0x05); // configuration word: mode 5, 2 encrypted blocks
		let x = (Math.imul(meter.id, 2654435761) + count) >>> 0;
		for (let i = 0; i < 32; i++) {
			x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
			b.push(x >>> 24);
		}
		return { phy: meter.phy, air: buildFrame(b, false) };
	}
	b.push(0x00, 0x00);
	readings(b, meter, count);
	return { phy: meter.phy, air: buildFrame(b, meter.phy === 'C1B') };
}

const CHIP_RATES = { S1: 32768, T1: 100000, C1A: 100000, C1B: 100000 };
/** Nominal deviations of EN 13757-4. */
export const DEVIATIONS = { S1: 50000, T1: 50000, C1A: 45000, C1B: 45000 };

const pushBits = (chips, value, bits) => {
	for (let i = bits - 1; i >= 0; i--) chips.push((value >> i) & 1);
};

/** The chips on air (1 = upper frequency): preamble, sync word, [C-mode format marker], coded bytes, a short tail. */
export function encodeChips(phy, air, { preamblePairs } = {}) {
	const chips = [];
	const pairs = preamblePairs ?? { S1: 279, T1: 19, C1A: 16, C1B: 16 }[phy];
	for (let i = 0; i < pairs; i++) chips.push(0, 1);
	if (phy === 'S1') pushBits(chips, 0b000111011010010110, 18);
	else if (phy === 'T1') pushBits(chips, 0b0000111101, 10);
	else pushBits(chips, phy === 'C1A' ? 0x543d54cd : 0x543d543d, 32);
	for (const byte of air) {
		if (phy === 'S1')
			for (let i = 7; i >= 0; i--) {
				const bit = (byte >> i) & 1;
				chips.push(bit, bit ^ 1);
			}
		else if (phy === 'T1') {
			pushBits(chips, encode36(byte >> 4), 6);
			pushBits(chips, encode36(byte & 15), 6);
		} else pushBits(chips, byte, 8);
	}
	for (let i = 0; i < 4; i++) chips.push(0, 1);
	return chips;
}

/**
 * Bursts of chips as GFSK (two one-pole filters of about 0.3 chip each) at complex `rate`, `offsetHz` off tune, with
 * `gap` seconds of silence before, between and after them and uniform noise of amplitude `noiseLevel`.
 */
export function wmbusSignal(bursts, { rate = 400000, offsetHz = 0, noiseLevel = 0, seed = 1, gap = 0.003, amp = 1 } = {}) {
	const gapSamples = Math.round(gap * rate);
	const spans = [];
	let at = gapSamples;
	for (const { phy, chips, deviation = DEVIATIONS[phy] } of bursts) {
		const chipRate = CHIP_RATES[phy];
		const length = Math.ceil((chips.length / chipRate) * rate + (4 * rate) / chipRate);
		spans.push({ chips, chipRate, deviation, start: at, end: at + length });
		at += length + gapSamples;
	}
	const iq = new Float32Array(at * 2);
	const random = noise(seed);
	for (const { chips, chipRate, deviation, start, end } of spans) {
		const a = 1 - Math.exp(-chipRate / rate / 0.32);
		let f1 = 0;
		let f2 = 0;
		let phase = 0;
		for (let i = start; i < end; i++) {
			const k = Math.floor(((i - start) * chipRate) / rate);
			const target = k < chips.length ? (chips[k] ? 1 : -1) : 0;
			f1 += a * (target - f1);
			f2 += a * (f1 - f2);
			phase += (2 * Math.PI * (offsetHz + deviation * f2)) / rate;
			iq[2 * i] = amp * Math.cos(phase);
			iq[2 * i + 1] = amp * Math.sin(phase);
		}
	}
	if (noiseLevel) for (let i = 0; i < iq.length; i++) iq[i] += noiseLevel * random();
	return iq;
}

/** A meter's telegram as one burst for wmbusSignal. */
export function meterBurst(index, count = 5, options) {
	const { phy, air } = meterFrame(index, count);
	return { phy, chips: encodeChips(phy, air, options) };
}
