// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/cw/cw_lm.cpp (the word list and sentences of amateur-radio
// traffic, the corpus with random callsigns and reports, the smoothed character trigram, lmSymbol, lmLogP,
// lmWordBonus, callShape) and core/include/dect2/cw/cw_lm.h, https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the model is built at the first use as in OnAir; C++ leaves the order of two random draws in one expression
// open, here they are made left to right, so a few of the random corpus lines may differ from a given OnAir build.

import type { CwLanguageModel } from './types';

/** Symbols: 0-25 A-Z, 26-35 0-9, 36 space, 37 other punctuation, 38 <AR>, 39 <SK>, 40 <BT>, 41 <KN>, 42 other prosigns. */
export const LM_SYMS = 43;
export const LM_SPACE = 36;

const WORDS = (
	'CQ DE K KN AR SK BT BK R RR AS TEST QRZ QRL QRM QRN QRO QRP QRQ QRS QRT QRU QRV QRX QSB QSL QSO QSY QTH QTR QRA ' +
	'QSK QRG QSX ABT AGN ANT BCNU BD C CFM CL CPY CUAGN CUL CW DX ES FB FER FM GA GB GD GE GL GM GN GND GUD HI HR HV HW ' +
	'INFO LID MNI MSG N NIL NR NW OB OM OP OT PSE PWR RCVR RIG RPT RST RX SED SIG SRI TEMP TKS TNX TU TX UR VY WX WID ' +
	'WKD XCVR XYL YL 73 88 55 99 ANTENNA BEAM DIPOLE VERTICAL LOOP YAGI WIRE WATTS W FINE GOOD BEST REGARDS THANKS CALL ' +
	'AGAIN NAME AGE HERE SUNNY CLOUDY COLD WARM RAIN SNOW WIND HOT NICE BAND BANDS CONDX COND CONTEST LOG CARD EQSL ' +
	'LOTW POTA SOTA FIELD DAY PORTABLE MOBILE HOME STATION QSO NAME OP PLS PLEASE SORRY COPY COPIED SOLID WEAK STRONG ' +
	'LOUD FADING NOISE NOISY KEY BUG PADDLE PADDLES KEYER SPEED WPM SLOW FAST DOWN UP FREQ FQ KHZ MHZ LISTEN LISTENING ' +
	'CALLING ANSWER WORK WORKED HEARD AGN REPEAT AGAIN NUMBER SERIAL ZONE STATE COUNTY GRID LOC TO THE AND FOR IS IN ON ' +
	'AT OF MY YOUR YOU I A IT BE WE ALL NO YES OK WITH HAVE HAD THIS THAT WILL WAS ARE NOT BUT FROM WELL VERY MUCH MANY ' +
	'NOW NEW OLD SEE NEXT TIME WORLD RADIO AMATEUR HAM HAPPY BIRTHDAY CHRISTMAS EASTER JOHN TOM PETE MIKE HANS BOB ED ' +
	'STEVE PAUL ALEX TONY FRED KARL OLE JAN DAVE MARK LUCA ANDREW JIM BILL JOE DAN GEORGE HARRY TED JACK SAM KEN RON RAY ' +
	'PHIL NICK PAT MARTIN PETER IVAN OLEG BORIS SERGEI JURGEN KLAUS FRANK UWE UDO RALF JEAN PIERRE LUIGI MARCO ANTON ' +
	'ANDRIUS VILNIUS KAUNAS BERLIN LONDON PARIS ROMA WARSAW OSLO RIGA WIEN PRAHA MADRID DUBLIN HELSINKI TALLINN MOSCOW ' +
	'KIEV SOFIA ATHENS LISBON BONN LEEDS TEXAS OHIO MAINE UK USA EU DL OK LY'
).split(' ');

