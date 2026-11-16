// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/mesh/mesh_rx.cpp (MeshReceiver::onFrame: the packet row of a
// frame, its radio fields, the CRC error and "not a packet" notes; the receiver's state from preambles and good frames)
// and rust/onair_mesh/src/aprs.rs (printable), https://github.com/adswill/OnAir; see third_party/onair. Changes: one
// protocol per decoder on the VFO's channel; one record per frame with a status line in place of the packet, node and
// message tables; no feeds, automations or MeshCore device.

import type { DigimodeDecoder, DigimodeSink } from '@/worker/decoders/digimode/types';
import { LoraBank } from './bank';
import { hexEncode } from './crypto';
import type { LoraDecoded, LoraMode, LoraRadio } from './types';

/** Printable ASCII kept (not the backslash), other bytes as \xNN. */
export function printable(p: ArrayLike<number>): string {
	let s = '';
	for (let i = 0; i < p.length; i++) {
		const c = p[i];
		s += c >= 0x20 && c < 0x7f && c !== 0x5c ? String.fromCharCode(c) : `\\x${c.toString(16).padStart(2, '0')}`;
	}
	return s;
}

const khz = (hz: number): string => `${+(hz / 1000).toFixed(3)} kHz`;
const signed = (v: number, digits: number): string => (v >= 0 ? '+' : '') + v.toFixed(digits);

/** The radio fields every record ends with. */
export function radioFields(r: LoraRadio, payload: Uint8Array): Array<[string, string]> {
	const crc = !r.hasCrc
		? 'none'
		: r.crcOk
			? `ok${r.softFixed ? ' (soft decision)' : ''}${r.jumpsFixed ? ` (${r.jumpsFixed} sample jump(s) undone)` : ''}`
			: 'failed';
	const f: Array<[string, string]> = [
		['Spreading factor', `SF${r.sf}`],
		['Bandwidth', khz(r.bwHz)],
		['Coding rate', `4/${r.cr}`],
		['SNR', `${r.snrDb.toFixed(1)} dB`],
		['Level', `${r.levelDb.toFixed(1)} dBFS`],
		['Carrier offset', `${signed(r.cfoHz / 1000, 2)} kHz`],
		['Sync word', `0x${r.syncWord.toString(16).padStart(2, '0').toUpperCase()}`],
		['CRC', crc],
	];
	if (r.corrected) f.push(['Corrected codewords', String(r.corrected)]);
	f.push(['Length', `${payload.length} bytes`], ['Payload', hexEncode(payload, true, ' ')]);
	return f;
}

/** A LoRa protocol on the VFO channel: the bank of demodulators, the packet layer, one record per frame. */
export class LoraDecoder implements DigimodeDecoder {
	private bank: LoraBank;
	private readonly got: LoraDecoded[] = [];
	private packets = 0;
	private crcBad = 0;
	private last = '';
	private wasLocked = false;
	private started = false;

	constructor(
		private readonly sink: DigimodeSink,
		readonly mode: LoraMode,
	) {
		this.bank = this.newBank();
	}

	private newBank(): LoraBank {
		const m = this.mode;
		return new LoraBank({ bwHz: m.bwHz, rate: m.rate, sfs: m.sfs, syncs: m.syncs, preamble: m.preamble });
	}

	process(iq: Float32Array): void {
		this.got.length = 0;
		this.bank.feed(iq, this.got);
		for (const d of this.got) this.report(d);
		const locked = this.bank.receiving;
		if (locked !== this.wasLocked || this.got.length || !this.started) {
			this.started = true;
			this.wasLocked = locked;
			this.sink.status(this.statusText(locked), locked);
		}
	}

	reset(): void {
		this.bank = this.newBank();
		this.wasLocked = false;
	}

	private statusText(locked: boolean): string {
		const m = this.mode;
		const sfs = m.sfs.length > 1 ? `SF${m.sfs[0]}–SF${m.sfs[m.sfs.length - 1]}` : `SF${m.sfs[0]}`;
		if (locked)
			return `Receiving a ${m.name} frame (${this.bank
				.receivingSfs()
				.map((sf) => `SF${sf}`)
				.join(', ')})`;
		if (!this.packets && !this.crcBad) return `Listening for ${m.name} (${sfs}, ${khz(m.bwHz)})`;
		return `${this.packets} packet(s)${this.crcBad ? `, ${this.crcBad} CRC error(s)` : ''}${this.last ? `, last ${this.last}` : ''}`;
	}

	private report(d: LoraDecoded): void {
		const f = d.frame;
		const radio: LoraRadio = {
			sf: d.sf,
			bwHz: d.bwHz,
			cr: f.hdr.cr,
			snrDb: f.snrDb,
			levelDb: f.levelDb,
			cfoHz: f.cfoHz,
			crcOk: f.crcOk,
			hasCrc: f.hdr.crc,
			corrected: f.corrected,
			softFixed: f.softFixed,
			jumpsFixed: f.jumpsFixed,
			syncWord: d.sync,
		};
		const crcBad = f.hdr.crc && !f.crcOk;
		const r = this.mode.decode(f.payload, radio);
		if (crcBad) this.crcBad++;
		else if (r.ok) {
			this.packets++;
			this.last = r.last;
		}
		const text = (crcBad ? `CRC error · ${r.text}` : r.text).slice(0, 2000);
		const fields = [...r.fields, ...radioFields(radio, f.payload)].slice(0, 64).map(([k, v]): [string, string] => [k, v.slice(0, 4000)]);
		this.sink.record({ text, fields, damaged: crcBad || !r.ok, alert: r.alert });
	}
}
