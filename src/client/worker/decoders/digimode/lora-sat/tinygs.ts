// SPDX-FileCopyrightText: Copyright (C) 2020-2021 @G4lile0, @gmag12 and @dev_4m1g0 (TinyGS)
// SPDX-License-Identifier: GPL-3.0-or-later
// Adapted for BrowSDR from the TinyGS firmware, https://github.com/G4lile0/tinyGS (GPL-3.0-or-later, revision 0890fb1):
// the modem configuration of tinyGS/src/ConfigManager/ConfigManager.cpp (parseModemStartup) and
// tinyGS/src/Mqtt/MQTT_Client.cpp (isValidFrequency, the begine command), the defaults of tinyGS/src/Status.h
// (ModemInfo) and how tinyGS/src/Radio/Radio.cpp (begin) hands them to RadioLib, with the value conversions of the
// ArduinoJson 6.17.2 it bundles (Benoit Blanchon, MIT). Changes: rewritten in TypeScript; the radio is not known, so a
// frequency, bandwidth or spreading factor is accepted when one of TinyGS's LoRa radios (SX1276/8, SX1262/8) would
// take it, and the 2.4 GHz radio (SX1280) is refused.

import type { LoraSatConfig, TinygsFsk, TinygsModem } from './types';

/** Longest configuration read: TinyGS reads the server's into a 768-byte JSON document (the dashboard field holds 255). */
export const TINYGS_MAX_LENGTH = 1024;
/** The LoRa bandwidths RadioLib's SX127x and SX126x drivers accept, kHz. */
export const TINYGS_LORA_BANDWIDTHS_KHZ = [7.8, 10.4, 15.6, 20.8, 31.25, 41.7, 62.5, 125, 250, 500];

/** ArduinoJson's number of a string: decimal only, the whole string (else null, which reads as 0). */
function parseNumber(text: string): number | null {
	const negative = text.startsWith('-');
	const s = /^[+-]/.test(text) ? text.slice(1) : text;
	if (/^[nN]/.test(s)) return NaN;
	if (/^[iI]/.test(s)) return negative ? -Infinity : Infinity;
	const m = /^(\d*)(?:\.(\d*))?(?:[eE]([+-]?)(\d*))?$/.exec(s);
	if (!m || !/^[\d.]/.test(s)) return null;
	const v = Number(`${m[1] || '0'}.${m[2] || '0'}e${m[3] ?? ''}${m[4] || '0'}`);
	return negative ? -v : v;
}

/** What `as<float>()` and the integral conversions start from: a number, a boolean as 0 / 1, a parsed string, else 0. */
function numeric(value: unknown): number {
	if (typeof value === 'number') return value;
	if (typeof value === 'boolean') return value ? 1 : 0;
	if (typeof value === 'string') return parseNumber(value) ?? 0;
	return 0;
}

/** `as<uintN_t>()`: an integer outside the type, or a negative one, is 0; a fraction is cut off when it fits. */
function unsigned(value: unknown, bits: number): number {
	const v = numeric(value);
	const max = 2 ** bits - 1;
	if (!Number.isFinite(v) || v < 0 || v > max) return 0;
	return Math.trunc(v);
}

/** `as<bool>()`: numbers are true when not 0, null is false, strings, objects and arrays are true. */
function boolean(value: unknown): boolean {
	if (value === undefined || value === null) return false;
	if (typeof value === 'number') return value !== 0;
	if (typeof value === 'boolean') return value;
	return true;
}

/** `doc["len"] ? doc["len"].as<int>() : 0` stored in a uint8_t: C++ keeps the low byte. */
function lengthByte(value: unknown): number {
	if (!boolean(value)) return 0;
	const v = numeric(value);
	const int = Number.isFinite(v) && v >= -(2 ** 31) && v < 2 ** 31 ? Math.trunc(v) : 0;
	return ((int % 256) + 256) % 256;
}

/** MQTT_Client.cpp isValidFrequency for the LoRa radios of TinyGS boards (1 SX1278, 2 SX1276, 5 SX1268, 6 SX1262). */
const validFrequency = (mhz: number): boolean => mhz >= 137 && mhz <= 1020;