const SENTENCES = [
	'CQ CQ CQ DE LY2ABC LY2ABC LY2ABC K',
	'CQ CQ DE DL1XYZ DL1XYZ PSE K',
	'CQ TEST DL1XYZ TEST',
	'CQ DX CQ DX DE W1AW W1AW K',
	'CQ POTA CQ POTA DE K1ABC K1ABC K',
	'CQ SOTA DE OH2XYZ OH2XYZ K',
	'QRZ DE G4ABC K',
	'QRZ? DE LY2ABC',
	'LY2ABC DE G4ABC K',
	'G4ABC DE LY2ABC UR RST 599 599 <BT> NAME JOHN JOHN <BT> QTH LONDON LONDON <BT> HW? <KN>',
	'LY2ABC DE G4ABC R R TNX FER CALL <BT> UR RST 579 579 <BT> OP ANDRIUS QTH VILNIUS <BT> RIG IC7300 PWR 100 W ANT DIPOLE <BT> WX SUNNY TEMP 20 C <AR>',
	'G4ABC DE LY2ABC GM JOHN ES TNX FER FB QSO <BT> UR RST IS 559 <BT> QTH IS VILNIUS <BT> NAME IS ANDRIUS <BT> HW CPY? <KN>',
	'R R FB JOHN TNX FER INFO <BT> RIG HR IS FT991 PWR 50 W ANT IS VERTICAL <BT> WX HR IS RAIN ES COLD <BT> BTU JOHN <KN>',
	'DL1XYZ DE LY2ABC TU 73 ES GL <SK>',
	'TU 73 <SK>',
	'TNX FER QSO 73 ES CUL <SK>',
	'OK 73 GL DX <SK> E E',
	'5NN TU',
	'TU 5NN 14',
	'599 023 TU',
	'UR 5NN 5NN IN 15 15',
	'QSL TNX',
	'QSL VIA LOTW',
	'PSE QSL VIA BURO',
	'AGN PSE',
	'PSE RPT UR CALL',
	'QRS PSE',
	'QRS PSE OM',
	'QRM QRM PSE AGN',
	'QSB QSB',
	'SRI QRM',
	'SRI NIL',
	'NIL',
	'R R R',
	'R TU',
	'AS AS',
	'<AS> PSE',
	'VVV VVV VVV DE LY2ABC',
	'DE LY2ABC K',
	'K',
	'KN',
	'BK',
	'GM OM ES TNX FER CALL',
	'GA OM',
	'GE OM ES TNX FER CALL',
	'HI HI',
	'FB OM',
	'VY FB',
	'VY 73',
	'BEST 73',
	'73 ES GB',
	'73 DE LY2ABC <SK>',
	'WX HR SUNNY ES WARM TEMP 25 C',
	'WX HR CLOUDY ES COLD',
	'TNX FER NICE QSO ES HPE CUAGN',
	'ANT HR IS 3 EL YAGI AT 12 M',
	'PWR HR 100 W',
	'RIG HR IS K3 ES ANT IS DIPOLE',
	'MY NAME IS ANDRIUS',
	'MY QTH IS VILNIUS',
	'NAME HR IS TOM',
	'QTH HR KAUNAS',
	'AGE 45',
	'AGE 62 YRS',
	'UR RST 599 599 599',
	'UR RST IS 449',
	'RST 559 559 559',
	'PSE QSY 14.025',
	'QRG 7.030',
	'QSY UP 5',
	'QRZ DX',
	'LY2ABC UP 2',
	'LISTENING UP',
	'TEST DL1XYZ',
	'TEST DL1XYZ 5NN 001',
	'DL1XYZ 5NN 015',
	'NR 123',
	'CFM 73',
	'CFM ALL',
	'MNI TNX',
	'TKS FER CALL',
	'TKS ES 73',
	'THANKS FOR THE QSO',
	'THANK YOU AND GOOD LUCK',
	'GOOD LUCK ES 73',
	'HAPPY NEW YEAR ES 73',
	'<BT> HW? <KN>',
	'<BT> QTH <BT>',
	'<AR>',
	'<SK>',
	'<KN>',
	'<BT>',
];

const PREFIXES = (
	'LY DL G M OK SP OH SM ON PA F I EA HB9 OE YL ES UR RA UA JA VK ZL W K N AA WA VE LU PY 9A S5 YU HA OM TF SV LZ YO ' +
	'CT EI GM GW DK DJ DF DG DH SQ SP OZ LA SA OH RW RK UA3 RA3 R3 9K A4 EA8 CN8 3B8'
).split(' ');

function symOfChar(c: string): number {
	if (c >= 'A' && c <= 'Z') return c.charCodeAt(0) - 65;
	if (c >= 'a' && c <= 'z') return c.charCodeAt(0) - 97;
	if (c >= '0' && c <= '9') return 26 + c.charCodeAt(0) - 48;
	return c === ' ' ? LM_SPACE : 37;
}

/** The symbol of a Morse token ("A", "5", "<AR>", "?"). */
export function lmSymbol(t: string): number {
	if (!t) return LM_SPACE;
	if (t.length === 1) return symOfChar(t);
	const prosign = ['<AR>', '<SK>', '<BT>', '<KN>'].indexOf(t);
	return prosign >= 0 ? 38 + prosign : 42;
}

/** OnAir's generator of the corpus' callsigns and reports (a 32-bit linear congruential generator). */
function rng(seed: number): (n: number) => number {
	let st = seed >>> 0;
	return (n) => {
		st = (Math.imul(st, 1664525) + 1013904223) >>> 0;
		return (st >>> 8) % n;
	};
}

/** Callsigns in the usual places, and reports and numbers. */
function randomLines(): string[] {
	const rnd = rng(12345);
	const lines: string[] = [];
	for (let i = 0; i < 700; i++) {
		let c = PREFIXES[rnd(PREFIXES.length)];
		if (c.length === 1 && rnd(2)) c += String.fromCharCode(65 + rnd(26));
		if (!/[0-9]$/.test(c)) c += String(rnd(10));
		const n = 1 + rnd(3) + (rnd(5) === 0 ? 1 : 0);
		for (let k = 0; k < n; k++) c += String.fromCharCode(65 + rnd(26));
		if (rnd(15) === 0) c += '/P';
		const kind = rnd(5);
		if (kind === 0) lines.push(`CQ CQ DE ${c} ${c} K`);
		else if (kind === 1) lines.push(`${c} DE ${c}`);
		else if (kind === 2) lines.push(`TEST ${c}`);
		else if (kind === 3) lines.push(`QRZ DE ${c} <AR>`);
		else lines.push(`R ${c} TU 5NN`);
	}
	for (let i = 0; i < 200; i++) {
		const [a, b, c, d] = [4 + rnd(2), 3 + rnd(7), 5 + rnd(5), rnd(300)];
		lines.push(`UR RST ${a}${b}${c} ${d}`);
	}
	return lines;
}

