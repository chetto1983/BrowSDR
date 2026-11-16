// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/marine/marine_dsc.cpp (symbols, number fields, builders) and
// marine_mmsi.cpp (MMSI kinds), https://github.com/adswill/OnAir; see third_party/onair.
// Digital Selective Calling, ITU-R M.493: 10-bit symbols, number fields and the calls built for tests.

const pop7 = (v: number) => {
	let n = 0;
	for (let i = 0; i < 7; i++) n += (v >> i) & 1;
	return n;
};

export const isEos = (s: number) => s === 117 || s === 122 || s === 127;

/** Phasing sequence (M.493 Annex 1 §3): slots 0, 2 .. 10 are DX = 125; odd slots 1..15 carry RX symbols 111 .. 104. */
export function phasingAt(slot: number): number {
	if (slot < 0 || slot > 15) return -2;
	if (slot % 2 === 0) return slot < 12 ? 125 : -2; // slots 12 and 14 are the format specifier
	return 111 - (slot - 1) / 2;
}

/**
 * Bits 1..7 = the symbol number, least significant bit first (Y = 1, B = 0); bits 8..10 = the number of B elements
 * in the seven, most significant bit first. Bit 1 (sent first) is bit 9 of the value.
 */
export function dscSymbolBits(sym: number): number {
	let v = 0;
	for (let i = 0; i < 7; i++) v = (v << 1) | ((sym >> i) & 1);
	return (v << 3) | (7 - pop7(sym & 127));
}

/** The symbol of 10 received bits, or -1 when the check bits do not match. */
export function dscSymbolDecode(bits10: number): number {
	let s = 0;
	for (let i = 0; i < 7; i++) s |= ((bits10 >> (9 - i)) & 1) << i;
	return (bits10 & 7) === 7 - pop7(s) ? s : -1;
}

const FORMATS: Record<number, string> = {
	112: 'Distress alert',
	116: 'All ships',
	114: 'Group call',
	120: 'Individual call',
	102: 'Geographic area call',
	123: 'Individual call (automatic)',
};
const CATEGORIES: Record<number, string> = { 100: 'Routine', 106: "Ship's business", 108: 'Safety', 110: 'Urgency', 112: 'Distress' };
const NATURES: Record<number, string> = {
	100: 'Fire, explosion',
	101: 'Flooding',
	102: 'Collision',
	103: 'Grounding',
	104: 'Listing, danger of capsizing',
	105: 'Sinking',
	106: 'Disabled and adrift',
	107: 'Undesignated distress',
	108: 'Abandoning ship',
	109: 'Piracy, armed robbery',
	110: 'Man overboard',
	112: 'EPIRB emission',
};
const TELECOMMAND_1: Record<number, string> = {
	100: 'F3E/G3E simplex telephony',
	101: 'F3E/G3E duplex telephony',
	103: 'Polling',
	104: 'Unable to comply',
	105: 'End of call',
	106: 'Data',
	109: 'J3E telephony',
	110: 'Distress acknowledgement',
	111: 'H3E telephony',
	112: 'Distress relay',
	113: 'F1B/J2B TTY-FEC',
	115: 'F1B/J2B TTY-ARQ',
	116: 'F1B/J2B TTY receive',
	118: 'Test',
	119: 'F1B/J2B TTY',
	120: 'A1A Morse',
	121: 'Position update',
	123: 'A1A Morse',
	124: 'F1C/F2C/F3C fax',
	126: 'No information',
};
const TELECOMMAND_2: Record<number, string> = {
	100: 'No reason given',
	101: 'Congestion at switching centre',
	102: 'Busy',
	103: 'Queue indication',
	104: 'Station barred',
	105: 'No operator available',
	106: 'Operator temporarily unavailable',
	107: 'Equipment disabled',
	108: 'Unable to use proposed channel',
	109: 'Unable to use proposed mode',
	110: 'Ships and aircraft (Res. 18)',
	111: 'Medical transports',
	112: 'Pay-phone, public call office',
	113: 'Fax or data (M.1081)',
	126: 'No information',
};