function text(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

/** The LoRa keys of ModemInfo (ConfigManager::parseModemStartup), checked as RadioLib's begin() would check them. */
function loraConfig(doc: Record<string, unknown>, freqMHz: number): TinygsModem {
	const bwKhz = numeric(doc.bw);
	const sf = unsigned(doc.sf, 8);
	const cr = unsigned(doc.cr, 8);
	const fldro = unsigned(doc.fldro, 8);
	const known = TINYGS_LORA_BANDWIDTHS_KHZ.find((b) => Math.abs(bwKhz - b) <= 0.001);
	if (known === undefined)
		return {
			kind: 'error',
			message: `Bandwidth ${bwKhz} kHz: RadioLib takes ${TINYGS_LORA_BANDWIDTHS_KHZ.join(', ')} kHz ("bw" is in kHz).`,
		};
	if (sf < 5 || sf > 12) return { kind: 'error', message: `Spreading factor ${sf}: RadioLib takes 5 to 12 ("sf").` };
	if (cr < 5 || cr > 8) return { kind: 'error', message: `Coding rate ${cr}: RadioLib takes 5 to 8 for 4/5 to 4/8 ("cr").` };
	const config: LoraSatConfig = {
		sat: text(doc.sat),
		norad: unsigned(doc.NORAD, 32),
		freqMHz,
		bwHz: known === 41.7 ? 125000 / 3 : known * 1000,
		sf,
		cr,
		sync: unsigned(doc.sw, 8),
		preamble: unsigned(doc.pl, 16),
		crc: boolean(doc.crc),
		ldro: fldro === 2 ? 'auto' : fldro === 0 ? 'off' : 'on',
		inverted: boolean(doc.iIQ),
		implicitLen: lengthByte(doc.len),
	};
	return { kind: 'lora', config };
}

/** The FSK keys of ModemInfo, for the message that says what the configuration is. */
function fskConfig(doc: Record<string, unknown>, mode: string, freqMHz: number): TinygsModem {
	const fsk: TinygsFsk = {
		mode,
		sat: text(doc.sat),
		norad: unsigned(doc.NORAD, 32),
		freqMHz,
		bitrate: numeric(doc.br),
		deviation: numeric(doc.fd),
		bw: numeric(doc.bw),
		syncWord: Array.isArray(doc.fsw) ? doc.fsw.slice(0, 8).map((v) => unsigned(v, 8)) : [],
		framing: unsigned(doc.fr, 8),
		ook: unsigned(doc.ook, 8),
		len: unsigned(doc.len, 8),
		encoding: unsigned(doc.enc, 8),
	};
	return { kind: 'fsk', fsk };
}

/**
 * A TinyGS modem configuration (the JSON of the station's "modem_startup" setting, or one the server sent) read as the
 * firmware reads it: invalid JSON or no "mode" is refused, so is a frequency no TinyGS LoRa radio tunes; "mode" "LoRa"
 * is LoRa, anything else FSK. Missing keys read as 0 or false (ArduinoJson), "len" as 0, "iIQ" as false.
 */
export function parseTinygsModem(json: string): TinygsModem {
	if (json.length > TINYGS_MAX_LENGTH)
		return { kind: 'error', message: `The configuration is longer than ${TINYGS_MAX_LENGTH} characters.` };
	let doc: unknown;
	try {
		doc = JSON.parse(json);
	} catch {
		return { kind: 'error', message: 'Your modem config is invalid: not JSON (as TinyGS says).' };
	}
	if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !('mode' in doc))
		return { kind: 'error', message: 'Your modem config is invalid: it has no "mode" (as TinyGS says).' };
	const d = doc as Record<string, unknown>;
	const freqMHz = numeric(d.freq);
	const mode = text(d.mode).slice(0, 7);
	if (freqMHz >= 2400 && freqMHz <= 2500)
		return { kind: 'error', message: `${freqMHz} MHz is for TinyGS's 2.4 GHz radio (SX1280), which BrowSDR does not decode.` };
	if (!validFrequency(freqMHz)) return { kind: 'error', message: `Invalid frequency ${freqMHz} MHz (as TinyGS says): "freq" is in MHz.` };
	return mode === 'LoRa' ? loraConfig(d, freqMHz) : fskConfig(d, mode, freqMHz);
}

const hex2 = (v: number): string => `0x${v.toString(16).padStart(2, '0').toUpperCase()}`;

/** One line for the panel: what the decoder runs. */
export function loraConfigSummary(c: LoraSatConfig): string {
	const header = c.implicitLen ? `implicit header, ${c.implicitLen} bytes` : 'explicit header';
	const preamble = c.preamble < 6 ? `preamble ${c.preamble} (too short to be found)` : `preamble ${c.preamble}`;
	return [
		`${c.sat || 'satellite'}${c.norad ? ` (NORAD ${c.norad})` : ''}: ${c.freqMHz} MHz`,
		`SF${c.sf}`,
		`${+(c.bwHz / 1000).toFixed(2)} kHz`,
		`CR 4/${c.cr}`,
		`sync ${hex2(c.sync)}`,
		preamble,
		`CRC ${c.crc ? 'on' : 'off'}`,
		`LDRO ${c.ldro}`,
		c.inverted ? 'inverted IQ' : 'normal IQ',
		header,
	].join(' · ');
}

/** What an FSK configuration is, and why it is not decoded. */
export function fskSummary(f: TinygsFsk): string {
	const sync = f.syncWord.length ? ` · sync word ${f.syncWord.map(hex2).join(' ')}` : '';
	const kind = f.ook === 255 ? 'OOK' : `FSK (mode "${f.mode}")`;
	return `${f.sat || 'This satellite'} uses ${kind} at ${f.freqMHz} MHz: ${f.bitrate} kbit/s, deviation ${f.deviation} kHz${sync}${f.framing === 1 ? ', AX.25 framing' : ''}. The LoRa satellite decoder does not decode FSK; ${f.framing === 1 ? 'try CubeSat AX.25 telemetry if it sends 9600 bd G3RUH or 1200 bd AFSK.' : "TinyGS's raw FSK packets are not decoded in BrowSDR yet."}`;
}
