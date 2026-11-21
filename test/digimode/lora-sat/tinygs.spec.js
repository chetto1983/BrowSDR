// The TinyGS modem configuration as the firmware reads it (tinyGS/src/ConfigManager/ConfigManager.cpp parseModemStartup,
// tinyGS/src/Mqtt/MQTT_Client.cpp isValidFrequency, ArduinoJson 6.17.2 conversions), the VFO parameter checks, and the
// SatNOGS DB presets of TinyGS's satellites.

import { describe, expect, it } from 'vitest';
import { DIGIMODES, digimodeInfo } from '@/worker/decoders/digimode/catalog';
import { LORA_SAT_BANDS, loraSatBandFor } from '@/worker/decoders/digimode/lora-sat/catalog';
import { SATNOGS_LORA, SATNOGS_LORA_SOURCE } from '@/worker/decoders/digimode/lora-sat/satnogs';
import { fskSummary, loraConfigSummary, parseTinygsModem } from '@/worker/decoders/digimode/lora-sat/tinygs';
import { validLoraSatParams } from '@/worker/decoders/digimode/lora-sat/validation';

/** The example of the TinyGS wiki (Radio-Tuning-Guide.md). */
const WIKI_LORA =
	'{"mode":"LoRa","freq":436.703,"bw":250.0,"sf":10,"cr":5,"sw":18,"pwr":5,"cl":120,"pl":8,"gain":0,"crc":true,"fldro":1,"sat":"Norbi","NORAD":46494}';
const WIKI_FSK =
	'{"mode":"FSK","freq":437.77,"br":9.6,"fd":25,"bw":200,"pwr":10,"cl":100,"pl":0,"ook":0,"fsw":[4,53,46,53,46],"sat":"reaktor-hello-world","NORAD":43743}';

describe('TinyGS modem configuration', () => {
	it("reads the wiki's LoRa example as the firmware does", () => {
		expect(parseTinygsModem(WIKI_LORA)).toEqual({
			kind: 'lora',
			config: {
				sat: 'Norbi',
				norad: 46494,
				freqMHz: 436.703,
				bwHz: 250000,
				sf: 10,
				cr: 5,
				sync: 18,
				preamble: 8,
				crc: true,
				ldro: 'on',
				inverted: false,
				implicitLen: 0,
			},
		});
		const { config } = parseTinygsModem(WIKI_LORA);
		expect(loraConfigSummary(config)).toBe(
			'Norbi (NORAD 46494): 436.703 MHz · SF10 · 250 kHz · CR 4/5 · sync 0x12 · preamble 8 · CRC on · LDRO on · normal IQ · explicit header',
		);
		expect(loraSatBandFor(config.bwHz).id).toBe('lora-sat-250');
	});
	it('reads missing keys as 0 or false and converts values as ArduinoJson 6 does', () => {
		const lora = (extra) => parseTinygsModem(JSON.stringify({ mode: 'LoRa', freq: 436.5, bw: 125, sf: 9, cr: 7, ...extra }));
		// no sw, pl, crc, fldro, iIQ, len: 0, 0, false, LDRO off, normal IQ, explicit header
		expect(lora({}).config).toMatchObject({
			sync: 0,
			preamble: 0,
			crc: false,
			ldro: 'off',
			inverted: false,
			implicitLen: 0,
			sat: '',
			norad: 0,
		});
		expect(loraConfigSummary(lora({}).config)).toContain('preamble 0 (too short to be found)');
		// numbers in strings are parsed (decimal only), other strings read as 0; out of range integers are 0
		expect(lora({ sw: '52', pl: '16' }).config).toMatchObject({ sync: 52, preamble: 16 });
		expect(lora({ sw: '0x34' }).config.sync).toBe(0);
		expect(lora({ sw: 300, pl: -1 }).config).toMatchObject({ sync: 0, preamble: 0 });
		expect(lora({ sw: 18.9 }).config.sync).toBe(18);
		// booleans: any string is true, numbers when not 0
		expect(lora({ crc: 'false', iIQ: 1 }).config).toMatchObject({ crc: true, inverted: true });
		expect(lora({ crc: 0, iIQ: null }).config).toMatchObject({ crc: false, inverted: false });
		// fldro: 2 automatic, 0 off, anything else forces it on
		expect([0, 1, 2, 3].map((fldro) => lora({ fldro }).config.ldro)).toEqual(['off', 'on', 'auto', 'on']);
		// len: an int kept in a uint8_t
		expect([0, 20, 255, 256, 300].map((len) => lora({ len }).config.implicitLen)).toEqual([0, 20, 255, 0, 44]);
		// strings for frequency and bandwidth
		expect(lora({ freq: '868.1', bw: '41.7' }).config).toMatchObject({ freqMHz: 868.1, bwHz: 125000 / 3 });
	});
	it('refuses what the firmware or RadioLib refuses', () => {
		const error = (json) => {
			const m = parseTinygsModem(json);
			expect(m.kind, json).toBe('error');
			return m.message;
		};
		expect(error('{"mode":"LoRa",')).toMatch(/invalid: not JSON/);
		expect(error('{"freq":436.7,"sf":10}')).toMatch(/no "mode"/);
		expect(error('[1,2]')).toMatch(/no "mode"/);
		expect(error('{"mode":"LoRa","sf":10,"bw":125,"cr":5}')).toMatch(/Invalid frequency 0 MHz/);
		expect(error('{"mode":"LoRa","freq":100,"sf":10,"bw":125,"cr":5}')).toMatch(/Invalid frequency 100 MHz/);
		expect(error('{"mode":"LoRa","freq":2425,"sf":10,"bw":812.5,"cr":5}')).toMatch(/2\.4 GHz radio \(SX1280\)/);
		expect(error('{"mode":"LoRa","freq":436.7,"sf":10,"bw":200,"cr":5}')).toMatch(/Bandwidth 200 kHz/);
		expect(error('{"mode":"LoRa","freq":436.7,"sf":13,"bw":125,"cr":5}')).toMatch(/Spreading factor 13/);
		expect(error('{"mode":"LoRa","freq":436.7,"sf":10,"bw":125,"cr":4}')).toMatch(/Coding rate 4/);
		expect(error(`{"mode":"LoRa","sat":"${'x'.repeat(1100)}"}`)).toMatch(/longer than 1024/);
	});
	it('says clearly when the configuration is FSK', () => {
		const m = parseTinygsModem(WIKI_FSK);
		expect(m).toMatchObject({
			kind: 'fsk',
			fsk: { mode: 'FSK', sat: 'reaktor-hello-world', bitrate: 9.6, deviation: 25, syncWord: [4, 53, 46, 53, 46] },
		});
		expect(fskSummary(m.fsk)).toBe(
			'reaktor-hello-world uses FSK (mode "FSK") at 437.77 MHz: 9.6 kbit/s, deviation 25 kHz · sync word 0x04 0x35 0x2E 0x35 0x2E. The LoRa satellite decoder does not decode FSK; TinyGS\'s raw FSK packets are not decoded in BrowSDR yet.',
		);
		// any mode other than "LoRa" is FSK to the firmware
		expect(parseTinygsModem('{"mode":"GMSK","freq":437.5,"br":4.8,"fr":1}')).toMatchObject({
			kind: 'fsk',
			fsk: { mode: 'GMSK', framing: 1 },
		});
		expect(parseTinygsModem('{"mode":"lora","freq":437.5}').kind).toBe('fsk');
	});
	it('checks the VFO parameters it is sent', () => {
		const { config } = parseTinygsModem(WIKI_LORA);
		expect(validLoraSatParams({ config, hint: { offsetHz: 8300, rateHzS: -95 }, satellite: { name: 'Norby', norad: 46494 } })).toBe(true);
		expect(validLoraSatParams({})).toBe(true);
		for (const bad of [
			{ config: { ...config, sf: 13 } },
			{ config: { ...config, bwHz: 200000 } },
			{ config: { ...config, ldro: 'yes' } },
			{ config: { ...config, sat: 'x'.repeat(65) } },
			{ hint: { offsetHz: NaN, rateHzS: 0 } },
			{ hint: { offsetHz: 2e6, rateHzS: 0 } },
			{ satellite: { name: 'x', norad: -1 } },
			null,
			'config',
		])
			expect(validLoraSatParams(bad), JSON.stringify(bad)).toBe(false);
	});
});

