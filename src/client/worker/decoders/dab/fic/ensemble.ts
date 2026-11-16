// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/dab/dab_rx.cpp (parseFib, parseFig0 extensions 0, 1 and 2,
// parseFig1 extensions 0, 1 and 5: the ensemble tables) and the protection text of app/smart5/smart5_broadcast_ui.cpp,
// https://github.com/adswill/OnAir; see third_party/onair. Changes: FIG 0/3, 0/10, 0/13, 0/14, 0/17-0/19, FIG 1/4,
// FIG 2 and the FIC analysis are not ported; the tables are turned into the DabEnsembleInfo BrowSDR shows.

import type { DabComponentInfo, DabEnsembleInfo, DabServiceInfo } from '@/worker/decoders/dabplus/types';
import { eepGeometry, uepGeometry } from '@/worker/decoders/dab/fec/puncture';
import { labelText } from './charset';
import { fig0CifCount, fig0Eid, fig0Services, fig0Subchannels, fig1, shortLabelBytes, walkFib } from './figs';
import type { FigSubchannel, Service, Subchannel } from './types';

/** "EEP 3-A", "UEP 3": how OnAir names a sub-channel's protection. */
export function protectionText(s: Subchannel): string {
	return s.eep ? `EEP ${s.level + 1}-${s.option ? 'B' : 'A'}` : `UEP ${s.level + 1}`;
}

/** What the FIC has told about the ensemble: identifier, label, sub-channels and services. */
export class EnsembleTables {
	eid = 0;
	label = '';
	readonly subs = new Map<number, Subchannel>();
	readonly services = new Map<number, Service>();
	/** CIF count of the first CIF of the frame being decoded, -1 when its FIC did not say. */
	frameCif = -1;
	/** The FIB being parsed (its FIG 0/0 tells the CIF count of its CIF). */
	private slot = 0;
	private fibData: Uint8Array = new Uint8Array(0);
	private readonly visit = (type: number, off: number, len: number) => this.fig(type, off, len);

	clear(): void {
		this.eid = 0;
		this.label = '';
		this.subs.clear();
		this.services.clear();
		this.frameCif = -1;
	}

	/** One FIB with a good CRC: fibs[from .. from + 32), the slot-th of its frame (0..11). */
	applyFib(fibs: Uint8Array, from: number, slot: number): void {
		this.fibData = fibs;
		this.slot = slot;
		walkFib(fibs, from, this.visit);
	}

	private fig(type: number, off: number, len: number): void {
		if (type === 0) this.fig0(off, len);
		else if (type === 1) this.fig1(off, len);
	}

	private fig0(off: number, len: number): void {
		const d = this.fibData;
		const ext = d[off] & 31;
		// C/N = 1: the configuration after an announced reconfiguration; only the current one is followed
		if (d[off] & 0x80 && (ext === 1 || ext === 2)) return;
		if (ext === 0) this.ensembleInfo(off, len);
		else if (ext === 1) for (const s of fig0Subchannels(d, off, len)) this.subs.set(s.id, this.subchannel(s));
		else if (ext === 2)
			for (const e of fig0Services(d, off, len)) {
				const sv = this.service(e.sid);
				sv.comps = e.comps;
			}
	}

	private ensembleInfo(off: number, len: number): void {
		const d = this.fibData;
		// the CIF count of the CIF of this FIB's group: the frame's first CIF is that minus the group
		const cif = fig0CifCount(d, off, len);
		if (cif !== null) this.frameCif = (((cif - Math.floor(this.slot / 3)) % 5000) + 5000) % 5000;
		const eid = fig0Eid(d, off, len);
		if (eid === null) return;
		// a different ensemble on the same tuning: the sub-channel ids are only valid per ensemble
		if (this.eid !== 0 && this.eid !== eid) {
			const frameCif = this.frameCif;
			this.clear();
			this.frameCif = frameCif;
		}
		this.eid = eid;
	}

	private subchannel(e: FigSubchannel): Subchannel {
		const s: Subchannel = { id: e.id, start: e.start, size: 0, eep: e.eep, option: 0, level: 0, uepIndex: 0, bitrate: 0 };
		if (e.eep) {
			s.option = e.option;
			s.level = e.level;
			s.size = e.size;
			s.bitrate = eepGeometry(s.size, s.option, s.level)?.bitrate ?? 0;
		} else {
			s.uepIndex = e.uepIndex;
			// table switch 1 is not defined: listed without a size, it cannot play
			const g = e.uepTable ? null : uepGeometry(e.uepIndex);
			if (g) {
				s.size = g.size;
				s.bitrate = g.bitrate;
				s.level = g.level - 1;
			}
		}
		return s;
	}

	private service(sid: number): Service {
		let sv = this.services.get(sid);
		if (!sv) {
			sv = { sid, label: '', shortLabel: '', comps: [] };
			this.services.set(sid, sv);
		}
		return sv;
	}

	private fig1(off: number, len: number): void {
		const d = this.fibData;
		const l = fig1(d, off, len);
		if (!l || (l.ext !== 0 && l.ext !== 1 && l.ext !== 5)) return;
		const text = labelText(l.charset, d.subarray(off + l.off, off + l.off + 16));
		const mask = shortLabelBytes(d, off, len, l.off);
		const short = mask ? labelText(l.charset, mask) : '';
		if (l.ext === 0) this.label = text;
		else {
			const sv = this.service(l.sid);
			sv.label = text;
			sv.shortLabel = short;
		}
	}

	/** The ensemble as BrowSDR lists it (services by SId); null until the identifier and a service are known. */
	info(): DabEnsembleInfo | null {
		if (this.eid === 0 || this.services.size === 0) return null;
		const services: DabServiceInfo[] = [...this.services.values()]
			.sort((a, b) => a.sid - b.sid)
			.map((sv) => {
				const info: DabServiceInfo = { sid: sv.sid, label: sv.label, components: this.components(sv) };
				if (sv.shortLabel && sv.shortLabel !== sv.label) info.shortLabel = sv.shortLabel;
				return info;
			});
		return { eid: this.eid, label: this.label, services };
	}

	private components(sv: Service): DabComponentInfo[] {
		const out: DabComponentInfo[] = [];
		for (const c of sv.comps) {
			if ((c.tmid !== 0 && c.tmid !== 1) || c.subId < 0) continue;
			const sub = this.subs.get(c.subId);
			out.push({
				subchannel: c.subId,
				dabPlus: c.tmid === 0 && c.ascty === 63,
				bitrate: sub?.bitrate ?? 0,
				protection: sub ? protectionText(sub) : '',
				primary: c.primary,
			});
		}
		return out;
	}

	/** The selected sub-channel carries DAB+ audio (ASCTy 63); true when no component names it yet, as OnAir assumes. */
	isDabPlus(subId: number): boolean {
		for (const sv of this.services.values()) for (const c of sv.comps) if (c.tmid === 0 && c.subId === subId) return c.ascty === 63;
		return true;
	}
}