export const dscFormatName = (s: number) => FORMATS[s] ?? 'Unknown format';
export const dscCategoryName = (s: number) => CATEGORIES[s] ?? 'Unknown';
export const dscNatureName = (s: number) => NATURES[s] ?? 'Unknown';
export const dscTelecommand1Name = (s: number) => TELECOMMAND_1[s] ?? '';
export const dscTelecommand2Name = (s: number) => TELECOMMAND_2[s] ?? '';

const two = (n: number) => String(n).padStart(2, '0');

/** Nine MMSI digits from five symbols, '~' for a symbol that could not be read, '' when none could (M.493 §5.2). */
export function dscMmsiLenient(s: readonly number[]): string {
	const digits = s
		.slice(0, 5)
		.map((v) => (v < 0 || v > 99 ? '~~' : two(v)))
		.join('')
		.slice(0, 9);
	return /^~+$/.test(digits) ? '' : digits;
}

export function dscMmsiToSymbols(mmsi: string): number[] | null {
	if (!/^\d{9}$/.test(mmsi)) return null;
	const t = mmsi + '0';
	return [0, 1, 2, 3, 4].map((i) => Number(t.slice(2 * i, 2 * i + 2)));
}

/** Position from five symbols (quadrant, latitude, longitude in degrees and minutes); null for all 9s or unreadable. */
export function dscPositionFromSymbols(s: readonly number[]): { lat: number; lon: number; text: string } | null {
	if (s.length < 5 || s.slice(0, 5).some((v) => v < 0 || v > 99)) return null;
	if (s.slice(0, 5).every((v) => v === 99)) return null;
	const d = s.slice(0, 5).map(two).join('');
	const q = Number(d[0]);
	if (q > 3) return null;
	const [latD, latM, lonD, lonM] = [Number(d.slice(1, 3)), Number(d.slice(3, 5)), Number(d.slice(5, 8)), Number(d.slice(8, 10))];
	if (latD > 90 || latM > 59 || lonD > 180 || lonM > 59) return null;
	const [south, west] = [q === 2 || q === 3, q === 1 || q === 3];
	const lat = (latD + latM / 60) * (south ? -1 : 1);
	const lon = (lonD + lonM / 60) * (west ? -1 : 1);
	return {
		lat,
		lon,
		text: `${two(latD)}°${two(latM)}'${south ? 'S' : 'N'} ${String(lonD).padStart(3, '0')}°${two(lonM)}'${west ? 'W' : 'E'}`,
	};
}

export function dscPositionToSymbols(lat: number, lon: number): number[] {
	const [al, ao] = [Math.abs(lat), Math.abs(lon)];
	let [latD, latM] = [Math.trunc(al), Math.round((al - Math.trunc(al)) * 60)];
	let [lonD, lonM] = [Math.trunc(ao), Math.round((ao - Math.trunc(ao)) * 60)];
	if (latM === 60) [latD, latM] = [latD + 1, 0];
	if (lonM === 60) [lonD, lonM] = [lonD + 1, 0];
	const q = (lat < 0 ? 2 : 0) + (lon < 0 ? 1 : 0);
	const d = `${q}${two(latD % 100)}${two(latM)}${String(lonD % 1000).padStart(3, '0')}${two(lonM)}`;
	return [0, 1, 2, 3, 4].map((i) => Number(d.slice(2 * i, 2 * i + 2)));
}

/** UTC time from two symbols; null for 88 88 (no time) or out of range. */
export function dscTimeFromSymbols(a: number, b: number): string | null {
	if (a < 0 || a > 99 || b < 0 || b > 99 || (a === 88 && b === 88) || a > 23 || b > 59) return null;
	return `${two(a)}:${two(b)} UTC`;
}

/** Three symbols in the order sent (M.493-15 Table 13 note 2: character 1 is the last one sent). */
export function dscFrequencyText(s: readonly number[]): string {
	if (s[0] === 126 && s[1] === 126 && s[2] === 126) return '';
	if (s.slice(0, 3).some((v) => v < 0 || v > 99)) return '';
	const [c3, c2, c1] = s;
	const hm = Math.trunc(c3 / 10);
	if (hm === 3) return `MF/HF channel ${(c3 % 10) * 10000 + c2 * 100 + c1}`;
	if (hm === 9) {
		const m = Math.trunc(c2 / 10);
		return `VHF ch ${(c2 % 10) * 100 + c1}${m === 1 ? ' (ship simplex)' : m === 2 ? ' (coast simplex)' : ''}`;
	}
	return `${((c3 * 10000 + c2 * 100 + c1) / 10).toFixed(1)} kHz`;
}

