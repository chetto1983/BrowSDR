// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/src/cw/cw_morse.cpp (the code table, decodeSymbol, encodeSymbol,
// tokenize, isCallsign, callsigns), https://github.com/adswill/OnAir; see third_party/onair. Changes: the 0.2.7 timing
// decoder of that file (Timing, Keyer) is not ported: OnAir keeps it for comparison, its default is the adaptive
// decoder of fist.ts.

/** ITU-R M.1677-1, and the prosigns as operators send them (a prosign is shown, not the character sharing its code). */
const TABLE_TEXT =
	'A .- B -... C -.-. D -.. E . F ..-. G --. H .... I .. J .--- K -.- L .-.. M -- N -. O --- P .--. ' +
	'Q --.- R .-. S ... T - U ..- V ...- W .-- X -..- Y -.-- Z --.. 0 ----- 1 .---- 2 ..--- 3 ...-- 4 ....- ' +
	"5 ..... 6 -.... 7 --... 8 ---.. 9 ----. . .-.-.- , --..-- ? ..--.. / -..-. ' .----. ! -.-.-- ) -.--.- " +
	': ---... ; -.-.-. - -....- _ ..--.- " .-..-. $ ...-..- @ .--.-. <AR> .-.-. <SK> ...-.- <BT> -...- ' +
	'<KN> -.--. <AS> .-... <HH> ........ <SOS> ...---... <KA> -.-.- <VE> ...-.';
const WORDS = TABLE_TEXT.split(' ');
/** [code, text] in the order of the table. */
const TABLE = WORDS.flatMap((v, i): Array<[string, string]> => (i % 2 ? [] : [[WORDS[i + 1], v]]));
const BY_CODE = new Map(TABLE.map(([code, text]) => [code, text]));
const BY_TEXT = new Map(TABLE.map(([code, text]) => [text, code]));
const ALIASES: Record<string, string> = { '+': '<AR>', '=': '<BT>', '(': '<KN>', '&': '<AS>' };

/** ".-" -> "A"; prosigns as "<AR>"; undefined when not in the table. */
export const decodeSymbol = (code: string): string | undefined => BY_CODE.get(code);

/** The code of a character or prosign token ("A", "<AR>"); '' when not in the table. */
export function encodeSymbol(tok: string): string {
	const t = tok.toUpperCase();
	return BY_TEXT.get(ALIASES[t] ?? t) ?? '';
}

/** A text cut into tokens: characters, "<XX>" prosigns, and " " for a word space (lower case taken as upper case). */
export function tokenize(text: string): string[] {
	const out: string[] = [];
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === ' ' || c === '\n' || c === '\t') {
			if (out.length && out[out.length - 1] !== ' ') out.push(' ');
			continue;
		}
		const e = c === '<' ? text.indexOf('>', i) : -1;
		if (e >= 0) {
			out.push(text.slice(i, e + 1).toUpperCase());
			i = e;
			continue;
		}
		out.push(c.toUpperCase());
	}
	return out;
}

// prefix (one or two letters, a figure and a letter, or a letter and a figure), one or two figures, a suffix of one
// to four letters; an optional portable / prefix part after a "/"
const CALL = /^(?:[A-Z0-9]{1,4}\/)?(?:[A-Z]{1,2}|[0-9][A-Z]|[A-Z][0-9])[0-9]{1,2}[A-Z]{1,4}(?:\/[A-Z0-9]{1,4})?$/;

/** A word that looks like an amateur callsign: LY2ABC, K1ABC, 9A1AA, DL1XYZ/P. */
export const isCallsign = (word: string): boolean => word.length >= 3 && word.length <= 14 && CALL.test(word);

/** The callsigns in a text, first seen first, each once. */
export function callsigns(text: string): string[] {
	const out: string[] = [];
	for (const w of text.split(' ')) if (w && isCallsign(w) && !out.includes(w)) out.push(w);
	return out;
}