/** The symbols of a corpus line, between spaces. */
function symbolsOf(line: string): number[] {
	const s = [LM_SPACE, LM_SPACE];
	for (let i = 0; i < line.length; i++) {
		const e = line[i] === '<' ? line.indexOf('>', i) : -1;
		if (e >= 0) {
			s.push(lmSymbol(line.slice(i, e + 1)));
			i = e;
		} else s.push(symOfChar(line[i]));
	}
	s.push(LM_SPACE);
	return s;
}

function build(): CwLanguageModel {
	const corpus: string[] = [];
	for (const s of SENTENCES) corpus.push(s, s, s);
	corpus.push(...WORDS, ...randomLines());
	const N = LM_SYMS;
	const c3 = new Float64Array(N * N * N);
	const c2 = new Float64Array(N * N);
	const c1 = new Float64Array(N);
	const n2 = new Float64Array(N * N);
	const n1 = new Float64Array(N);
	for (const line of corpus) {
		const s = symbolsOf(line);
		for (let i = 2; i < s.length; i++) {
			c3[(s[i - 2] * N + s[i - 1]) * N + s[i]]++;
			n2[s[i - 2] * N + s[i - 1]]++;
			c2[s[i - 1] * N + s[i]]++;
			n1[s[i - 1]]++;
			c1[s[i]]++;
		}
	}
	const tot = c1.reduce((a, v) => a + v, 0);
	const logp = new Float32Array(N * N * N);
	for (let a = 0; a < N; a++)
		for (let b = 0; b < N; b++)
			for (let c = 0; c < N; c++) {
				const p1 = (c1[c] + 0.5) / (tot + 0.5 * N);
				const p2 = n1[b] > 0 ? (c2[b * N + c] + 1.5 * p1) / (n1[b] + 1.5) : p1;
				const p3 = n2[a * N + b] > 0 ? (c3[(a * N + b) * N + c] + 2 * p2) / (n2[a * N + b] + 2) : p2;
				logp[(a * N + b) * N + c] = Math.log(p3);
			}
	return { logp, words: new Set(WORDS) };
}

let model: CwLanguageModel | undefined;
const theModel = () => (model ??= build());

/** Natural log of P(c | c2 c1). */
export const lmLogP = (c2: number, c1: number, c: number): number => theModel().logp[(c2 * LM_SYMS + c1) * LM_SYMS + c];

/**
 * The shape of a callsign: a prefix of one to three characters with a letter, one figure, a suffix of one to four
 * letters, a "/P" style tail.
 */
function callShape(w0: string): boolean {
	let w = w0;
	const sl = w.indexOf('/');
	if (sl >= 0) {
		if (sl < 3 || w.length - sl > 4) return false;
		w = w.slice(0, sl);
	}
	if (w.length < 3 || w.length > 9) return false;
	// the last figure that is followed only by letters (1 - 4)
	let d = -1;
	for (let i = w.length - 1; i >= 0; i--) {
		if (/[0-9]/.test(w[i])) {
			d = i;
			break;
		}
		if (!/[A-Za-z]/.test(w[i])) return false;
	}
	if (d < 1) return false;
	const suf = w.length - 1 - d;
	if (suf < 1 || suf > 4) return false;
	const head = w.slice(0, d);
	return /^[A-Za-z0-9]*$/.test(head) && /[A-Za-z]/.test(head) && d <= 3;
}

/** Log bonus of a finished word (symbols, no space): in the word list, or shaped like a callsign, or a number. */
export function lmWordBonus(syms: Uint8Array, n: number): number {
	if (n <= 0) return 0;
	let w = '';
	let alnum = true;
	let digits = true;
	for (let i = 0; i < n; i++) {
		const s = syms[i];
		if (s < 26) {
			w += String.fromCharCode(65 + s);
			digits = false;
		} else if (s < 36) w += String(s - 26);
		else {
			alnum = digits = false;
			w += '?';
		}
	}
	if (!alnum) return n === 1 ? 0 : -0.5;
	if (theModel().words.has(w)) return n === 1 ? 0.8 : n === 2 ? 1.8 : 3;
	if (digits) return n === 3 ? 1.5 : n <= 3 ? 0.8 : 0;
	if (callShape(w)) return n >= 5 ? 3 : 1.8;
	return -0.6; // a word of nothing known: slightly worse than the same letters made into a known one
}
