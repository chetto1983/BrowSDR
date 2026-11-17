// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir core/src/aero/aero_su.cpp (the SU builders: fill-in, log-on,
// system table, satellite id, P/R channel control, ISU / SSU of an ACARS message, aeroBuildBlock),
// core/src/aero/aero_acars.cpp (aeroBuildAcarsBlock, aeroAddOddParity), core/src/aero/aero_adsc.cpp (the ADS-C group
// builders and aeroBuildAdscText) and core/src/aero/aero_cpdlc.cpp (aeroBuildCpdlcText),
// https://github.com/adswill/OnAir; see third_party/onair. Changes: a downlink carries its message number and flight in
// every block, as ARINC 618 sends them (OnAir: in the first block only).

import { aeroArincCrc } from '@/worker/decoders/digimode/aero/arinc';
import { aeroSuSetCrc } from '@/worker/decoders/digimode/aero/phy';
import { aeroBlockBytes, aeroSu, codeOfBitRate } from '@/worker/decoders/digimode/aero/su';
import { acarsCrc } from '@/worker/decoders/digimode/vdl2/acars';

export const field = (record, label) => record.fields?.find(([name]) => name === label)?.[1];

// ---------------------------------------------------------------- SUs

/** An SU of `type` with `bytes` from octet 1 on, its CRC set. */
export function makeSu(type, bytes = []) {
	const b = new Uint8Array(12);
	b[0] = type;
	b.set(bytes.slice(0, 9), 1);
	aeroSuSetCrc(b);
	return aeroSu(b);
}

const aesGes = (aes, ges) => [(aes >> 16) & 0xff, (aes >> 8) & 0xff, aes & 0xff, Math.max(ges, 0)];
export const aeroFillSu = () => makeSu(0x01);
export const aeroLogonSu = (aes, ges, logon) => makeSu(logon ? 0x11 : 0x12, aesGes(aes, ges));
const mhzToChan = (f) => Math.round((f - 1510) / 0.0025);

export function aeroSatelliteIdSu(satId, lonDegEast, psmc1MHz, psmc2MHz = 0, seq = 0) {
	const lon = (((lonDegEast % 360) + 360) % 360) / 1.5;
	const c1 = mhzToChan(psmc1MHz),
		c2 = psmc2MHz > 0 ? mhzToChan(psmc2MHz) : 0;
	return makeSu(0x0c, [
		0,
		((seq & 0x3f) << 2) | ((satId >> 4) & 3),
		(satId & 0x0f) << 4,
		0,
		Math.round(lon) & 0xff,
		(c1 >> 8) & 0x7f,
		c1 & 0xff,
		(c2 >> 8) & 0x7f,
		c2 & 0xff,
	]);
}

export function aeroChannelControlSu(gesId, bitRate, pChannelMHz, spotBeam = false) {
	const c = mhzToChan(pChannelMHz);
	return makeSu(0x40, [0, 0, 0, gesId, 0, 0, (codeOfBitRate(bitRate) & 0x0f) << 4, ((c >> 8) & 0x7f) | (spotBeam ? 0x80 : 0), c & 0xff]);
}

/** part 0..3: GES channels with lsu = part; 4: satellite id; 5: P/R channel control (synthetic frequencies inside the real bands). */
export function aeroSystemTableSu(gesId, part) {
	const p = 1545 + 0.0125 * (gesId & 0x0f);
	if (part === 4) return aeroSatelliteIdSu(gesId & 0x3f, 64.5, p);
	if (part === 5) return aeroChannelControlSu(gesId, 10500, p);
	const lsu = part & 3;
	let ch;
	if (lsu <= 1) ch = [mhzToChan(p), Math.round((1626.5 + 0.05 * lsu - 1611.5) / 0.0025), Math.round((1627 + 0.05 * lsu - 1611.5) / 0.0025)];
	else ch = [0, 1, 2].map((i) => Math.round((1628 + 0.5 * lsu + 0.05 * i - 1611.5) / 0.0025));
	return makeSu(0x05, [0, lsu, gesId, ...ch.flatMap((c) => [c >> 8, c & 0xff])]);
}

/** One block of the rate's size, padded with fill-in SUs. */
export function aeroBuildBlock(sus, bitRate) {
	const n = aeroBlockBytes(bitRate) / 12;
	const out = new Uint8Array(n * 12);
	for (let i = 0; i < n; i++) out.set((sus[i] ?? aeroFillSu()).bytes, i * 12);
	return out;
}

