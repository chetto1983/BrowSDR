// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir tests/avroad/test_avroad_air.cpp (fanetTrack: a tracking frame;
// fanetIq: FANET frames through the LoRa transmitter, SF7, 4/5, preamble 12, sync word 0xF1, with a carrier offset and a
// clock error), https://github.com/adswill/OnAir; see third_party/onair. Format facts as credited there: the FANET
// protocol description (protocol.txt of Skytraxx's fanet-stm32, https://github.com/3s1d/fanet-stm32). Changes: the
// tracking builder takes the online-tracking bit, motion bytes and the optional turn rate / QNE bytes; builders of the
// other frame types written from the protocol description; the frames go through BrowSDR's test modulator
// (test/digimode/lora/phy.js) over white noise at an SNR in the LoRa bandwidth, streamed into the decoder in chunks.

import { FanetDecoder, FANET_250 } from '@/worker/decoders/digimode/fanet';
import { loraParams } from '@/worker/decoders/digimode/lora/code';
import { streamSignal, txFrame } from '../lora/phy';

/** C lround. */
const lround = (x) => Math.sign(x) * Math.round(Math.abs(x));
const le24 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff];
/** An absolute FANET position: latitude x 93206, longitude x 46603, 24 bits each. */
export const position = (lat, lon) => [...le24(lround(lat * 93206)), ...le24(lround(lon * 46603))];
const header = (type, mfg, dev) => [type, mfg, dev & 0xff, (dev >> 8) & 0xff];

/** OnAir's fanetTrack: a paraglider, 20 km/h, climbing 1.2 m/s, heading 90°; `extra` bytes (turn rate, QNE) appended. */
export function fanetTrack(
	mfg,
	dev,
	lat,
	lon,
	alt,
	{ online = true, aircraft = 1, speed = 40, climb = 12, heading = 64, extra = [] } = {},
) {
	const t = (alt & 0x7ff) | (aircraft << 12) | (online ? 1 << 15 : 0);
	return Uint8Array.from([...header(1, mfg, dev), ...position(lat, lon), t & 0xff, t >> 8, speed, climb, heading, ...extra]);
}

const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));

export const fanetName = (mfg, dev, name) => Uint8Array.from([...header(2, mfg, dev), ...ascii(name)]);

/** A message, broadcast or (with an extended header) unicast to [manufacturer, device]. */
export function fanetMessage(mfg, dev, text, to) {
	const head = to ? [0x83, mfg, dev & 0xff, dev >> 8, 0x20, to[0], to[1] & 0xff, to[1] >> 8] : header(3, mfg, dev);
	return Uint8Array.from([...head, 0, ...ascii(text)]);
}

/** A ground tracking frame: the state in the high nibble, the online-tracking bit in bit 0. */
export const fanetGround = (mfg, dev, lat, lon, state, online = true) =>
	Uint8Array.from([...header(7, mfg, dev), ...position(lat, lon), (state << 4) | (online ? 1 : 0)]);

/** A weather station: temperature, wind, humidity and pressure (header 0x78), a position. */
export const fanetWeather = (mfg, dev, lat, lon) =>
	Uint8Array.from([...header(4, mfg, dev), 0x78, ...position(lat, lon), 30, 192, 50, 0x80 | 15, 150, 0x9c, 0x16]);

/** A thermal: 1500 m at quality 5 of 7, the air climbing 2.5 m/s, wind 10 km/h from 270°. */
export function fanetThermal(mfg, dev, lat, lon) {
	const t = 1500 / 4 + 0x800 + (5 << 12);
	return Uint8Array.from([...header(9, mfg, dev), ...position(lat, lon), t & 0xff, t >> 8, 25, 20, 192]);
}

/** A compressed landmark coordinate (the parity of the rounded degree, the 15-bit fraction / 32767). */
export function compressed(deg) {
	const round = Math.sign(deg) * Math.round(Math.abs(deg));
	const frac = Math.max(-16383, Math.min(16383, Math.trunc((deg - round) * 32767)));
	const v = (frac & 0x7fff) | ((round & 1) << 15);
	return [v & 0xff, v >> 8];
}

/** A landmark: an area (layer 1, warning) of the points, or a text (subtype 0) at the first one; 30 min to live. */
export function fanetLandmark(mfg, dev, points, text) {
	const [first, ...rest] = points;
	const body = text
		? [0x20, 0x00, ...position(...first), ...ascii(text)]
		: [0x23, 0x01, ...position(...first), ...rest.flatMap(([lat, lon]) => [...compressed(lat), ...compressed(lon)])];
	return Uint8Array.from([...header(5, mfg, dev), ...body]);
}

/** FANET's LoRa settings in a band: SF7, 4/5, preamble 12 (OnAir's test), sync word 0xF1, CRC on. */
export const fanetLora = (bwHz = 250000) => loraParams({ sf: 7, bwHz, cr: 5, preamble: 12, syncWord: 0xf1 });

/** Frames from `startSec` on, one every `gapSec` (or at their own `at`), at an SNR, carrier offset and clock error. */
export function fanetFrames(payloads, { bwHz = 250000, startSec = 0.05, gapSec = 0.06, snrDb = 0, freqHz = 0, sroPpm = 0 } = {}) {
	let t = startSec;
	return payloads.map((item) => {
		const p = item instanceof Uint8Array ? { payload: item } : item;
		const f = txFrame(fanetLora(bwHz), p.payload, { startSec: p.at ?? t, freqHz: p.freqHz ?? freqHz, snrDb: p.snrDb ?? snrDb, sroPpm });
		t = Math.max(t, f.endSec) + gapSec;
		return f;
	});
}

/** Streams the frames over noise into a FANET decoder; its records, status lines and the decode time. */
export function runFanet(frames, { band = FANET_250, chunk = 16384, station, seed = 1, tailSec = 0.2, durationSec } = {}) {
	const records = [];
	const status = [];
	const decoder = new FanetDecoder({ record: (r) => records.push(r), status: (message, locked) => status.push([message, locked]) }, band);
	if (station) decoder.setStation(station.lat, station.lon);
	let ms = 0;
	const seconds = streamSignal(
		frames,
		(iq) => {
			const t0 = performance.now();
			decoder.process(iq);
			ms += performance.now() - t0;
		},
		{ rate: band.rate, bwHz: band.bwHz, chunk, seed, tailSec, durationSec },
	);
	return { records, status, decoder, ms, seconds };
}

export const field = (record, label) => record.fields.find(([name]) => name === label)?.[1];