describe('LoRa satellite presets from SatNOGS DB', () => {
	it('lists the LoRa transmitters of TinyGS satellites, with their source and nothing invented', () => {
		expect(SATNOGS_LORA_SOURCE).toBe('SatNOGS DB (db.satnogs.org), CC BY-SA 4.0, read 2026-11-21');
		expect(SATNOGS_LORA).toHaveLength(25);
		expect(new Set(SATNOGS_LORA.map((t) => t.norad)).size).toBe(22);
		for (const t of SATNOGS_LORA) {
			expect([0, 62500, 125000, 250000, 500000]).toContain(t.bwHz);
			expect(t.freqMHz > 137 && t.freqMHz < 930).toBe(true);
			expect(t.names.length).toBeGreaterThan(0);
		}
		expect(SATNOGS_LORA.find((t) => t.norad === 57179)).toMatchObject({
			names: ['Norby-2'],
			freqMHz: 436.5,
			bwHz: 250000,
			description: 'Mode U - LoRa (SF:10 CR:5 BW:250)',
		});
	});
	it('gives every entry presets that say where they come from and that they are unverified', () => {
		const entries = DIGIMODES.filter((mode) => mode.id.startsWith('lora-sat'));
		expect(entries.map((mode) => mode.id)).toEqual(LORA_SAT_BANDS.map((band) => band.id));
		for (const mode of entries) {
			expect(mode.family).toBe('Satellite');
			const freqs = mode.presets.map((p) => p.freqMHz);
			expect(new Set(freqs).size, mode.id).toBe(freqs.length);
			for (const p of mode.presets) expect(p.label, mode.id).toMatch(/unverified|uncertain|plausible/);
		}
		const labels = (id) => digimodeInfo(id).presets.map((p) => `${p.freqMHz} ${p.label}`);
		expect(labels('lora-sat-250')).toContain('436.5 Norby-2 436.500 (SatNOGS; unverified)');
		expect(labels('lora-sat-500')).toContain(
			'400.45 Tianqi-21, Tianqi-23, Tianqi-24 400.450 (SatNOGS; unverified); Tianqi constellation (Guodian Gaoke) downlink (OnAir, uncertain)',
		);
		expect(labels('lora-sat-41')).toEqual(['137.055 137.055 MHz LoRa telemetry, SF8 / 41.7 kHz (issue #229) (OnAir, plausible)']);
		// inactive transmitters are not offered
		expect(labels('lora-sat').some((l) => l.includes('ConnectaIoT-1'))).toBe(false);
	});
});