// ---------------------------------------------------------------- ACARS blocks

const oddParity = (c) => {
	let x = c ^ (c >> 4);
	x ^= x >> 2;
	x ^= x >> 1;
	return (x & 1) !== 0;
};
export const aeroAddOddParity = (c) => (oddParity(c & 0x7f) ? c & 0x7f : (c & 0x7f) | 0x80);

/** The user data of one block: FF FF SOH mode reg(7) TAK label block-id [STX text] ETX/ETB BCS DEL. */
export function aeroBuildAcarsBlock({
	mode = '2',
	registration = '',
	tak = 0x15,
	label = 'H1',
	blockId = 0x30,
	text = '',
	hasText = false,
	moreToCome = false,
}) {
	const u = [0xff, 0xff, 0x01];
	const reg = registration.slice(0, 7).padStart(7, '.');
	const lab = label.padEnd(2, ' ');
	const head = [
		mode.charCodeAt(0),
		...[...reg].map((c) => c.charCodeAt(0)),
		tak,
		lab.charCodeAt(0),
		lab === '_d' ? 0x7f : lab.charCodeAt(1),
		blockId || 0x30,
	];
	u.push(...head.map(aeroAddOddParity));
	if (hasText || text) u.push(aeroAddOddParity(0x02), ...[...text.slice(0, 220)].map((c) => aeroAddOddParity(c.charCodeAt(0))));
	u.push(aeroAddOddParity(moreToCome ? 0x17 : 0x03));
	const bcs = acarsCrc(Uint8Array.from(u.slice(3)));
	u.push(bcs & 0xff, bcs >> 8, 0x7f);
	return Uint8Array.from(u);
}

const nextBlockId = (bi) =>
	bi >= 0x30 && bi <= 0x39 ? 0x30 + ((bi - 0x30 + 1) % 10) : bi >= 0x41 && bi <= 0x5a ? 0x41 + ((bi - 0x41 + 1) % 26) : bi + 1;

/** The SUs that carry an ACARS message: per block an ISU head (0x71) with two bytes and SSUs of 8 bytes. */
export function aeroAcarsToSus(m, qno = 0, refno) {
	let ref = refno;
	if (ref === undefined) {
		let h = 2166136261;
		const mix = (c) => (h = Math.imul(h ^ c, 16777619) >>> 0);
		[
			m.aesId & 0xff,
			(m.aesId >> 8) & 0xff,
			(m.aesId >> 16) & 0xff,
			...[...(m.label ?? '')].map((c) => c.charCodeAt(0)),
			...[...m.text].map((c) => c.charCodeAt(0) & 0xff),
		].forEach(mix);
		ref = (h >>> 24) & 0x0f;
	}
	const prefix = m.uplink ? '' : `${(m.msgNo || 'M01A').slice(0, 4).padEnd(4)}${(m.flight ?? '').slice(0, 6).padEnd(6)}`;
	const chunk = 220 - prefix.length;
	let bi = m.blockId ? m.blockId.charCodeAt(0) : m.uplink ? 0x41 : 0x30;
	const out = [];
	let pos = 0,
		blockNo = 0;
	do {
		const n = Math.min(chunk, m.text.length - pos);
		const text = prefix + m.text.slice(pos, pos + n);
		const ud = aeroBuildAcarsBlock({
			mode: m.mode || '2',
			registration: m.registration,
			label: m.label || 'H1',
			blockId: bi,
			moreToCome: pos + n < m.text.length,
			text,
			hasText: !!text,
		});
		const r = (ref + blockNo) & 0x0f;
		const rest = ud.length - 2;
		const nSsu = Math.ceil(rest / 8);
		const lastN = rest - 8 * (nSsu - 1);
		out.push(makeSu(0x71, [...aesGes(m.aesId, m.gesId), ((qno & 0x0f) << 4) | r, nSsu & 0x3f, lastN << 4, ud[0], ud[1]]));
		for (let j = 0; j < nSsu; j++)
			out.push(makeSu(0xc0 | (nSsu - 1 - j), [((qno & 0x0f) << 4) | r, ...ud.slice(2 + 8 * j, 2 + 8 * j + (j + 1 === nSsu ? lastN : 8))]));
		pos += n;
		bi = nextBlockId(bi);
		blockNo++;
	} while (pos < m.text.length);
	return out;
}