export function dscFrequencyToSymbols(hundredHz: number): number[] {
	if (hundredHz < 0) return [126, 126, 126];
	return [Math.trunc(hundredHz / 10000) % 100, Math.trunc(hundredHz / 100) % 100, hundredHz % 100];
}

/** Kind of station an MMSI names (ITU-R M.585). */
export function mmsiKind(mmsi: string): string {
	if (!/^[\d~]{9}$/.test(mmsi)) return '';
	if (mmsi.startsWith('00')) return 'coast station';
	if (mmsi.startsWith('0')) return 'group';
	if (mmsi.startsWith('111')) return 'SAR aircraft';
	if (mmsi.startsWith('99')) return 'aid to navigation';
	if (mmsi.startsWith('98')) return 'craft of a parent ship';
	if (mmsi.startsWith('970')) return 'AIS-SART';
	if (mmsi.startsWith('972')) return 'man overboard device';
	if (mmsi.startsWith('974')) return 'EPIRB-AIS';
	if (mmsi.startsWith('8')) return 'handheld VHF';
	return /^[2-7]/.test(mmsi) ? 'ship' : '';
}

// ---- builders (test signals)

const mmsiSymbols = (mmsi: string) => dscMmsiToSymbols(mmsi) ?? [126, 126, 126, 126, 126];

function distressBlock(nature: number, lat: number, lon: number, hour: number, minute: number, subsequent: number): number[] {
	const position = Number.isNaN(lat) ? [99, 99, 99, 99, 99] : dscPositionToSymbols(lat, lon);
	return [nature, ...position, ...(hour < 0 ? [88, 88] : [hour, minute]), subsequent];
}

export function dscBuildDistress(
	mmsi: string,
	nature: number,
	lat: number,
	lon: number,
	hour: number,
	minute: number,
	subsequent: number,
): number[] {
	return [112, ...mmsiSymbols(mmsi), ...distressBlock(nature, lat, lon, hour, minute, subsequent)];
}

export function dscBuildIndividual(to: string, category: number, from: string, tc1: number, tc2: number, rx: number, tx: number): number[] {
	return [120, ...mmsiSymbols(to), category, ...mmsiSymbols(from), tc1, tc2, ...dscFrequencyToSymbols(rx), ...dscFrequencyToSymbols(tx)];
}

export function dscBuildAllShips(mmsi: string, category: number, tc1: number, tc2: number, rx: number, tx: number): number[] {
	return [116, category, ...mmsiSymbols(mmsi), tc1, tc2, ...dscFrequencyToSymbols(rx), ...dscFrequencyToSymbols(tx)];
}

/** Even parity over the information symbols. */
export function dscEcc(body: readonly number[], eos: number): number {
	let e = eos & 127;
	for (const s of body) e ^= s & 127;
	return e;
}

/** The symbols of a call in the order of the slots (DX at even places, RX five places later). */
export function dscFrameSymbols(body: readonly number[], eos: number): number[] {
	const dx = [body[0], body[0], ...body.slice(1), eos, dscEcc(body, eos), eos, eos];
	const last = 12 + 2 * (dx.length - 3) + 5; // the last place: the retransmission of the ECC
	const slots = new Array<number>(last + 1).fill(126);
	for (let s = 0; s < 16; s++) if (phasingAt(s) >= 0) slots[s] = phasingAt(s);
	dx.forEach((symbol, i) => {
		slots[12 + 2 * i] = symbol;
		const rx = 12 + 2 * i + 5;
		if (rx <= last && rx >= 16) slots[rx] = symbol;
	});
	return slots;
}

/** The bits of a whole call: dot pattern, phasing, the call with time diversity; 1 = Y. */
export function dscFrameBits(body: readonly number[], eos: number, dotBits: number): number[] {
	const bits: number[] = [];
	for (let i = 0; i < dotBits; i++) bits.push(i % 2 === 0 ? 1 : 0);
	for (const s of dscFrameSymbols(body, eos)) {
		const b = dscSymbolBits(s);
		for (let i = 9; i >= 0; i--) bits.push((b >> i) & 1);
	}
	return bits;
}
