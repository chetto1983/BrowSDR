// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/vdl2/vdl2_rx.cpp (Vdl2Receiver's message bookkeeping, one
// channel), https://github.com/adswill/OnAir; see third_party/onair. Changes: each AVLC frame of a decoded burst is one
// record (addresses, frame type, the protocols it carries; ATN and XID frames with a hex dump); the aircraft and
// ground station tables, the multi-block ACARS reassembly, the feeds and the automations of OnAir are left out.

import type { DigimodeDecoder, DigimodeSink } from '@/worker/decoders/digimode/types';
import { hexNum } from './proto';
import { VDL2_RATE, Vdl2Receiver } from './receiver';
import type { Vdl2Burst, Vdl2Line, Vdl2Message } from './types';

export { VDL2_RATE };

const MAX_FIELDS = 64;
/** Octets in the hex dump of a frame (three characters each, within a field's 4000). */
const MAX_HEX = 1300;

const hex = (bytes: Uint8Array) =>
	[...bytes.subarray(0, MAX_HEX)].map((byte) => byte.toString(16).padStart(2, '0')).join(' ') + (bytes.length > MAX_HEX ? ' …' : '');

/** An address as the log shows it: aircraft by their 24 bit address (and registration), ground stations marked. */
function station(addr: number, type: number, reg: string | undefined): string {
	const hex = hexNum(addr, 6);
	if (type === 1) return reg ? `${hex} (${reg})` : hex;
	if (type === 4 || type === 5) return `GS ${hex}`;
	return type === 7 ? 'all' : `${hex} (type ${type})`;
}

/** Labels made unique (the log keys fields by label). */
function uniqueFields(lines: Vdl2Line[]): Vdl2Line[] {
	const seen = new Map<string, number>();
	return lines.slice(0, MAX_FIELDS).map(([label, value]) => {
		const count = (seen.get(label) ?? 0) + 1;
		seen.set(label, count);
		return [count > 1 ? `${label} (${count})` : label, value.slice(0, 4000)];
	});
}

export class Vdl2Decoder implements DigimodeDecoder {
	private readonly receiver = new Vdl2Receiver((burst) => this.report(burst));
	private wasBusy = false;
	private frames = 0;
	private last = '';

	constructor(private readonly sink: DigimodeSink) {}

	process(iq: Float32Array): void {
		this.receiver.process(iq);
		const busy = this.receiver.busy;
		if (busy === this.wasBusy) return;
		this.wasBusy = busy;
		this.sink.status(busy ? 'Receiving a burst' : this.last || 'Searching for bursts', busy);
	}

	reset(): void {
		this.receiver.reset();
		this.wasBusy = false;
	}

	private report(burst: Vdl2Burst): void {
		for (const m of burst.messages) this.record(m, burst);
		this.frames += burst.messages.length;
		const cfo = Math.round(burst.cfoHz);
		this.last = `${this.frames} frame(s), last at SNR ${burst.snrDb.toFixed(1)} dB, carrier ${cfo > 0 ? '+' : ''}${cfo} Hz`;
		this.sink.status(this.last, this.receiver.busy);
	}

	private record(m: Vdl2Message, burst: Vdl2Burst): void {
		const reg = m.acars?.reg;
		const from = station(m.src, m.srcType, m.srcType === 1 ? reg : undefined);
		const to = station(m.dst, m.dstType, m.dstType === 1 ? reg : undefined);
		const kind = m.summary.startsWith(m.frameName) ? '' : `${m.frameName} · `;
		const fields: Vdl2Line[] = m.detail.slice(0, MAX_FIELDS - 4); // room for the lines below
		// ATN (X.25, CLNP, COTP) and XID frames, and ACARS blocks that could not be read: the information field as bytes
		if (m.info.length && m.acarsAt < 0) fields.push(['Information', `ATN/XID frame, ${m.info.length} bytes`], ['Hex', hex(m.info)]);
		else if (m.info.length && !m.acars) fields.push(['Hex', hex(m.info)]);
		const cfo = Math.round(burst.cfoHz);
		fields.push([
			'Signal',
			`level ${burst.levelDb.toFixed(1)} dB, SNR ${burst.snrDb.toFixed(1)} dB, carrier ${cfo > 0 ? '+' : ''}${cfo} Hz`,
		]);
		const fec = `${burst.rsFixed} octet(s) corrected by Reed-Solomon${burst.headerFixed ? ', header corrected' : ''}`;
		fields.push(['FEC', fec + (burst.bad ? `, ${burst.bad} frame(s) of the burst failed their check` : '')]);
		this.sink.record({
			text: `${from} → ${to} · ${kind}${m.summary || m.frameName}`.slice(0, 2000),
			fields: uniqueFields(fields),
			damaged: m.acars ? !m.acars.crcOk : false,
		});
	}
}