// ---------------------------------------------------------------- ADS-C and CPDLC

/** Big-endian bit writer. */
class BitOut {
	constructor(bytes) {
		this.b = new Array(bytes).fill(0);
		this.pos = 0;
	}
	put(v, k) {
		for (let i = k - 1; i >= 0; i--, this.pos++) if (Math.floor(v / 2 ** i) % 2) this.b[this.pos >> 3] |= 0x80 >> (this.pos & 7);
	}
}

const toField = (r, bits) => {
	const lo = -(2 ** (bits - 1)),
		hi = 2 ** (bits - 1) - 1;
	const v = Math.max(lo, Math.min(hi, r));
	return v < 0 ? v + 2 ** bits : v;
};
const fromAngle = (deg, bits, msbDeg) => toField(Math.round(((deg > 180 ? deg - 360 : deg) * 2 ** (bits - 2)) / msbDeg), bits);

export function adscBasicGroup(lat, lon, altFt, secPastHour, accuracy = 6, tag = 7) {
	const o = new BitOut(10);
	o.put(fromAngle(lat, 21, 90), 21);
	o.put(fromAngle(lon, 21, 90), 21);
	o.put(toField(Math.round(altFt / 4), 16), 16);
	o.put(Math.round(secPastHour * 8) & 0x7fff, 15);
	o.put((1 << 4) | ((accuracy & 7) << 1) | 1, 7); // TCAS ok, accuracy, redundancy ok
	return [tag, ...o.b];
}

export function adscFlightIdGroup(id) {
	const o = new BitOut(6);
	for (let k = 0; k < 8; k++) o.put((id[k] ?? ' ').toUpperCase().charCodeAt(0) & 0x3f, 6);
	return [12, ...o.b];
}

export function adscEarthRefGroup(trackDeg, groundKt, vsFpm) {
	const o = new BitOut(5);
	o.put(0, 1);
	o.put(fromAngle(trackDeg, 12, 90), 12);
	o.put(Math.round(groundKt * 2) & 0x1fff, 13);
	o.put(toField(Math.round(vsFpm / 16), 12), 12);
	return [14, ...o.b];
}

export function adscPredictedRouteGroup(a, c) {
	const o = new BitOut(17);
	o.put(fromAngle(a.lat, 21, 90), 21);
	o.put(fromAngle(a.lon, 21, 90), 21);
	o.put(toField(Math.round(a.altFt / 4), 16), 16);
	o.put(Math.max(a.etaSec, 0) & 0x3fff, 14);
	o.put(fromAngle(c.lat, 21, 90), 21);
	o.put(fromAngle(c.lon, 21, 90), 21);
	o.put(toField(Math.round(c.altFt / 4), 16), 16);
	return [13, ...o.b];
}

export function adscMeteoGroup(windKt, windDeg, tempC) {
	const o = new BitOut(4);
	o.put(Math.round(windKt * 2) & 0x1ff, 9);
	o.put(0, 1);
	o.put(fromAngle(windDeg, 9, 90), 9);
	o.put(toField(Math.round(tempC * 4), 12), 12);
	return [16, ...o.b];
}

const hex = (bytes) => bytes.map((v) => v.toString(16).toUpperCase().padStart(2, '0')).join('');

/** "/GGGGGGG.ADS.RRRRRRR" + hex of the groups + CRC. */
export function aeroBuildAdscText(groundAddr, registration, groups) {
	const head = `ADS${registration.slice(0, 7).padStart(7, '.')}`;
	const crc = ~aeroArincCrc([...[...head].map((c) => c.charCodeAt(0)), ...groups]) & 0xffff;
	return `/${groundAddr}.${head}${hex([...groups, crc >> 8, crc & 0xff])}`;
}

/** ARINC 622 text from a PER body: ground address, IMI, registration and the CRC. */
export function aeroBuildCpdlcText(groundAddr, imi, registration, body) {
	const reg = `.${registration.slice(0, 6)}`.padEnd(7, '.');
	const crc = ~aeroArincCrc([...[...imi, ...reg].map((c) => c.charCodeAt(0)), ...body]) & 0xffff;
	return `/${groundAddr}.${imi}${reg}${hex([...body, crc >> 8, crc & 0xff])}`;
}
